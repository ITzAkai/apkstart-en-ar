'use strict';
/**
 * Online updates: get the latest release from the GitHub repo named by `updateRepo` in
 * package.json, download it, verify its SHA-256 against the digest GitHub publishes,
 * and replace the app in place. No `updateRepo` = updates are turned off.
 *
 * Three shapes of install:
 *   - Installer (NSIS): download `ApkStart-x.y.z-Setup.exe` and run it silently (/S);
 *   - Lite (portable zip, runtime downloaded on demand): download
 *     `ApkStart-vX-win64-portable.zip` and copy it over the program folder. The runtime
 *     (%APPDATA%\apkstart\runtime), installed apps and snapshots live in the user's
 *     profile, so replacing program files doesn't touch them;
 *   - Full (portable with a bundled runtime): same as lite, plus resources\runtime.
 *
 * The swap can't happen in this process (the exe is in use), so we generate a PowerShell
 * script and pass it to a separate process via -EncodedCommand: wait for us to exit ->
 * copy files -> relaunch. Base64 instead of a .ps1 file because PowerShell 5.1 reads
 * BOM-less scripts in the ANSI code page and mangles non-ASCII paths.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { downloadMulti, sha256File, discardPartial } = require('./download');
const { ZipFile } = require('./zip');
const { cmpVer } = require('./version');
const { Sources, updateRepo } = require('./sources');
const { t } = require('../i18n');

/** PowerShell single-quoted string: ' inside becomes '' */
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

class Updater {
  /**
   * @param {{currentVersion:string, exePath:string, isPackaged:boolean, dataDir:string,
   *          onProgress?:Function}} o
   */
  constructor(o) {
    this.current = o.currentVersion || '0.0.0';
    this.exePath = o.exePath;
    this.installDir = path.dirname(o.exePath || '');
    this.isPackaged = !!o.isPackaged;
    this.dataDir = o.dataDir;
    this.onProgress = o.onProgress || (() => {});
    this.settings = typeof o.settings === 'function' ? o.settings : () => (o.settings || {});
    // settings() tells sources about the optional mirror prefix
    this.sources = new Sources(this.settings);
    this.latest = null;
  }

  /** Install shape: installer (has an uninstaller) or portable */
  get flavor() {
    try {
      const un = fs.readdirSync(this.installDir).find((n) => /^Uninstall .*\.exe$/i.test(n));
      if (un) return 'setup';
    } catch (_) { /* ignore */ }
    return 'portable';
  }

  get updateDir() {
    return path.join(this.dataDir, 'update');
  }

  /**
   * Check for an update. With no update repo configured this makes no network call.
   * @param {{force?:boolean}} [opts] force=true skips the 10-minute release cache
   *        (a manual "Check for updates" should get fresh results; the silent check at
   *        startup uses the cache)
   */
  async check(opts = {}) {
    if (!updateRepo()) {
      this.latest = {
        disabled: true,
        hasUpdate: false,
        canAutoApply: false,
        current: this.current,
        flavor: this.flavor,
        asset: null,
        message: t('Updates are turned off in this build.'),
      };
      return this.latest;
    }
    const merged = await this.sources.latest({ force: !!opts.force });
    const pick = (re) => merged.assets.find((a) => re.test(String(a.name || '')));
    // Releases carry both the portable package and the runtime pack (ApkStart-runtime-*.zip).
    // The fallback .zip match must skip the runtime pack, or a release without a portable
    // package would get 1.5 GB of runtime unpacked into the program folder.
    const isRuntimePack = (a) => /runtime/i.test(String((a && a.name) || ''));

    const wantSetup = this.flavor === 'setup';
    const asset = wantSetup
      ? (pick(/Setup\.exe$/i) || merged.assets.find((a) => /\.exe$/i.test(a.name) && !isRuntimePack(a)))
      : (pick(/portable.*\.zip$/i) || pick(/win64.*\.zip$/i)
        || merged.assets.find((a) => /\.zip$/i.test(a.name) && !isRuntimePack(a)));
    // Only offer to auto-install what we can verify: an asset without a published SHA-256
    // (e.g. found via the no-API fallback) is left for manual download from the releases page.
    const usable = asset && asset.url && asset.sha256 ? asset : null;

    this.latest = {
      version: merged.version,
      tag: merged.tag,
      name: merged.name,
      notes: merged.notes,
      htmlUrl: merged.htmlUrl,
      publishedAt: merged.publishedAt,
      asset: usable
        ? { name: usable.name, size: usable.size, url: usable.url, sha256: usable.sha256, source: usable.source }
        : null,
      assets: merged.assets,
      sources: merged.sources,
      unreachable: merged.unreachable,
      flavor: this.flavor,
      hasUpdate: cmpVer(merged.tag, this.current) > 0,
      current: this.current,
      canAutoApply: !!usable,
    };
    return this.latest;
  }

  /**
   * Download, verify and stage the payload: portable builds are extracted to
   * update/<ver>/payload, installer builds keep the Setup.exe.
   * @returns {Promise<{mode:'zip'|'setup', payload:string, version:string}>}
   */
  async prepare(info) {
    const it = info || this.latest;
    if (!it || !it.asset || !it.asset.url) {
      throw new Error(t('This version has no package that can be installed automatically. Download it from the releases page.'));
    }
    const want = String(it.asset.sha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(want)) {
      throw new Error(t("This update has no published SHA-256 checksum, so it can't be verified. Download it from the releases page."));
    }
    const dir = path.join(this.updateDir, it.version);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, it.asset.name);
    const total = it.asset.size || 0;
    const conns = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    this.onProgress({ stage: 'download', percent: 1, message: t('Downloading {name}…', { name: it.asset.name }) });
    // Candidates = the GitHub URL + the user's mirror prefix, ranked by a real speed sample.
    const cands = this.sources.candidates(it.asset);
    const ranked = await this.sources.rank(cands, { onProgress: (p) => this.onProgress(p) }).catch(() => cands);
    // downloadMulti pulls chunks from several URLs at once when they serve the same size,
    // and falls back to a single source otherwise.
    await downloadMulti(ranked, file, {
      connections: conns,
      onProgress: (pr) => {
        const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
        const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
        const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
        this.onProgress({
          stage: 'download',
          percent: Math.max(1, Math.min(99, pct)),
          message: t('Downloading {progress}', { progress: `${mb}${sp}` }),
          speed: pr.speed,
        });
      },
    });

    // Nothing gets extracted or run until the bytes match the digest GitHub published.
    this.onProgress({ stage: 'verify', percent: 99, message: t('Verifying the download…') });
    if ((await sha256File(file)) !== want) {
      discardPartial(file);
      throw new Error(t("The downloaded update doesn't match its published SHA-256 checksum, so it was deleted. Try again."));
    }

    if (/\.zip$/i.test(file)) {
      const out = path.join(dir, 'payload');
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      await this._extract(file, out);
      this.onProgress({ stage: 'ready', percent: 100, message: t('Update package extracted') });
      return { mode: 'zip', payload: out, version: it.version };
    }
    this.onProgress({ stage: 'ready', percent: 100, message: t('Installer downloaded') });
    return { mode: 'setup', payload: file, version: it.version };
  }

  async _extract(zipPath, dest) {
    const zf = new ZipFile(zipPath);
    try {
      const names = zf.names().filter((n) => !n.endsWith('/'));
      let i = 0;
      for (const n of names) {
        i += 1;
        const target = path.join(dest, n.replace(/\\/g, '/'));
        if (!target.startsWith(path.resolve(dest))) continue;   // zip-slip guard
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await zf.pipeTo(n, fs.createWriteStream(target));
        if (i % 20 === 0) {
          this.onProgress({
            stage: 'extract',
            percent: Math.min(99, Math.round((i / names.length) * 100)),
            message: t('Extracting {done}/{total}', { done: i, total: names.length }),
          });
        }
      }
    } finally {
      try { zf.close(); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Write and start the "replace + relaunch" script; the caller then quits the app.
   * @param {{mode:'zip'|'setup', payload:string, version:string}} job
   * @param {{waitPid?:number, spawn?:boolean}} [opts] tests can pass another pid / skip spawning
   */
  apply(job, opts = {}) {
    const exe = this.exePath;
    const dir = this.installDir;
    const logFile = path.join(this.updateDir, 'update.log');
    fs.mkdirSync(this.updateDir, { recursive: true });
    const waitPid = opts.waitPid || process.pid;

    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${psq(logFile)}`,
      `function Note($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }`,
      `Note 'updater start'`,
      // Wait for this process to really exit (up to 90 s), or the exe/dlls are still locked
      `try { Wait-Process -Id ${waitPid} -Timeout 90 } catch { }`,
      `Start-Sleep -Milliseconds 700`,
    ];

    if (job.mode === 'zip') {
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$ok = $false`,
        `for ($i = 1; $i -le 12; $i++) {`,
        `  Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force`,
        `  $probe = Join-Path $dst ${psq(path.basename(exe))}`,
        `  if (Test-Path $probe) { $ok = $true; Note "copy pass $i ok"; break }`,
        `  Note "copy pass $i failed, retry"; Start-Sleep -Milliseconds 600`,
        `}`,
        `if (-not $ok) { Note 'copy failed' }`,
        // Files removed in the new version stay behind after the copy, which is harmless;
        // only the extracted payload is cleaned up so it doesn't waste hundreds of MB.
        `Remove-Item -Path $src -Recurse -Force`,
      );
    } else {
      lines.push(
        `Note 'run installer'`,
        `$p = Start-Process -FilePath ${psq(job.payload)} -ArgumentList '/S' -PassThru -Wait`,
        `Note ("installer exit " + $p.ExitCode)`,
        `Start-Sleep -Milliseconds 800`,
      );
    }

    lines.push(
      `if (Test-Path ${psq(exe)}) { Start-Process -FilePath ${psq(exe)}; Note 'relaunched' }`,
      `Note 'updater done'`,
      `Start-Sleep -Milliseconds 400`,
      `Remove-Item -Path ${psq(path.join(this.updateDir, job.version))} -Recurse -Force`,
      // A failed cleanup (folder already gone / locked by antivirus) must not look like a failed update
      `exit 0`,
    );

    const script = lines.join('\r\n');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    if (opts.spawn === false) return script;
    // -EncodedCommand is UTF-16LE base64, so non-ASCII paths in the script survive intact
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Do NOT use detached: some security software / sandbox policies silently block detached
    // console processes, and the update hangs at "Replacing the app and restarting".
    // On Windows a normal child survives its parent's exit, so a plain child + unref works
    // just as well and is more compatible.
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
    ], { stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  }

  /** Releases page of the update repo (for manual download), or null when updates are off */
  static repoUrl() {
    const repo = updateRepo();
    return repo ? `https://github.com/${repo}/releases` : null;
  }
}

module.exports = { Updater, cmpVer };
