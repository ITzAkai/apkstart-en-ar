'use strict';
/**
 * adb client wrapper.
 * Only what ApkStart needs: install / launch / stop / uninstall / file sync / screenshot.
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { t } = require('../i18n');

const COMMON_ADB_PATHS = [
  path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  'C:\\Android\\platform-tools\\adb.exe',
  'C:\\adb\\adb.exe',
  'C:\\LDPlayer\\LDPlayer9\\adb.exe',
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0\\shell\\adb.exe',
  'C:\\Program Files\\BlueStacks_nxt\\HD-Adb.exe',
];

/**
 * Turn a raw pm install failure into an explanation users can understand.
 * The original error code is kept at the end so it can be searched.
 */
function friendlyInstallError(raw) {
  const code = /INSTALL_[A-Z_]+/.exec(raw);
  const tag = code ? code[0] : '';
  const table = {
    INSTALL_FAILED_NO_MATCHING_ABIS:
      t('Install failed: this app only ships ARM native libraries, and the current system image has no ARM translation layer. ApkStart will switch to the compatibility image (with a newer built-in translation layer) and retry.'),
    INSTALL_FAILED_OLDER_SDK:
      t('Install failed: the app needs a newer Android version than the current runtime (a newer system image is required).'),
    INSTALL_PARSE_FAILED_NO_CERTIFICATES:
      t('Install failed: the APK has no valid signature.'),
    INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES:
      t('Install failed: the signature does not match the installed version. Uninstall the old version first.'),
    INSTALL_FAILED_VERSION_DOWNGRADE:
      t('Install failed: a newer version is already installed and cannot be downgraded.'),
    INSTALL_FAILED_INSUFFICIENT_STORAGE:
      t('Install failed: the runtime is out of disk space. Free up space and try again.'),
    INSTALL_FAILED_INVALID_APK:
      t('Install failed: the APK is damaged or incomplete (the download may not have finished). Get it again.'),
    INSTALL_FAILED_INVALID_URI: t('Install failed: the APK path contains special characters. Move the file to an English-only path and try again.'),
    INSTALL_FAILED_ALREADY_EXISTS: t('Install failed: an app with the same name but a different signature already exists. Uninstall it first.'),
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: t('Install failed: the signature does not match the installed version. Uninstall the old version first.'),
    INSTALL_FAILED_DEPRECATED_SDK_VERSION:
      t('Install failed: this app targets a very old Android version (targetSdk too low), which Android 14 blocks by default. ApkStart will retry automatically with the official bypass flag.'),
    INSTALL_FAILED_TEST_ONLY: t('Install failed: this is a test-only package. Retrying automatically with the test-package flag.'),
    INSTALL_FAILED_MISSING_SHARED_LIBRARY: t('Install failed: the app depends on a device feature (such as a vendor library) that the current runtime does not have.'),
    INSTALL_FAILED_USER_RESTRICTION: t('Install failed: the system blocked the installation. Restart the runtime and try again.'),
    INSTALL_FAILED_CONFLICTING_PROVIDER: t('Install failed: it conflicts with the ContentProvider of an installed app. Uninstall the conflicting app.'),
    INSTALL_FAILED_INTERNAL_ERROR: t('Install failed: internal system error (often low storage or Android not fully booted). Restart the runtime and try again.'),
  };
  const msg = table[tag];
  return msg ? `${msg} (${tag})` : t('Install failed: {reason}', { reason: raw });
}

/** Turn a post-launch crash log into a reason users can understand */
function friendlyLaunchError(raw, pkg) {
  const text = String(raw || '');
  const app = pkg || t('The app');
  if (/DoBadTrampoline|libndk_translation|houdini|SIGABRT.*arm/i.test(text)) {
    return t('{app} crashed after launch: the ARM translation layer is incompatible with how this app handles signals. ApkStart will switch to the Android 14 compatibility image and retry.', { app });
  }
  if (/UnsatisfiedLinkError|dlopen failed|couldn't find "lib|\.so.*not found/i.test(text)) {
    return t('{app} crashed after launch: a native library is missing (the app may only ship ARM builds). Switching automatically to the compatibility image with an ARM translation layer and retrying.', { app });
  }
  if (/ClassNotFoundException|NoClassDefFoundError|AndroidRuntime/i.test(text)) {
    return t('{app} crashed on launch (an internal app exception, possibly related to the emulator environment or missing Google services).', { app });
  }
  if (/java\.lang\.SecurityException|Permission Denial/i.test(text)) {
    return t('{app} failed to start: the system rejected the launch request (a permission or signature problem).', { app });
  }
  return text
    ? t('{app} failed to start: {detail}', { app, detail: text.slice(0, 240) })
    : t('{app} failed to start (the process did not stay alive)', { app });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolved launch entries (adbPath|pkg -> activity), valid for 10 minutes */
const LAUNCHER_CACHE = new Map();

/**
 * Windows adb handles non-ASCII paths poorly (non-English user names / download folders are common).
 * Copy the APK into a pure-ASCII temp folder before installing, delete it afterwards.
 */
function stageApk(apkPath) {
  const p = String(apkPath || '');
  if (/^[\x20-\x7e]*$/.test(p) && p.length < 200) return { path: p, staged: false };
  const dir = path.join(os.tmpdir(), 'apkstart-install');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.createHash('sha1').update(p).digest('hex').slice(0, 12)}.apk`;
  const target = path.join(dir, name);
  fs.copyFileSync(p, target);
  return { path: target, staged: true };
}

function unstage(staged) {
  if (!staged) return;
  try { fs.rmSync(staged, { force: true }); } catch (_) { /* ignore */ }
}

/**
 * Build the full component that `am start -n` needs from an "activity".
 * Both forms must work:
 *   - bare class name (what old apps.json stored): `MainActivity` / `.MainActivity` -> `<pkg>/<activity>`
 *   - full component (output of `cmd package resolve-activity`): `com.a.b/.Main` -> used as is
 * The old code always built `${pkg}/${activity}`, turning a full component into `pkg/pkg/class`;
 * am start then cancelled (result code=-92) and the user only saw the Android home screen.
 */
function componentArg(pkg, activity) {
  const a = String(activity || '').trim();
  if (!a) return '';
  if (a.includes('/')) return a;
  return `${pkg}/${a}`;
}

/** Pick pkg's component out of `cmd package resolve-activity --brief` output (tolerates trailing blank / priority lines) */
function parseResolvedActivity(pkg, out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^([\w.]+)\/([.\w$]+)$/.exec(lines[i]);
    if (m && m[1] === pkg) return `${m[1]}/${m[2]}`;
  }
  return '';
}

/**
 * The adb install timeout used to be a fixed 240 s, but 2 GB+ packages on a slow disk easily
 * take more than 4 minutes for push + install + dexopt; a timeout counted as a failed install
 * ("big packages do nothing / fail"). Scale with package size, capped at 20 minutes.
 */
function installTimeoutMs(bytes) {
  const mb = Math.max(1, Number(bytes || 0) / 1048576);
  return Math.min(1200000, Math.max(240000, Math.round(60000 + mb * 120)));
}

class AdbError extends Error {
  constructor(message, stderr, code) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * Parse the output of `find -exec stat -c '%Y|%s|%n'`.
 * Returns null when the output doesn't look like stat output (device lacks support).
 */
function parseStatList(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const rows = [];
  for (const l of lines) {
    const m = /^(\d{9,})\|(\d+)\|(.+)$/.exec(l);
    if (!m) continue;
    const rel = m[3].replace(/^\.\//, '');
    if (!rel || rel.endsWith('/')) continue;
    rows.push({ rel, size: Number(m[2]), mtime: Number(m[1]) * 1000 });
  }
  // Output present but not a single line parsed -> not stat format
  if (!rows.length) return null;
  return rows;
}

class AdbClient {
  constructor({ adbPath, serial }) {
    this.adbPath = adbPath || 'adb';
    this.serial = serial || '';
    this._input = null;        // resident `adb shell` process
    this._inputSeq = 0;
    this._waiters = new Map(); // id -> { resolve, reject, timer, token }
  }

  static resolveAdb(explicit, appRoot) {
    const candidates = [
      explicit,
      appRoot && path.join(appRoot, 'tools', 'platform-tools', 'adb.exe'),
      ...COMMON_ADB_PATHS,
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
    }
    return 'adb'; // leave it to PATH
  }

  _args(args, withSerial = true) {
    const a = [];
    if (withSerial && this.serial) a.push('-s', this.serial);
    return a.concat(args);
  }

  _adbEnv() {
    return { ...process.env, ANDROID_ADB_SERVER_PORT: process.env.ANDROID_ADB_SERVER_PORT || '5044' };
  }

  exec(args, { timeout = 30000, withSerial = true, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const finalArgs = this._args(args, withSerial);
      execFile(this.adbPath, finalArgs, {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        encoding: binary ? 'buffer' : 'utf8',
        windowsHide: true,
        // Share a dedicated adb server port (default 5044) with the runtime emulator, isolated
        // from WSA / third-party emulator adb on 5037, so registration isn't kicked and the device doesn't go offline
        env: this._adbEnv(),
      }, (err, stdout, stderr) => {
        if (err) {
          // adb install writes the failure reason to stdout with a non-zero exit code;
          // the old code only read stderr, so users only ever saw a vague "failed".
          const text = [stdout, stderr, err.message].filter(Boolean).join('\n').trim();
          const e = new AdbError(t('adb {command} failed: {output}', { command: finalArgs.join(' '), output: text }), stderr, err.code);
          e.stdout = stdout;
          e.raw = text;
          return reject(e);
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async shell(cmd, opts = {}) {
    const { stdout } = await this.exec(['shell', cmd], opts);
    return typeof stdout === 'string' ? stdout.trim() : stdout;
  }

  /**
   * Resident input channel.
   * Wheel / back are high-frequency inputs: an execFile per wheel notch spawns a pile of adb
   * processes and the desktop stutters. Reuse one `adb shell`, one command per line, each
   * followed by an echoed end marker - we know when the command really finished, and it
   * naturally applies back-pressure so swipes don't queue up in the shell.
   */
  _inputSession() {
    const old = this._input;
    if (old && old.exitCode === null && !old.killed && old.stdin && old.stdin.writable) return old;
    if (old) this.disposeInput();

    const p = spawn(this.adbPath, this._args(['shell'], true), {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this._adbEnv(),
    });
    this._input = p;
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        for (const [id, w] of this._waiters) {
          // The whole line must equal the marker: some shells echo the command line back,
          // and a contains-check would mistake "just written" for "done", piling up swipes.
          if (line === w.token) {
            this._waiters.delete(id);
            clearTimeout(w.timer);
            w.resolve(true);
            break;
          }
        }
      }
    });
    p.stderr.on('data', () => { /* ignored: device offline etc. is handled by the caller */ });
    p.stdin.on('error', () => { /* on disconnect, exit handles cleanup */ });
    p.on('error', () => { this._failWaiters(new Error('adb shell failed to start')); });
    p.on('exit', () => {
      if (this._input === p) this._input = null;
      this._failWaiters(new Error('adb shell exited'));
    });
    return p;
  }

  _failWaiters(err) {
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this._waiters.clear();
  }

  /** Run one allow-listed input command; on failure the session is recycled and the caller can fall back to one-shot adb */
  async input(cmd, { timeout = 4000 } = {}) {
    const { isInputCommand } = require('./pointer');
    if (!isInputCommand(cmd)) throw new Error('Invalid input command');
    const p = this._inputSession();
    const id = ++this._inputSeq;
    const token = `__APKSTART_${id}__`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(id);
        this.disposeInput();
        reject(new Error('input command timed out'));
      }, timeout);
      this._waiters.set(id, { resolve, reject, timer, token });
      try {
        p.stdin.write(`${cmd}; echo ${token}\n`);
      } catch (e) {
        this._waiters.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  disposeInput() {
    const p = this._input;
    this._input = null;
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('Input channel closed'));
    }
    this._waiters.clear();
    if (p) {
      try { p.stdin.end(); } catch (_) { /* ignore */ }
      try { p.kill(); } catch (_) { /* ignore */ }
    }
  }

  async version() {
    const { stdout } = await this.exec(['version'], { withSerial: false });
    const m = /version\s+([\d.]+)/i.exec(stdout);
    return m ? m[1] : stdout.trim();
  }

  async connect() {
    if (!this.serial.includes(':')) return true;
    try {
      await this.exec(['connect', this.serial], { withSerial: false, timeout: 15000 });
    } catch (_) { /* may already be connected */ }
    return this.isOnline();
  }

  async isOnline() {
    try {
      const { stdout } = await this.exec(['get-state'], { timeout: 8000 });
      return stdout.trim() === 'device';
    } catch (_) {
      // get-state doesn't work without a serial; fall back to the devices list
      try {
        const { stdout } = await this.exec(['devices'], { withSerial: false, timeout: 8000 });
        return stdout.split('\n').some((l) => l.startsWith(this.serial) && l.includes('device'));
      } catch (_) {
        return false;
      }
    }
  }

  async devices() {
    const { stdout } = await this.exec(['devices', '-l'], { withSerial: false });
    return stdout.split('\n').slice(1)
      .map((l) => l.trim())
      .filter((l) => l && l.includes('device') && !l.startsWith('*'))
      .map((l) => {
        const parts = l.split(/\s+/);
        return { serial: parts[0], state: parts[1], model: (l.match(/model:(\S+)/) || [])[1] || '' };
      })
      .filter((d) => d.state === 'device');
  }

  /**
   * Install a single APK with automatic fallbacks:
   *  - drops -g when needed (granting all permissions crashes PermissionController on some images);
   *  - passes --bypass-low-target-sdk-block so Android 14 accepts apps with an old targetSdk;
   *  - retries with another form when adb doesn't know a flag / non-ASCII path / transport error;
   *  - NO_MATCHING_ABIS throws an error with a code so the caller can switch to the compatibility image.
   */
  async install(apkPath) {
    if (!fs.existsSync(apkPath)) throw new Error(t('APK not found: {path}', { path: apkPath }));
    const staged = stageApk(apkPath);
    const file = staged.path;
    const variants = [
      // -g grants runtime permissions up front, skipping in-app permission prompts; dropped if the image rejects it
      ['install', '-r', '-t', '-g', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', file],
      ['install', '-r', file],
    ];
    let last = '';
    let timeout = 240000;
    try { timeout = installTimeoutMs(fs.statSync(file).size); } catch (_) { /* size unknown: use the default */ }
    try {
      for (const args of variants) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(args, { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) {
            throw new Error(String(stdout).trim());
          }
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          last = raw;
          const tag = (/INSTALL_[A-Z_]+/.exec(raw) || [])[0] || '';

          if (tag === 'INSTALL_FAILED_NO_MATCHING_ABIS') {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            err.raw = raw;
            throw err;
          }
          // Old adb doesn't know the new flags / test-package flag -> try another form
          if (/Unknown option|unrecognized option|Unknown command/i.test(raw)) continue;
          if (tag === 'INSTALL_FAILED_TEST_ONLY' || tag === 'INSTALL_FAILED_DEPRECATED_SDK_VERSION') continue;
          // Transport errors (device dropped, adb server restarted): retry once
          if (/device (not found|offline)|closed|protocol fault|no devices/i.test(raw)) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(1500);
            continue;
          }
          if (tag) {
            const err = new Error(friendlyInstallError(raw));
            err.code = tag;
            err.raw = raw;
            throw err;
          }
          // No clear error code: try the last form
        }
      }
      const err = new Error(friendlyInstallError(last || t('no clear reason was reported')));
      err.code = (/INSTALL_[A-Z_]+/.exec(last) || [])[0] || 'INSTALL_UNKNOWN';
      err.raw = last;
      throw err;
    } finally {
      unstage(staged.staged ? file : null);
    }
  }

  /** Split APKs (the parts unpacked from .apks / .xapk) go through install-multiple */
  async installMultiple(apkPaths) {
    if (!apkPaths || !apkPaths.length) throw new Error(t('No split APKs to install'));
    const staged = apkPaths.map((p) => stageApk(p));
    const files = staged.map((s) => s.path);
    const totalBytes = staged.reduce((n, s) => n + (fs.existsSync(s.path) ? fs.statSync(s.path).size : 0), 0);
    const timeout = installTimeoutMs(totalBytes);
    try {
      for (const extra of [['-r', '-t', '--bypass-low-target-sdk-block'], ['-r', '-t']]) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(['install-multiple', ...extra, ...files], { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) throw new Error(stdout);
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          if (/Unknown option|unrecognized option/i.test(raw)) continue;
          if (/INSTALL_FAILED_NO_MATCHING_ABIS/.test(raw)) {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            throw err;
          }
          throw new Error(friendlyInstallError(raw));
        }
      }
      throw new Error(t('Split APK install failed'));
    } finally {
      staged.forEach((s) => unstage(s.staged ? s.path : null));
    }
  }

  async uninstall(pkg) {
    try {
      await this.exec(['uninstall', pkg], { timeout: 60000 });
    } catch (e) {
      // Some devices need an explicit user
      await this.exec(['shell', 'pm', 'uninstall', '--user', '0', pkg], { timeout: 60000 });
    }
  }

  async isInstalled(pkg) {
    const out = await this.shell(`pm path ${pkg}`);
    return /package:/.test(out);
  }

  async listPackages() {
    const out = await this.shell('pm list packages -3');
    return out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
  }

  /** The launch entry may change after an app update; drop the package from the cache before resolving */
  clearLauncherCache(pkg) {
    if (!pkg) { LAUNCHER_CACHE.clear(); return; }
    LAUNCHER_CACHE.delete(`${this.adbPath}|${pkg}`);
  }

  /** Ask the system for the real launch Activity (fallback when the manifest can't tell us) */
  async resolveLauncher(pkg) {
    // Resolving the entry costs one adb round trip (~200-400 ms) and doesn't change within a
    // session. Cache it so the second click on the same app skips it; it expires after
    // 10 minutes, so a reinstalled app won't use a stale entry.
    const key = `${this.adbPath}|${pkg}`;
    const hit = LAUNCHER_CACHE.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    try {
      const out = await this.shell(
        `cmd package resolve-activity --brief ${pkg}`, { timeout: 10000 },
      );
      const comp = parseResolvedActivity(pkg, out);
      if (comp) {
        LAUNCHER_CACHE.set(key, { value: comp, at: Date.now() });
        return comp;
      }
    } catch (_) { /* fall through to monkey */ }
    return null;
  }

  /** Is the app really alive: am start succeeding does not mean the process didn't crash */
  async waitAppAlive(pkg, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      const pid = await this.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
      if (String(pid).trim()) return { ok: true };
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    let crash = '';
    try {
      crash = await this.shell(
        `logcat -d -t 250 -v brief AndroidRuntime:E DEBUG:E libc:E 2>/dev/null | `
        + `grep -i -E '${pkg}|FATAL|ndk_translation|SIGABRT|SIGSEGV|UnsatisfiedLink' | tail -n 30`,
        { timeout: 12000 },
      );
    } catch (_) { /* ignore */ }
    const text = String(crash || '').trim();
    // Without a crash log we can't claim failure: some large apps take 20-40 s on first launch
    return { ok: false, crash: text, uncertain: !text };
  }

  /**
   * Launch the app with three fallback levels:
   *   freeform window -> normal fullscreen -> monkey;
   * each verifies the process is alive; on a crash, logcat is captured and an error with a
   * code is thrown so the caller can switch images.
   */
  async startApp(pkg, activity, { freeform = true, bounds = null, forceStop = false } = {}) {
    if (forceStop) await this.forceStop(pkg);
    // Must use the system-resolved LAUNCHER entry, not just the main Activity parsed from the APK:
    // many apps do their real initialization in the splash Activity, and jumping straight to the
    // main Activity throws "had you called RpcService.init" - the app flashes and disappears.
    const resolved = (await this.resolveLauncher(pkg).catch(() => '')) || activity;
    // resolved may be a full component (pkg/class) or a bare class name (old apps.json);
    // normalize to the full component am start -n wants, so pkg/pkg/class isn't cancelled.
    const comp = componentArg(pkg, resolved);
    const intent = comp
      ? ['-n', comp]
      : ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', pkg];
    const modes = freeform
      ? [['--windowingMode', '5'], []]
      : [[]];
    let lastError = '';

    for (const mode of modes) {
      const parts = ['am', 'start', ...mode, '--activity-clear-top', ...intent];
      let out = '';
      try {
        // eslint-disable-next-line no-await-in-loop
        out = await this.shell(parts.join(' '), { timeout: 20000 });
      } catch (e) {
        lastError = String(e.message || e);
        continue;
      }
      if (/Error|Exception/i.test(out)) { lastError = out; continue; }

      if (bounds) this.resizeTaskOfPackage(pkg, bounds).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      const alive = await this.waitAppAlive(pkg, 6000);
      if (alive.ok) return out;
      if (alive.uncertain) return `${out}\n(app is still loading)`;
      lastError = alive.crash || lastError;
      // When the crash log clearly points at the ARM translation layer, stop retrying and let the caller switch images
      if (/DoBadTrampoline|libndk_translation|UnsatisfiedLinkError|dlopen failed/i.test(alive.crash || '')) {
        const err = new Error(friendlyLaunchError(alive.crash, pkg));
        err.code = 'APP_CRASHED';
        err.crash = alive.crash;
        throw err;
      }
    }

    // monkey fallback: on some images am start -a/-c/-p can't resolve the launcher
    try {
      const out = await this.shell(
        `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 },
      );
      const alive = await this.waitAppAlive(pkg, 12000);
      if (alive.ok || alive.uncertain) return out;
      lastError = alive.crash || lastError;
    } catch (e) {
      // Prefer a clear crash message; otherwise keep the original launch error
      if (!lastError) lastError = String(e.message || e);
    }

    if (!lastError) return 'started';
    const err = new Error(friendlyLaunchError(lastError, pkg));
    err.code = 'APP_CRASHED';
    err.crash = lastError;
    throw err;
  }

  async forceStop(pkg) {
    try { await this.shell(`am force-stop ${pkg}`); } catch (_) { /* ignore */ }
  }

  async runningPackages() {
    try {
      const out = await this.shell('dumpsys activity activities | grep -E "mResumedActivity|ResumedActivity"');
      const pkgs = [...out.matchAll(/([a-zA-Z][\w.]+\/[.\w$]+)/g)].map((m) => m[1].split('/')[0]);
      return [...new Set(pkgs)];
    } catch (_) {
      return [];
    }
  }

  async taskIdOfPackage(pkg) {
    try {
      const out = await this.shell('dumpsys activity recents');
      const blocks = out.split('Recent #');
      for (const b of blocks) {
        if (!b.includes(pkg)) continue;
        const m = /taskId=(\d+)/.exec(b) || /^\d+/.exec(b);
        if (m) return Number(m[1] || m[0]);
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  async resizeTaskOfPackage(pkg, bounds) {
    const id = await this.taskIdOfPackage(pkg);
    if (!id) return false;
    await this.shell(`am task resize ${id} ${bounds.left} ${bounds.top} ${bounds.right} ${bounds.bottom}`);
    return true;
  }

  /** Turn on freeform (separate window) support; failure doesn't affect the main flow */
  async ensureFreeform() {
    // One adb shell: 4 separate execFile calls take 600 ms+ on Windows, and this sits right
    // inside the "open app" wait.
    const out = await this.shell(
      'settings put global enable_freeform_support 1 ; '
      + 'settings put global force_resizable_activities 1 ; '
      + 'settings put global development_settings_enabled 1 ; '
      + 'settings get global enable_freeform_support',
      { timeout: 12000 },
    ).catch(() => '0');
    return String(out).trim().split(/\r?\n/).pop().trim() === '1';
  }

  async wmSize() {
    const out = await this.shell('wm size');
    const m = /(\d+)x(\d+)/.exec(out.split('\n').pop() || out);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }

  async androidVersion() {
    return (await this.shell('getprop ro.build.version.release').catch(() => '')).trim();
  }

  async sdkInt() {
    const v = await this.shell('getprop ro.build.version.sdk').catch(() => '0');
    return Number(v.trim()) || 0;
  }

  async screenshot() {
    const { stdout } = await this.exec(['exec-out', 'screencap', '-p'], { binary: true, timeout: 20000 });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }

  async push(local, remote) {
    await this.exec(['push', local, remote], { timeout: 180000 });
  }

  async pull(remote, local) {
    await this.exec(['pull', remote, local], { timeout: 180000 });
  }

  async shellMkdir(remote) {
    await this.shell(`mkdir -p "${remote}"`);
  }

  async listRemote(remote) {
    const out = await this.shell(`ls -l "${remote}" 2>/dev/null`);
    return String(out).split('\n').map((line) => {
      const l = line.trim();
      if (!l || l.startsWith('total ')) return null;
      // Android's ls -l comes with and without a group column, and dates may be
      // "2026-11-12 18:52" or "Nov 12 18:52", so a fixed regex parses nothing.
      // The size is the 2nd number after the permission bits; the last segment is the name.
      const parts = l.split(/\s+/);
      if (parts.length < 6 || !/^[\-dl]/.test(parts[0])) return null;
      const sizeIdx = parts.findIndex((p, i) => i >= 2 && /^\d+$/.test(p)
        && /(\d{4}-\d{2}-\d{2}|^[A-Za-z]{3}$)/.test(parts[i + 1] || ''));
      if (sizeIdx < 0) return null;
      const size = Number(parts[sizeIdx]);
      // The name follows the "HH:MM" token (the date takes 2-3 tokens, not fixed)
      const timeIdx = parts.findIndex((p, i) => i > sizeIdx && /^\d{1,2}:\d{2}(:\d{2})?$/.test(p));
      const name = parts.slice((timeIdx >= 0 ? timeIdx : sizeIdx + 2) + 1).join(' ');
      return name ? { isDir: parts[0][0] === 'd', size, name } : null;
    }).filter(Boolean);
  }

  /**
   * Remote listing with real mtimes (toybox stat).
   * ls -l dates are "Mon DD HH:MM" and can't be converted reliably, so sync would think
   * everything changed every time. Returns null when the device lacks stat; the caller
   * should fall back to listRemote.
   */
  async listRemoteStat(remote) {
    let out = '';
    try {
      out = await this.shell(`cd "${remote}" 2>/dev/null && find . -type f -exec stat -c '%Y|%s|%n' {} + 2>/dev/null`);
    } catch (_) {
      return null;
    }
    const rows = parseStatList(out);
    if (!rows) return null;
    return rows;
  }

  /** Clear app data */
  async clearData(pkg) {
    await this.shell(`pm clear ${pkg}`);
  }

  /** Export app data (run-as works on debuggable builds; otherwise fall back to the data folder) */
  async exportAppData(pkg, localTarPath) {
    const remote = `/sdcard/apkstart-tmp-${pkg}.tar`;
    const cmd = `run-as ${pkg} tar -cf ${remote} . 2>/dev/null || (cd /data/data/${pkg} && tar -cf ${remote} .)`;
    await this.shell(cmd);
    await this.pull(remote, localTarPath);
    await this.shell(`rm -f ${remote}`).catch(() => {});
    return localTarPath;
  }

  async batteryOptimizeOff(pkg) {
    try { await this.shell(`dumpsys deviceidle whitelist +${pkg}`); } catch (_) { /* ignore */ }
  }

  /**
   * Grant all runtime permissions the app requests, in one go.
   * Without this: (1) the first launch shows a system permission prompt and the user thinks
   * "the app didn't open"; (2) after clearing data (pm clear) permissions are gone and the
   * app gets stuck on the permission screen.
   */
  async grantRuntimePermissions(pkg) {
    let dump = '';
    try {
      dump = await this.shell(`dumpsys package ${pkg}`, { timeout: 20000 });
    } catch (_) {
      return [];
    }
    const lines = String(dump).split(/\r?\n/);
    let inRuntime = false;
    const denied = [];
    for (const line of lines) {
      if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
      if (!inRuntime) continue;
      if (/^\s{0,6}\S/.test(line)) break; // left the runtime permissions section
      const m = /^\s+([A-Za-z0-9_.]+):\s*granted=(\w+)/.exec(line);
      if (m && m[2] === 'false') denied.push(m[1]);
    }
    const granted = [];
    // Send all grants at once: one pm grant process costs 150 ms+ on Windows, so four or
    // five permissions take a second, and the commands don't depend on each other.
    const cmds = [];
    for (const p of denied) cmds.push(`pm grant ${pkg} ${p}`);
    // Special permissions go through appops, otherwise a prompt still appears
    const ops = ['MANAGE_EXTERNAL_STORAGE', 'SYSTEM_ALERT_WINDOW', 'REQUEST_INSTALL_PACKAGES', 'WRITE_SETTINGS'];
    for (const op of ops) cmds.push(`cmd appops set ${pkg} ${op} allow`);
    if (cmds.length) {
      await this.shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
      granted.push(...denied);
    }
    return granted;
  }

  /**
   * Enter "it's just this app" mode:
   *  - dismiss the lock screen so boot doesn't stop there and hide the app;
   *  - hide the status bar (keep the bottom navigation so back/home are clickable without a mouse);
   *  - turn off system animations, a big difference on low-end machines.
   * All settings-level commands, a few hundred ms, harmless to repeat.
   */
  async prepareForeground() {
    // These used to be 7 serial commands, each a new adb process (150-250 ms on Windows),
    // 1-1.7 s total, all inside the "open app" wait. One combined shell is a single round trip.
    const cmds = [
      'wm dismiss-keyguard',
      'settings put global policy_control immersive.status=*',
      'settings put secure immersive_mode_confirmations confirmed',
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put system screen_off_timeout 2147483647',
      // Note: don't write wm user-rotation / accelerometer_rotation here.
      // Orientation is set by setOrientation / resetDisplayOverrides from the current mode;
      // locking 0 here would override landscape back to portrait (rotated picture).
    ];
    await this.shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => {});
    return true;
  }

  /** Right-click / side buttons / shortcut mapping: via the resident input channel, so back has no 100 ms lag */
  async _key(code) {
    try {
      await this.input(`input keyevent ${code}`);
    } catch (_) {
      // Right after a runtime restart the resident shell may not be connected yet; fall back to one-shot adb, never drop the click
      await this.shell(`input keyevent ${code}`, { timeout: 6000 }).catch(() => {});
    }
  }

  async keyBack() { return this._key(4); }
  async keyForward() { return this._key(125); }

  /**
   * Switch phone layout / tablet layout.
   *
   * Key point: **never change wm size**. wm size changes the guest framebuffer's physical size
   * (720x1280 -> 1280x720) while the embedded Qt window keeps its old size/orientation, so the
   * picture gets squashed or rotated 90 degrees and mouse mapping breaks. Worse, the wm size
   * override persists in /data and survives restarts - the root cause of the repeated
   * "black borders / not filled / taps don't work" reports.
   *
   * Now only the logical density (wm density) changes; the framebuffer stays 720x1280 upright:
   *   - 320dpi -> smallestWidth 360dp -> phone layout
   *   - 190dpi -> smallestWidth 606dp (>=600dp) -> tablet / two-pane layout
   * Size, orientation and tap mapping stay the same: no rotation, no black borders, taps always line up.
   */
  async setOrientation(landscape) {
    try {
      // Auto-rotate must be off (or the sensor spins it), but user_rotation must be locked to
      // the target orientation: once the panel is 1280x720, only user-rotation 1 (90 degrees)
      // makes Android lay out in landscape - otherwise it renders portrait content at rotation
      // 0 and Qt shows it lying on its side in the landscape window.
      await this.shell('settings put system accelerometer_rotation 0; wm size reset', { timeout: 15000 });
      await this.shell(`wm user-rotation lock ${landscape ? 1 : 0}`, { timeout: 15000 });
      await this.shell(landscape ? 'wm density 190' : 'wm density reset', { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** On start, clear wm size / density overrides left by old versions (persisted in /data, keeps the picture rotated) */
  async resetDisplayOverrides(landscape = false) {
    try {
      await this.shell('wm size reset; wm density reset', { timeout: 15000 });
      await this.shell('settings put system accelerometer_rotation 0', { timeout: 15000 });
      await this.shell(`wm user-rotation lock ${landscape ? 1 : 0}`, { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Current logical resolution (after switching to landscape the window aspect ratio follows it) */
  async displaySize() {
    try {
      const out = await this.shell('wm size', { timeout: 8000 });
      const o = /Override size:\s*(\d+)x(\d+)/.exec(out);
      if (o) return { w: Number(o[1]), h: Number(o[2]) };
      const p = /Physical size:\s*(\d+)x(\d+)/.exec(out);
      if (p) return { w: Number(p[1]), h: Number(p[2]) };
    } catch (_) { /* ignore */ }
    return null;
  }

  /** If a permission dialog is still on top, press back to dismiss it (self-heals even when the user is away) */
  async dismissPermissionDialog() {    try {
      const top = await this.shell('dumpsys activity activities', { timeout: 12000 });
      if (/GrantPermissionsActivity|permissioncontroller/i.test(String(top))) {
        await this.shell('input keyevent 4', { timeout: 6000 }).catch(() => {});
        return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  /**
   * Display fitting: in fullscreen set Android's resolution to the monitor size (content fills it),
   * restore the portrait preset in windowed mode. wm takes effect at runtime, no Android restart needed.
   */
  async setDisplaySize(width, height, density) {
    const w = Math.max(320, Math.round(Number(width) || 0));
    const h = Math.max(480, Math.round(Number(height) || 0));
    await this.shell(`wm size ${w}x${h}`);
    if (density) await this.shell(`wm density ${Math.max(120, Math.min(640, Math.round(density)))}`);
    return { w, h };
  }

  async resetDisplaySize() {
    await this.shell('wm size reset').catch(() => {});
    await this.shell('wm density reset').catch(() => {});
  }
}

module.exports = {
  AdbClient, AdbError, parseStatList, friendlyInstallError, friendlyLaunchError,
  componentArg, parseResolvedActivity,
};
