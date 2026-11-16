'use strict';
/**
 * Downloader: redirects, resume, progress callbacks, SHA-256 verification.
 * Uses only http/https, so it works in the main process and in plain Node tests.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { t } = require('../i18n');

const UA = 'ApkStart/0.2 (Windows; +https://github.com/apkstart)';

function openStream(url, { method = 'GET', headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error(t('Too many redirects')));
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method,
      timeout: 30000,
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(openStream(next, { method, headers, redirects: redirects + 1 }));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(t('Connection timed out'))); });
    req.end();
  });
}

async function head(url) {
  try {
    const res = await openStream(url, { method: 'HEAD' });
    res.resume();
    return {
      status: res.statusCode,
      size: Number(res.headers['content-length']) || 0,
      type: res.headers['content-type'] || '',
    };
  } catch (e) {
    return { status: 0, size: 0, error: e.message };
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * Remove everything a failed download left behind (partial file + chunk sidecar).
 *
 * Root cause of "it keeps re-downloading": failure paths used to throw without deleting,
 * leaving a half zip + .chunks.json. The next run resumed it with Range; if the server's
 * total size or chunking differed, the bytes didn't line up -> failed again -> left another
 * partial, forever. Resuming is fine only when it is known to work; once a download fails,
 * throw the whole file away and start clean next time.
 */
function discardPartial(dest) {
  for (const p of [dest, `${dest}.chunks.json`, `${dest}.part`]) {
    try { fs.rmSync(p, { force: true }); } catch (_) { /* in use: leave it */ }
  }
}

/**
 * Download to a local file (resumes automatically).
 * @param {string} url
 * @param {string} dest
 * @param {object} opt { onProgress({got,total,percent,speed}), signal, expectSha256, timeoutMs }
 */
async function download(url, dest, opt = {}) {
  const { onProgress = () => {}, signal, expectSha256, retries = 2 } = opt;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let attempt = 0;
  try {
  for (;;) {
    attempt++;
    const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const headers = {};
    if (existing > 0) headers.Range = `bytes=${existing}-`;

    // eslint-disable-next-line no-await-in-loop
    const res = await openStream(url, { headers });

    if (res.statusCode === 416) {
      res.resume();
      // Already fully downloaded
      break;
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      if (attempt <= retries) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      discardPartial(dest);   // out of retries: don't leave a bad file to resume next time
      throw new Error(t('Download failed (HTTP {status}): {url}', { status: res.statusCode, url }));
    }

    const total = res.statusCode === 206
      ? existing + (Number(res.headers['content-length']) || 0)
      : Number(res.headers['content-length']) || 0;

    if (res.statusCode === 200 && existing > 0) {
      // Server doesn't support resume: start over
      fs.rmSync(dest, { force: true });
    }

    try {
      await new Promise((resolve, reject) => {
        const startSize = res.statusCode === 206 ? existing : 0;
        let got = startSize;
        let lastTick = Date.now();
        let lastBytes = got;
        const ws = fs.createWriteStream(dest, { flags: startSize > 0 ? 'a' : 'w' });

        // As with chunked downloads, the promise must always settle. A silent connection
        // (blocked/throttled) neither ends nor errors, so the pipe never finishes and the
        // download hangs with a frozen progress bar and no error.
        const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 30000;
        let settled = false;
        let idle = null;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          if (idle) clearTimeout(idle);
          try { ws.destroy(); } catch (_) { /* ignore */ }
          if (err) reject(err); else resolve();
        };
        const kick = () => {
          if (settled) return;
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            res.destroy();
            finish(new Error(t('Connection stalled (no data for too long)')));
          }, idleMs);
        };
        kick();

        const onAbort = () => { res.destroy(new Error(t('Cancelled'))); };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        res.on('data', (c) => {
          got += c.length;
          kick();
          const now = Date.now();
          if (now - lastTick > 400) {
            const speed = (got - lastBytes) / ((now - lastTick) / 1000);
            lastTick = now;
            lastBytes = got;
            onProgress({
              got, total,
              percent: total ? Math.min(100, (got / total) * 100) : 0,
              speed,
              eta: total && speed > 0 ? Math.max(0, (total - got) / speed) : null,
            });
          }
        });
        res.pipe(ws);
        ws.on('finish', () => finish());
        ws.on('error', (e) => finish(e));
        res.on('error', (e) => finish(e));
        res.on('close', () => { if (!res.complete) finish(new Error(t('Connection interrupted'))); });
      });
    } catch (e) {
      discardPartial(dest);   // interrupted / timed out / write failed: a partial file would only break the next resume
      throw e;
    }

    break;
  }

  // Make sure the progress bar reaches 100%
  const finalSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  onProgress({ got: finalSize, total: finalSize, percent: 100, speed: 0, eta: 0 });

  if (expectSha256) {
    const actual = await sha256File(dest);
    if (actual.toLowerCase() !== expectSha256.toLowerCase()) {
      discardPartial(dest);
      throw new Error(t('Checksum mismatch: expected {expected}…, got {actual}…', { expected: expectSha256.slice(0, 12), actual: actual.slice(0, 12) }));
    }
  }
  return { file: dest, size: fs.statSync(dest).size };
  } catch (e) {
    // openStream rejecting directly (refused / DNS failure / timeout) never reaches the
    // write-stream try/catch, so catch everything here and discard leftovers.
    discardPartial(dest);
    throw e;
  }
}

/**
 * Parallel chunked download (for large files).
 * Some servers throttle a single TCP connection to tens of KB/s; parallel chunks raise
 * real throughput a lot. Only parallel when the target doesn't exist yet; with a partial
 * file it falls back to single-stream resume so no chunk state is lost.
 */
async function downloadParallel(url, dest, opt = {}) {
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 1024 * 1024,
    retries = 3,
  } = opt;

  // Partial file exists -> single-stream resume
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return download(url, dest, opt);
  }

  // Probe Range support
  let total = 0;
  let supportsRange = false;
  try {
    const probe = await openStream(url, { headers: { Range: 'bytes=0-0' } });
    const cr = probe.headers['content-range'];
    if (probe.statusCode === 206 && cr) {
      supportsRange = true;
      total = Number(/\/(\d+)$/.exec(cr)[1]) || 0;
    } else {
      total = Number(probe.headers['content-length']) || 0;
    }
    probe.destroy();
  } catch (_) { /* probe failed: single stream */ }

  if (!supportsRange || !total || total < minChunk * 2) {
    return download(url, dest, opt);
  }

  const n = Math.max(1, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });

  // Pre-size the file so later positioned writes stay in range
  const fd = fs.openSync(dest, 'w');
  fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => {
    const start = i * per;
    const end = Math.min(total - 1, start + per - 1);
    return { start, end, pos: start, done: false, tries: 0 };
  });

  let got = 0;
  let lastTick = Date.now();
  let lastBytes = 0;
  const tick = () => {
    const now = Date.now();
    if (now - lastTick < 400) return;
    const speed = (got - lastBytes) / ((now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got, total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
    });
  };

  const fetchChunk = async (c) => {
    const res = await openStream(url, { headers: { Range: `bytes=${c.pos}-${c.end}` } });
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(t('Chunk request refused (HTTP {status})', { status: res.statusCode }));
    }
    await new Promise((resolve, reject) => {
      // Guard against a promise that never settles: res.destroy(err) sometimes emits only
      // close, not error, and without this a chunk hangs and stalls the whole download.
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (err) reject(err); else resolve();
      };
      let idle = setTimeout(() => { res.destroy(); finish(new Error(t('Connection stalled (no data for too long)'))); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error(t('Connection stalled (no data for too long)'))); }, idleMs);
      };
      res.on('data', (buf) => {
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return finish(e);
        }
        c.pos += buf.length;
        got += buf.length;
        kick();
        tick();
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error(t('Connection interrupted'))));
    });
    return c.pos > c.end;
  };

  try {
    await Promise.all(chunks.map(async (c) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const ok = await fetchChunk(c);
          if (ok) return;
          throw new Error(t('Chunk came back incomplete'));
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) throw new Error(t('Chunk download failed ({start}-{end}): {error}', { start: c.start, end: c.end, error: e.message }));
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 800 * c.tries));
        }
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    discardPartial(dest);   // discard the whole file; no partial left for the next resume
    throw e;
  }
  fs.closeSync(fd);

  const size = fs.statSync(dest).size;
  onProgress({ got: size, total: size, percent: 100, speed: 0, eta: 0 });
  if (size !== total) {
    discardPartial(dest);
    throw new Error(t('Download incomplete: {size}/{total} bytes', { size, total }));
  }
  return { file: dest, size, parallel: n };
}

/** Try sources in order; return on the first success */
async function downloadAny(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    discardPartial(dest);   // clear the previous source's partial file (bytes can't be mixed across sources)
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await download(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
      discardPartial(dest);
    }
  }
  throw new Error(t('All download sources failed:\n{errors}', { errors: errors.join('\n') }));
}

/**
 * Multi-source download: split the file into chunks and pull **different chunks from
 * different sources at once**, adding up their bandwidth.
 *
 * Why: per-connection throttling is common, and mirrors throttle too; with all 8
 * connections on one URL the ceiling is that URL's limit. Splitting them between the
 * origin and a mirror adds the limits together.
 *
 * Only sources that report the same total size are mixed, or the result could be corrupt.
 * If a source fails mid-way its chunks move to the next usable URL (no full restart).
 */
async function downloadMulti(urls, dest, opt = {}) {
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 2 * 1024 * 1024,
    // Retries per chunk. 3 isn't enough when sources stall now and then: one chunk running
    // out of retries throws away a 1.4 GB runtime pack. 6 = two rounds per source.
    // Retries continue from where the chunk stopped (c.pos is kept), no bytes re-fetched.
    retries = 6,
  } = opt;
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;

  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) throw new Error(t('No download URL available'));
  if (list.length === 1) return downloadParallel(list[0], dest, opt);

  // 1) Probe in parallel: total size + Range support
  const probes = await Promise.all(list.map(async (u) => {
    try {
      const res = await openStream(u, { headers: { Range: 'bytes=0-0' } });
      const cr = res.headers['content-range'];
      const total = res.statusCode === 206 && cr ? Number(/\/(\d+)$/.exec(cr)[1]) || 0 : 0;
      res.destroy();
      return { url: u, total, ranged: !!total };
    } catch (_) {
      return { url: u, total: 0, ranged: false };
    }
  }));

  const usable = probes.filter((p) => p.ranged && p.total > 0);
  if (!usable.length) {
    return downloadAnyParallel(list, dest, opt);
  }
  // Only mix sources that report the same total size, or chunks won't fit together.
  // The reference is the **fastest source's size** (usable keeps rank()'s speed order;
  // Promise.all returns results in input order), so a slower source serving a different
  // file never pushes out the fastest one.
  const total = usable[0].total;
  const same = usable.filter((p) => p.total === total);
  if (same.length === 1 || total < minChunk * 2) {
    return downloadParallel(same[0].url, dest, opt);
  }

  // 2) Split into chunks, assign sources round-robin
  const n = Math.max(2, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Chunk-level resume: on a link where a source stalls now and then, a 1.4 GB pack easily
  // has a chunk run out of retries, and a full restart costs the user another 10+ minutes.
  // Finished chunks are recorded in a sidecar file; next time (same path, same chunking)
  // only the missing chunks are fetched.
  const meta = `${dest}.chunks.json`;
  let doneSet = new Set();
  let resume = false;
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (m && m.total === total && m.n === n && fs.existsSync(dest) && fs.statSync(dest).size === total) {
      doneSet = new Set(m.done || []);
      resume = true;
    }
  } catch (_) { /* no sidecar: fresh download */ }

  if (!resume) {
    fs.rmSync(dest, { force: true });
    fs.rmSync(meta, { force: true });
  }
  const fd = resume ? fs.openSync(dest, 'r+') : fs.openSync(dest, 'w');
  if (!resume) fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => ({
    start: i * per,
    end: Math.min(total - 1, i * per + per - 1),
    pos: i * per,
    src: i % same.length,
    tries: 0,
    rotates: 0,   // must be initialized: undefined < 2 is false and rotation would never trigger
  })).filter((c) => !doneSet.has(c.start));

  const saveMeta = () => {
    try {
      fs.writeFileSync(meta, JSON.stringify({ total, n, done: [...doneSet] }));
    } catch (_) { /* sidecar write failure doesn't affect the download */ }
  };

  // On resume, count finished chunks so the percentage doesn't restart from 0
  let got = resume ? [...doneSet].reduce((sum, start) => (
    sum + (Math.min(total - 1, start + per - 1) - start + 1)
  ), 0) : 0;
  let lastTick = Date.now();
  let lastBytes = got;
  const tick = (force) => {
    const now = Date.now();
    if (!force && now - lastTick < 400) return;
    const speed = (got - lastBytes) / Math.max(0.001, (now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got,
      total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
      sources: same.length,
    });
  };

  // Slow-source rotation: a chunk crawling at tens of KB/s makes the whole download "stuck
  // at 95%". After slowAfterMs below slowBps, abort and move to the next source (continuing
  // from the same offset). At most 2 rotations per chunk to avoid bouncing between slow sources.
  const slowAfterMs = Number(opt.slowAfterMs) > 0 ? Number(opt.slowAfterMs) : 45000;
  const slowBps = Number(opt.slowBps) > 0 ? Number(opt.slowBps) : 120 * 1024;

  const fetchChunk = async (c) => {
    const url = same[c.src % same.length].url;
    const res = await openStream(url, { headers: { Range: `bytes=${c.pos}-${c.end}` } });
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(t('Chunk request refused (HTTP {status})', { status: res.statusCode }));
    }
    const startPos = c.pos;
    const startedAt = Date.now();
    // A destroyed connection can still deliver buffered data, which would trigger rotation
    // again and skip sources, so rotate at most once per request.
    let rotated = false;
    await new Promise((resolve, reject) => {
      // Idle watchdog + guaranteed settle: a connection that opens but sends nothing
      // (TCP works, traffic blocked/throttled) would wait 30 s for the socket timeout, and
      // res.destroy(err) may emit only close, so the promise would never reject and a chunk
      // would hang the whole download. So the watchdog calls finish itself.
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (err) reject(err); else resolve();
      };
      let idle = setTimeout(() => { res.destroy(); finish(new Error(t('Connection stalled (no data for too long)'))); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error(t('Connection stalled (no data for too long)'))); }, idleMs);
      };
      res.on('data', (buf) => {
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return finish(e);
        }
        c.pos += buf.length;
        got += buf.length;
        kick();
        tick(false);
        // Unacceptably slow before finishing -> switch source (c.pos has advanced; resume from there)
        const took = Date.now() - startedAt;
        if (!rotated && took > slowAfterMs && (c.rotates || 0) < 2 && c.pos <= c.end) {
          const bps = (c.pos - startPos) / (took / 1000);
          if (bps < slowBps) {
            rotated = true;
            c.rotates = (c.rotates || 0) + 1;
            // Don't advance c.src here: the catch below does it, or one failure would skip two sources
            res.destroy();
            finish(new Error(t('Source too slow ({speed} KB/s), switching source', { speed: (bps / 1024).toFixed(0) })));
          }
        }
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error(t('Connection interrupted'))));
    });
    return c.pos > c.end;
  };

  try {
    await Promise.all(chunks.map(async (c) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          if (await fetchChunk(c)) {
            doneSet.add(c.start);
            saveMeta();
            return;
          }
          throw new Error(t('Chunk came back incomplete'));
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) {
            // Out of retries: the file now mixes chunks from different sources and resuming
            // can't produce correct bytes. Discard the file and sidecar; start clean next time.
            // (Keeping them via saveMeta() used to cause endless re-downloads from bad chunks.)
            discardPartial(dest);
            throw new Error(t('Chunk download failed ({start}-{end}): {error}', { start: c.start, end: c.end, error: e.message }));
          }
          // Try another source: one flaky mirror shouldn't sink the whole download
          c.src += 1;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 600 * c.tries));
        }
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    discardPartial(dest);
    throw e;
  }
  fs.closeSync(fd);
  fs.rmSync(meta, { force: true });

  const size = fs.statSync(dest).size;
  tick(true);
  if (size !== total) {
    discardPartial(dest);
    throw new Error(t('Download incomplete: {size}/{total} bytes', { size, total }));
  }
  return { file: dest, size, parallel: n, sources: same.length, multi: true, resumed: resume };
}

/** Try sources in order (parallel-chunk version); return on the first success */
async function downloadAnyParallel(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    discardPartial(dest);   // clear the previous source's partial file
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await downloadParallel(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
      discardPartial(dest);
    }
  }
  throw new Error(t('All download sources failed:\n{errors}', { errors: errors.join('\n') }));
}

module.exports = {
  download, downloadAny, downloadParallel, downloadAnyParallel, downloadMulti,
  head, sha256File, openStream, discardPartial,
};
