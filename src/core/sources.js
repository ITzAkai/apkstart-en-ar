'use strict';
/**
 * Where app updates (and the optional runtime pack) come from.
 *
 * One source: the GitHub Releases of the repo named by `updateRepo` ("owner/name") in
 * package.json. Empty or missing = updates are turned off in this build.
 *
 * A download URL on GitHub can also be tried through a mirror prefix the user set
 * (settings runtime.mirrorPrefix or the APKSTART_MIRROR env var). Candidates are ranked by
 * actually downloading a small sample from each; results are cached for 30 minutes.
 * Release metadata (including the SHA-256 digests) is always fetched straight from
 * api.github.com, never through a mirror.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { cmpVer } = require('./version');
const { t } = require('../i18n');

/** "owner/name" from package.json, or '' when updates are turned off in this build. */
function updateRepo() {
  let r = '';
  try { r = String(require('../../package.json').updateRepo || '').trim(); } catch (_) { /* no package.json */ }
  return /^[\w.-]+\/[\w.-]+$/.test(r) ? r : '';
}

function githubSource() {
  const repo = updateRepo();
  if (!repo) return null;
  return {
    id: 'github',
    name: 'GitHub',
    api: `https://api.github.com/repos/${repo}`,
    web: `https://github.com/${repo}`,
  };
}

/**
 * Bytes per speed sample. 128 KB mostly measures handshake latency and misjudges
 * high-latency/high-bandwidth sources as slow; 256 KB separates the two.
 */
const SAMPLE_BYTES = 256 * 1024;

function openUrl(url, { timeout = 10000, headers = {}, redirects = 0, followRedirect = true } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error(t('Too many redirects')));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error(t('Invalid URL'))); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'ApkStart/0.3 (Windows)',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && followRedirect) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        openUrl(next, { timeout, headers, redirects: redirects + 1, followRedirect }).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error(t('Connection timed out'))));
    req.on('error', reject);
    req.end();
  });
}

/** Fetch a small JSON document (follows redirects, with timeout and size cap). */
async function getJson(url, timeout = 10000) {
  const res = await openUrl(url, { timeout });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`${new URL(url).host} ${res.statusCode}`);
  }
  const chunks = [];
  let len = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      len += c.length;
      if (len > 4 * 1024 * 1024) { res.destroy(); resolve(); return; }
      chunks.push(c);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Measure speed by actually downloading a small range.
 * @returns {Promise<{url:string, ok:boolean, speed:number, got:number, ms:number, error?:string}>}
 */
function measure(url, { bytes = SAMPLE_BYTES, timeoutMs = 9000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let firstAt = 0;
    let got = 0;
    let settled = false;
    let req = null;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch (_) { /* ignore */ }
      const now = Date.now();
      // Throughput counts only from the first byte: DNS + TLS is a fixed cost that
      // barely matters for a 1.4 GB file and would skew the ranking.
      const span = Math.max(1, now - (firstAt || t0));
      resolve({
        url,
        ok: ok && got > 0,
        got,
        ms: now - t0,
        ttfb: firstAt ? firstAt - t0 : 0,
        speed: ok && got > 0 ? (got / span) * 1000 : 0,
        error,
      });
    };
    const timer = setTimeout(() => done(got > 0), timeoutMs);
    if (timer.unref) timer.unref();

    openUrl(url, {
      timeout: timeoutMs,
      headers: { Range: `bytes=0-${bytes - 1}` },
    }).then((res) => {
      req = res;
      if (res.statusCode >= 400) {
        res.resume();
        clearTimeout(timer);
        done(false, `HTTP ${res.statusCode}`);
        return;
      }
      res.on('data', (c) => {
        if (!firstAt) firstAt = Date.now();
        got += c.length;
        if (got >= bytes) { clearTimeout(timer); done(true); }
      });
      // File smaller than the sample: reaching EOF counts as success
      res.on('end', () => { clearTimeout(timer); done(got > 0); });
      res.on('error', (e) => { clearTimeout(timer); done(false, e.message); });
    }).catch((e) => { clearTimeout(timer); done(false, e.message); });
  });
}

/** Prefix a GitHub asset URL with a mirror. */
function withMirror(url, prefix) {
  if (!prefix || !/^https?:\/\//i.test(prefix)) return '';
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${p}${url}`;
}

/** Mirror prefixes to try: only the one the user set, if any. */
function mirrorList(settings) {
  const r = (settings && settings.runtime) || {};
  const custom = String(r.mirrorPrefix || process.env.APKSTART_MIRROR || '').trim();
  return custom ? [custom] : [];
}

/** "sha256:<hex>" from the GitHub API -> lowercase hex, or ''. */
function sha256Of(digest) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(digest || ''));
  return m ? m[1].toLowerCase() : '';
}

class Sources {
  constructor(settingsFn) {
    this.settings = typeof settingsFn === 'function' ? settingsFn : () => ({});
    this._rankCache = new Map();   // url -> {at, speed, ok}
    this._rankTtl = 30 * 60 * 1000;
    // Release info cache: the anonymous GitHub API allows only 60 calls/hour per IP,
    // and "is there a new version" doesn't need to be fresh to the second.
    this._relCache = { at: 0, value: null };
    this._relTtl = 10 * 60 * 1000;
    // Circuit breaker: after a rate-limit error, skip the source for a while
    this._blocked = new Map();     // sourceId -> until(ms)
    this._blockMs = 15 * 60 * 1000;
  }

  /** null if the source is usable, otherwise a reason to show the user */
  blockedReason(id) {
    const until = this._blocked.get(id) || 0;
    if (until <= Date.now()) return null;
    return t('Skipped for now (will retry in {minutes} min)', { minutes: Math.ceil((until - Date.now()) / 60000) });
  }

  /**
   * Fallback that doesn't use the API: follow the `/releases/latest` redirect to get the tag.
   * The anonymous API is limited to 60 calls/hour per IP, which shared NAT exits (offices,
   * campuses) hit easily; the redirect is served by the CDN and costs no API quota.
   * Asset names then follow the release naming convention:
   *   ApkStart-<tag>-win64-portable.zip / ApkStart-<version>-Setup.exe / ApkStart-runtime-<tag>.zip
   */
  async _releaseTagViaRedirect() {
    const s = githubSource();
    const res = await openUrl(`${s.web}/releases/latest`, { timeout: 9000, followRedirect: false });
    const loc = String(res.headers.location || '');
    try { res.resume(); } catch (_) { /* ignore */ }
    const m = /\/releases\/tag\/([^/?#]+)/i.exec(loc);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /**
   * Minimal release built from a tag (when the API is unavailable). It carries no
   * digests, so it can report a new version but never auto-install one.
   */
  _syntheticRelease(tag) {
    const s = githubSource();
    const ver = String(tag).replace(/^v/i, '');
    const names = [
      `ApkStart-${tag}-win64-portable.zip`,
      `ApkStart-${ver}-Setup.exe`,
      `ApkStart-runtime-${tag}.zip`,
    ];
    const assets = names.map((n) => ({
      name: n,
      size: 0,
      browser_download_url: `${s.web}/releases/download/${tag}/${n}`,
    }));
    return {
      tag_name: tag,
      name: tag,
      body: '',
      html_url: `${s.web}/releases/tag/${tag}`,
      published_at: '',
      assets,
      synthetic: true,
    };
  }

  /** Latest release per source (an array so tests can swap in fake sources). [] = updates off. */
  async fetchReleases() {
    const s = githubSource();
    if (!s) return [];
    const base = { source: s.id, name: s.name, web: s.web };
    const skip = this.blockedReason(s.id);
    if (skip) return [{ ...base, error: skip }];
    try {
      return [{ ...base, rel: await getJson(`${s.api}/releases/latest`, 9000) }];
    } catch (e) {
      // No release marked "latest": take the first non-draft from the list
      try {
        const list = await getJson(`${s.api}/releases?per_page=10`, 9000);
        const first = (Array.isArray(list) ? list : []).find((r) => r && !r.draft);
        if (first) return [{ ...base, rel: first }];
      } catch (_) { /* try the redirect fallback */ }
      // API rate-limited or unreachable: tag from the web redirect, asset names by convention
      try {
        const tag = await this._releaseTagViaRedirect();
        if (tag) return [{ ...base, rel: this._syntheticRelease(tag), degraded: true }];
      } catch (_) { /* fallback failed too */ }
      const limited = /\b(403|429)\b/.test(e.message);
      if (limited) this._blocked.set(s.id, Date.now() + this._blockMs);
      const error = limited ? t('{error} (rate-limited, paused for a while)', { error: e.message }) : e.message;
      return [{ ...base, error }];
    }
  }

  /** Latest version and its installable assets. Throws if updates are off or unreachable. */
  async latest({ force = false } = {}) {
    const cached = this._relCache;
    if (!force && cached.value && Date.now() - cached.at < this._relTtl) {
      return cached.value;
    }
    const all = await this.fetchReleases();
    if (!all.length) throw new Error(t('Updates are turned off in this build.'));
    // Record rate limits here too, so any provider of results trips the breaker
    for (const x of all) {
      if (x && x.error && /\b(403|429)\b/.test(x.error)) {
        this._blocked.set(x.source, Date.now() + this._blockMs);
      }
    }
    const ok = all.filter((x) => x && x.rel);
    if (!ok.length) {
      const why = all.map((x) => `${x.name || x.source}: ${x.error || t('no data')}`).join('; ');
      // Everything failed but we have an older result: show that rather than an error,
      // so the user still sees the current version and a link to the releases page.
      if (cached.value) return { ...cached.value, stale: true, staleReason: why };
      throw new Error(t("Can't reach the update server ({reason})", { reason: why }));
    }
    const tagOf = (rel) => String(rel.tag_name || rel.name || '');
    ok.sort((a, b) => cmpVer(tagOf(b.rel), tagOf(a.rel)));
    const top = ok[0];
    const tag = tagOf(top.rel);
    const version = tag.replace(/^v/i, '');

    // Only assets of the newest version count. Our release assets all start with
    // "ApkStart"; anything else (e.g. auto-attached source archives) is ignored.
    const assets = [];
    for (const item of ok) {
      if (tagOf(item.rel).replace(/^v/i, '') !== version) continue;
      for (const a of (item.rel.assets || [])) {
        const name = String(a.name || '');
        if (!/^ApkStart/i.test(name) || assets.some((x) => x.name === name)) continue;
        assets.push({
          name,
          size: Number(a.size) || 0,
          url: a.browser_download_url || a.url || '',
          sha256: sha256Of(a.digest),
          source: item.source,
        });
      }
    }

    const result = {
      version,
      tag,
      name: top.rel.name || tag,
      notes: top.rel.body || '',
      htmlUrl: top.rel.html_url || top.web,
      publishedAt: top.rel.published_at || top.rel.created_at || '',
      assets,
      sources: ok.map((x) => ({ source: x.source, name: x.name, tag: tagOf(x.rel) })),
      unreachable: all.filter((x) => x && x.error).map((x) => ({ source: x.source, name: x.name, error: x.error })),
      bySource: top.source,
    };
    this._relCache = { at: Date.now(), value: result };
    return result;
  }

  /**
   * Candidate URLs for an asset (a URL string or an object with `url`): the URL itself,
   * then the user's mirror prefix. Mirrors only proxy GitHub, so other hosts get none.
   */
  candidates(assetOrUrl) {
    const url = typeof assetOrUrl === 'string' ? assetOrUrl : (assetOrUrl && assetOrUrl.url);
    if (!url) return [];
    const out = [url];
    let host = '';
    try { host = new URL(url).host.toLowerCase(); } catch (_) { return out; }
    if (!/(^|\.)github(usercontent)?\.com$/.test(host)) return out;
    for (const m of mirrorList(this.settings())) {
      const u = withMirror(url, m);
      if (u && !out.includes(u)) out.push(u);
    }
    return out;
  }

  /**
   * Sort candidate URLs by measured speed (cached 30 minutes).
   * If every probe fails, the original order is kept so the download can still try.
   */
  async rank(urls, { onProgress } = {}) {
    const list = (urls || []).filter(Boolean);
    if (list.length <= 1) return list;
    const now = Date.now();
    const need = [];
    for (const u of list) {
      const c = this._rankCache.get(u);
      if (!c || now - c.at > this._rankTtl) need.push(u);
    }
    if (need.length) {
      onProgress?.({ stage: 'probe', message: t('Testing speed of {count} download sources…', { count: need.length }) });
      // Sequential, not parallel: parallel probes fight for bandwidth and rank who grabs
      // hardest, not who is fastest. Give up on a source after 6 s; a failed probe only
      // moves it to the end.
      let i = 0;
      for (const u of need) {
        i += 1;
        let host = u;
        try { host = new URL(u).host; } catch (_) { /* show the raw value */ }
        onProgress?.({ stage: 'probe', message: t('Testing source {index}/{count}: {host}…', { index: i, count: need.length, host }) });
        // eslint-disable-next-line no-await-in-loop
        const r = await measure(u, { timeoutMs: 6000 });
        this._rankCache.set(u, { at: Date.now(), ok: r.ok, speed: r.speed });
      }
    }
    const score = (u) => {
      const c = this._rankCache.get(u);
      return c && c.ok ? c.speed : -1;
    };
    const sorted = list.slice().sort((a, b) => score(b) - score(a));
    const best = sorted[0];
    const s = score(best);
    if (s > 0) {
      onProgress?.({
        stage: 'probe',
        message: t('Using the fastest source: {host} (about {speed} MB/s)', { host: new URL(best).host, speed: (s / 1048576).toFixed(2) }),
      });
    }
    return sorted;
  }

  /** Clear caches (after the user changes the mirror prefix or network) */
  reset() {
    this._rankCache.clear();
    this._relCache = { at: 0, value: null };
    this._blocked.clear();
  }
}

module.exports = { Sources, updateRepo, measure, withMirror, mirrorList };
