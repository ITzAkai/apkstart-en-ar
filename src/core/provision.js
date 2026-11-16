'use strict';
/**
 * Runtime provisioning
 *
 * ApkStart needs no third-party emulator: adb, QEMU and system images are downloaded,
 * checked and managed by ApkStart itself. All runtime files live under
 * %APPDATA%\apkstart\runtime so they are writable wherever the app is installed.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const store = require('./store');
const doctor = require('./doctor');
const { download, downloadAny, downloadAnyParallel, downloadMulti, head, discardPartial, sha256File } = require('./download');
const { ZipArchive, ZipFile } = require('./zip');
const { Sources, updateRepo } = require('./sources');
const { cmpVer } = require('./version');
const { t } = require('../i18n');

const IS_WIN = process.platform === 'win32';

const SOURCES = {
  adb: [
    'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  ],
  qemuIndex: 'https://qemu.weilnetz.de/w64/',
  qemuFallback: [
    'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe',
  ],
  // Google's official SDK index: real emulator and system image URLs are resolved from here, no hard-coded versions
  sdkIndex: 'https://dl.google.com/android/repository/repository2-3.xml',
  sysImgIndexes: [
    'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
    'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml',
  ],
  aehdFallback: 'https://dl.google.com/android/repository/aehd-windows_v2.2.zip',
  // Fallbacks: known versions used when the index is unavailable
  emulatorFallback: 'https://dl.google.com/android/repository/emulator-windows_x64-16847572.zip',
  sysimgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // ARM compatibility image (Google Play variant, built-in native bridge)
  playImgIndex: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml',
  playImgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // Android-x86 9.0-r2 (x86_64): only used when the user supplies an ISO
  iso: [
    'https://master.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso?viasf=1',
    'https://nchc.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://phoenixnap.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://downloads.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
  ],
  isoSizeHint: 900 * 1024 * 1024,
};

/**
 * <url> entries in the SDK indexes are relative, and each index has a different base:
 *   repository2-3.xml      → https://dl.google.com/android/repository/
 *   sys-img/android/*.xml  → https://dl.google.com/android/repository/sys-img/android/
 * so the base is always the index file's own folder. (Using the bare file name as a URL threw Invalid URL.)
 */
const REPO_BASE = 'https://dl.google.com/android/repository/';

function baseOf(indexUrl) {
  const s = String(indexUrl || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i + 1) : REPO_BASE;
}

function absUrl(u, base = REPO_BASE) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return base + s.replace(/^\/+/, '');
}

/**
 * Keep a single general-purpose base image.
 * Older versions defaulted to AOSP API 30 plus an optional API 34 Play compatibility image:
 *   - ARM-only apps failed until the user switched images by hand;
 *   - two images of 0.6-3 GB each made the runtime folder grow past 10 GB;
 *   - switching images needed wipe-data, losing every installed app.
 * Now it is always Android 14 Google Play x86_64: x86 apps, ARM apps and GMS all run, and
 * the machine keeps one read-only base layer (shared, container-style), downloaded once.
 */
const PLAY_SYSIMG = { api: '34', tag: 'google_apis_playstore', abi: 'x86_64' };
const DEFAULT_SYSIMG = PLAY_SYSIMG;

const MIN_SIZE = {
  adb: 5 * 1024 * 1024,
  qemu: 60 * 1024 * 1024,
  iso: 400 * 1024 * 1024,
  disk: 1024 * 1024,
  emulator: 200 * 1024 * 1024,
  sysimg: 300 * 1024 * 1024,
  aeHD: 64 * 1024,
};

function run(cmd, args, { timeout = 60000, cwd, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, windowsHide, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
  });
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

/** Notes are cached in English and translated when returned (the language can change at runtime). */
function withNote(r) {
  return r && r.note ? { ...r, note: t(r.note) } : r;
}

/**
 * Completeness check after a download. On failure **the incomplete file is deleted**.
 *
 * This used to throw without deleting, leaving a half zip in tmp. download() then resumed
 * it with Range next time; if the server/source had changed, the bytes didn't line up,
 * it failed again and left another partial: "it keeps re-downloading".
 */
function assertComplete(file, minBytes, label) {
  const size = fileSize(file);
  if (size >= minBytes) return size;
  discardPartial(file);
  throw new Error(t('{label}: download incomplete ({size} MB), removed. Please try again.', { label, size: (size / 1048576).toFixed(1) }));
}

/**
 * On-disk cache of environment probes.
 *
 * `emulator -version` and `emulator -accel-check` each spawn an emulator process, 1-3 s on
 * Windows, and their results don't change while the engine/driver stays the same. A 30 s
 * in-memory cache meant paying that on every cold start, right when the user opens an app.
 * The cache is keyed by exe size+mtime, AEHD driver timestamp and the WHPX component,
 * stored under %APPDATA%, and invalidates itself when any of them changes.
 */
const ENV_CACHE_TTL = 6 * 60 * 60 * 1000;
const ENV_CACHE_NEG_TTL = 10 * 60 * 1000; // trust "no acceleration" for only 10 min: the user may have just enabled virtualization

function envCacheFile() {
  return path.join(store.DATA_DIR, 'cache', 'env.json');
}

function statKey(p) {
  try {
    const s = fs.statSync(p);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch (_) { return ''; }
}

class Provisioner {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this._hypervisor = null;
    this._cache = { adbVersion: '', qemuVersion: '' };
    this._sources = new Sources(() => store.getSettings());
  }

  /** Download sources + mirror handling (the speed-test cache is shared by all components) */
  get sources() {
    return this._sources;
  }

  /** Cache fingerprint: changes when the engine file or the acceleration driver changes */
  _envKey(exe) {
    const aehd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    return [
      String(exe || '').replace(/\\/g, '/').toLowerCase(),
      statKey(exe),
      statKey(aehd),
      fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll') ? '1' : '0',
      'n2',   // bumped so caches written by older versions (notes not translatable) are dropped
    ].join('|');
  }

  envCacheGet(exe) {
    try {
      const j = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8'));
      if (!j || j.key !== this._envKey(exe)) return null;
      return j;
    } catch (_) { return null; }
  }

  envCacheSet(exe, patch) {
    try {
      const key = this._envKey(exe);
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8')) || {}; } catch (_) { /* first run */ }
      const base = cur.key === key ? cur : { key, version: null, accel: null, accelAt: 0 };
      const next = { ...base, ...patch, key, at: Date.now() };
      fs.mkdirSync(path.dirname(envCacheFile()), { recursive: true });
      fs.writeFileSync(envCacheFile(), JSON.stringify(next));
    } catch (_) { /* a failed cache write doesn't matter */ }
  }

  /** Call after a failed boot (acceleration/image issues): re-probe next time instead of trusting a wrong result */
  invalidateEnvCache() {
    this._cache = { adbVersion: '', qemuVersion: '' };
    try { fs.rmSync(envCacheFile(), { force: true }); } catch (_) { /* ignore */ }
  }

  // ---------------- Paths ----------------

  get root() {
    const r = store.getSettings().runtime.dir;
    return r && r.trim() ? r : path.join(store.DATA_DIR, 'runtime');
  }

  paths() {
    const root = this.root;
    const sysTag = DEFAULT_SYSIMG.tag;
    const sysApi = DEFAULT_SYSIMG.api;
    const sysAbi = DEFAULT_SYSIMG.abi;
    // The AVD (user data, installed apps, quickboot snapshot) must live somewhere writable
    // that isn't cleaned up. The single-file build unpacks its runtime to a temp folder, so
    // an AVD there would lose all apps on exit. Whenever the runtime folder is outside
    // %APPDATA%, the AVD is pinned to the user data folder.
    // The "Android data folder" can also be set separately in Settings: it is what really
    // eats disk (6-24 GB data partition + 2-3 GB snapshot), so moving only the runtime still fills C:.
    const explicitAvd = String(store.getSettings().runtime.avdDir || '').trim();
    const writable = explicitAvd || path.join(store.DATA_DIR, 'avd');
    const insideData = root.toLowerCase().startsWith(store.DATA_DIR.toLowerCase());
    // Where system images go: **the runtime folder first**.
    // It used to prefer the user data folder: a user moved the runtime folder to D: to save
    // space on C:, the 1.4 GB pack unpacked to D:, and then materializeImages expanded the
    // 3.3 GB system.img back into %APPDATA%\apkstart\system-images on C: anyway, keeping
    // two copies (1.2 GB + 3.3 GB seen side by side).
    const rootImg = path.join(root, 'system-images');
    const dataImg = path.join(store.DATA_DIR, 'system-images');
    // Three cases:
    //  1) the runtime folder already has images (unpacked from the pack) -> use them;
    //  2) older installs / the single-file build keep them in the user data folder -> use those;
    //  3) fresh install (neither) -> the runtime folder, because the user data folder may be
    //     a redirected temp folder (as when CI assembles the runtime) and writing there breaks verification.
    const sysRoot = fs.existsSync(rootImg) ? rootImg : (fs.existsSync(dataImg) ? dataImg : rootImg);
    return {
      root,
      qemuDir: path.join(root, 'qemu'),
      qemuExe: path.join(root, 'qemu', 'qemu-system-x86_64.exe'),
      qemuImg: path.join(root, 'qemu', 'qemu-img.exe'),
      adbDir: path.join(root, 'platform-tools'),
      adbExe: path.join(root, 'platform-tools', 'adb.exe'),
      // Emulator runtime (Google's official): root doubles as ANDROID_SDK_ROOT
      emulatorDir: path.join(root, 'emulator'),
      emulatorExe: path.join(root, 'emulator', 'emulator.exe'),
      sysImgRoot: sysRoot,
      sysImgDir: path.join(sysRoot, `android-${sysApi}`, sysTag, sysAbi),
      avdHome: insideData ? path.join(root, 'avd') : writable,
      aehdDir: path.join(root, 'aehd'),
      imagesDir: path.join(root, 'images'),
      iso: path.join(root, 'images', 'android-x86.iso'),
      disk: path.join(root, 'images', 'android.qcow2'),
      tmp: path.join(root, '_tmp'),
      sysTag, sysApi, sysAbi,
    };
  }

  ensureDirs() {
    const p = this.paths();
    for (const d of [p.root, p.qemuDir, p.adbDir, p.imagesDir, p.tmp, p.avdHome]) {
      fs.mkdirSync(d, { recursive: true });
    }
    return p;
  }

  /**
   * Disk guard: before downloading / extracting a large component, make sure the target
   * drive has enough free space, or the download fills the system drive halfway or the
   * extraction fails (leaving partial files). Keeps 1 GB spare: after extraction the
   * snapshot and user data partition keep growing.
   * @param {string} component component name (decides the space estimate)
   * @param {string} targetDir folder being written (decides the drive)
   */
  async guardDisk(component, targetDir) {
    const need = {
      adb: 64, emulator: 600, sysimg: 1800, playimg: 1800, qemu: 320, iso: 1100, aehd: 64,
      // Runtime pack: 1.5 GB zip + ~3.3 GB expanded image, both present at the peak
      runtime: 5000,
    }[component] || 512; // MB
    const buf = 1024; // keep 1 GB extra (snapshot / data partition / temporary extraction files)
    const dir = targetDir || this.root;
    const free = doctor.freeDiskMB(dir);
    if (free && free < need + buf) {
      throw new Error(t("Not enough disk space: this needs about {need} MB, but the drive holding {dir} has only {free} MB free.\nMove the runtime data folder to a larger drive in Settings, or free up space / uninstall apps you don't use, then try again.", { need: need + buf, dir, free }));
    }
    return free;
  }

  // ---------------- Environment checks ----------------

  async hypervisor() {
    if (this._hypervisor !== null) return withNote(this._hypervisor);
    if (!IS_WIN) { this._hypervisor = { whpx: false, note: 'Not a Windows platform' }; return withNote(this._hypervisor); }
    // Only a millisecond file check. Whether WHPX actually works is answered by
    // emulator -accel-check; spawning PowerShell here (1-2 s cold) would slow every status poll.
    const dll = fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll');
    this._hypervisor = {
      whpx: false,          // emulatorAccel() supplies the real value
      dll,
      hypervisorPresent: false,
      note: dll
        ? 'Virtual Machine Platform is present (the runtime engine checks whether it works)'
        : 'Windows Hypervisor Platform not found: turn on "Virtual Machine Platform" in "Turn Windows features on or off", then restart',
    };
    return withNote(this._hypervisor);
  }

  async adbVersion() {
    // 30 s cache so status polling doesn't keep spawning processes
    if (this._adbCache && Date.now() - this._adbCache.at < 30000) return this._adbCache.value;
    const { adbExe, adbDir } = this.paths();
    const candidates = [adbExe, path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['version'], { timeout: 10000 });
      if (r.ok) {
        const m = /version\s+([\d.]+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : r.stdout.split('\n')[0].trim() };
        this._adbCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._adbCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._adbCache.value;
  }

  async qemuVersion() {
    if (this._qemuCache && Date.now() - this._qemuCache.at < 30000) return this._qemuCache.value;
    const p = this.paths();
    const candidates = [
      p.qemuExe,
      store.getSettings().runtime.qemuPath,
      'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',   // winget's default install location
      path.join(this.appRoot, 'engine', 'qemu', 'qemu-system-x86_64.exe'),
    ].filter(Boolean);
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['--version'], { timeout: 15000 });
      if (r.ok || r.stdout) {
        const m = /QEMU emulator version\s+(\S+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : (r.stdout || '').split('\n')[0].trim() };
        this._qemuCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._qemuCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._qemuCache.value;
  }

  /** Check the ISO9660 primary volume descriptor ("CD001" at 0x8001) so an error page / partial file isn't taken for an image */
  inspectIso(file) {
    const size = fileSize(file);
    if (!size) return { ok: false, iso9660: false, size: 0, reason: t('Not downloaded') };
    let magic = '';
    try {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(5);
      fs.readSync(fd, b, 0, 5, 0x8001);
      fs.closeSync(fd);
      magic = b.toString('latin1');
    } catch (_) { /* ignore */ }

    const iso9660 = magic === 'CD001';
    // Raw / installed disk images imported by the user have no ISO boot area: accept by size
    const rawImage = !iso9660 && /\.(img|raw|qcow2)$/i.test(file) && size > MIN_SIZE.iso;
    const ok = size > MIN_SIZE.iso && (iso9660 || rawImage);

    let reason = '';
    if (!ok) {
      reason = size <= MIN_SIZE.iso
        ? t('The file is only {size} MB; the download is not finished', { size: (size / 1048576).toFixed(1) })
        : t('Not a valid ISO9660 image (maybe an error page was downloaded, or the file is damaged)');
    }
    return { ok, iso9660, rawImage, size, reason, magic };
  }

  async checkEnv() {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const [adb, qemu, hv, emulator, accel] = await Promise.all([
      this.adbVersion(), this.qemuVersion(), this.hypervisor(),
      this.emulatorVersion(), this.emulatorAccel(),
    ]);

    const isoPath = s.runtime.isoPath || p.iso;
    const diskPath = s.runtime.diskPath || p.disk;
    const iso = this.inspectIso(isoPath);
    const diskSize = fileSize(diskPath);
    const sysimg = this.systemImageInfo();

    // The full build ships one API 34 Google Play image that is both the main and the
    // compatibility image; don't depend on compatImage, or an image that is present would
    // count as "not deployed" just because the switch is off.
    const compatReady = this.playImageInfo().ok;
    const emulatorReady = emulator.ok && (sysimg.ok || compatReady);
    const qemuReady = qemu.ok && diskSize > MIN_SIZE.disk;

    return {
      adb: { ...adb, required: true },
      emulator: { ...emulator, required: true, note: emulator.ok ? emulator.version : t('Not installed') },
      sysimg: {
        ok: sysimg.ok || compatReady,
        dir: sysimg.dir,
        size: sysimg.ok ? sysimg.size : (compatReady ? this.playImageInfo().size : 0),
        api: sysimg.ok ? sysimg.api : (compatReady ? PLAY_SYSIMG.api : sysimg.api),
        required: false,
        note: sysimg.ok
          ? `Android ${sysimg.api} (${(sysimg.size / 1073741824).toFixed(2)} GB)`
          : (compatReady ? t('Android {api} (ARM compatibility image)', { api: PLAY_SYSIMG.api }) : (sysimg.note || t('Not downloaded'))),
      },
      playImage: this.playImageInfo(),
      accel,
      qemu: { ...qemu, required: false },
      iso: {
        ok: iso.ok,
        path: isoPath,
        size: iso.size,
        iso9660: iso.iso9660,
        required: false,
        note: iso.size ? `${(iso.size / 1073741824).toFixed(2)} GB` : t('Not downloaded'),
        reason: iso.reason,
      },
      disk: {
        ok: diskSize > MIN_SIZE.disk,
        path: diskPath,
        size: diskSize,
        required: false,
        note: diskSize ? `${(diskSize / 1073741824).toFixed(2)} GB` : t('Not created yet'),
      },
      hypervisor: hv,
      ready: !!(adb.ok && (emulatorReady || qemuReady)),
      engine: emulatorReady ? 'emulator' : (qemuReady ? 'qemu' : 'none'),
      paths: p,
    };
  }

  // ---------------- adb ----------------

  async installAdb(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('adb', p.root);
    const zipPath = path.join(p.tmp, 'platform-tools.zip');
    onProgress({ stage: 'download', message: t('Downloading Android platform-tools (about 8 MB)…'), percent: 2 });

    await downloadAny(SOURCES.adb, zipPath, {
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: t('Downloading adb… {got} MB / {total} MB', { got: (pr.got / 1048576).toFixed(1), total: (pr.total / 1048576).toFixed(1) }),
        percent: pr.percent,
        speed: pr.speed,
      }),
    });

    assertComplete(zipPath, MIN_SIZE.adb, t('adb package'));

    onProgress({ stage: 'extract', message: t('Extracting adb…'), percent: 92 });
    await this.extractZip(zipPath, p.root);

    const v = await this.adbVersion();
    if (!v.ok) throw new Error(t("adb won't run after extraction. Check whether antivirus software blocked it."));

    fs.rmSync(zipPath, { force: true });
    store.saveSettings({ adbPath: v.path });
    this._cache.adbVersion = v.version;
    onProgress({ stage: 'done', message: t('adb {version} ready', { version: v.version }), percent: 100 });
    return v;
  }

  // ---------------- Runtime pack from the update repo's GitHub releases (lite build) ----------------

  async _fetchJson(url) {
    const text = await this._fetchText(url).catch(() => '');
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  /**
   * Find the runtime pack download.
   * Asset name: ApkStart-runtime-<tag>.zip (made by the release workflow; contents are
   * build/runtime: emulator/ + platform-tools/ + aehd/ + system-images/). It comes from the
   * GitHub releases of `updateRepo` in package.json, newest version first, and only if GitHub
   * published a SHA-256 digest for it (checked after download). Throws when there is none,
   * so the caller falls back to Google's official per-component downloads.
   */
  async resolveRuntimePack() {
    const custom = String(store.getSettings().runtime.runtimePackUrl || '').trim();
    if (custom) return { url: absUrl(custom), name: path.basename(custom.split('?')[0]), size: 0, tag: 'custom' };
    if (this._cache.pack) return this._cache.pack;

    const repo = updateRepo();
    if (!repo) throw new Error(t('No runtime pack is published for this build'));
    const list = await this._fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=15`).catch(() => null);
    if (!Array.isArray(list)) throw new Error(t("Couldn't reach GitHub to look up the runtime pack"));

    const cands = [];
    for (const rel of list) {
      if (!rel || rel.draft) continue;
      const hit = (rel.assets || []).find((x) => /^ApkStart-runtime-.*\.zip$/i.test(x.name || '')
        && /^sha256:[0-9a-f]{64}$/i.test(String(x.digest || '')));
      if (!hit) continue;
      cands.push({
        url: hit.browser_download_url || hit.url,
        name: hit.name,
        size: hit.size || 0,
        sha256: hit.digest.slice(7).toLowerCase(),
        tag: String(rel.tag_name || rel.name || '').replace(/^v/i, ''),
        page: rel.html_url,
        from: 'GitHub',
      });
    }
    if (!cands.length) throw new Error(t('No verified runtime pack found in the GitHub releases'));
    cands.sort((a, b) => cmpVer(b.tag, a.tag));
    this._cache.pack = cands[0];
    return this._cache.pack;
  }

  /**
   * Lite build one-click setup: download the runtime pack and extract it.
   * System images are .xz inside the pack and get expanded right after (only once).
   */
  async installRuntimePack(onProgress = () => {}) {
    const p = this.ensureDirs();
    // Report something first: finding the version and testing speed have no byte progress,
    // and without a message the user thinks it froze.
    onProgress({ stage: 'download', message: t('Getting runtime version info…'), percent: 1 });
    const pack = await this.resolveRuntimePack();
    await this.guardDisk('runtime', p.root);
    const zip = path.join(p.tmp, 'runtime-pack.zip');
    const total = pack.size || 0;
    const s = store.getSettings().runtime || {};
    const conn = Math.max(1, Math.min(16, Number(s.downloadConnections) || 8));

    onProgress({ stage: 'download', message: t('Picking the fastest download source ({from} · {tag})…', { from: pack.from || 'GitHub', tag: pack.tag }), percent: 1 });
    // Candidates = the URL + the user's mirror prefix, ranked by a real speed sample: guessing
    // by host is often wrong (the same URL can do 30 KB/s in the morning and 5 MB/s at night).
    const urls = await this.sources
      .rank(this._downloadUrls(pack.url), { onProgress: (pp) => onProgress({ stage: 'download', message: pp.message, percent: 1 }) })
      .catch(() => this._downloadUrls(pack.url));

    onProgress({ stage: 'download', message: t('Downloading the runtime (about 1.5 GB, only once, {connections} connections)…', { connections: conn }), percent: 2 });
    // Parallel chunks are much faster than one stream: per-connection throttling is common
    // (a single stream may get only 100-200 KB/s). Falls back to single-stream resume.
    await downloadMulti(urls, zip, {
      connections: conn,
      onProgress: (pr) => {
        const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
        const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
        const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
        const eta = Number(pr.eta) > 0 ? ` · ${t('about {minutes} min left', { minutes: Math.ceil(pr.eta / 60) })}` : '';
        onProgress({
          stage: 'download',
          message: t('Downloading the runtime {progress}', { progress: `${mb}${sp}${eta}` }),
          percent: Math.max(1, Math.min(90, Math.round(pct * 0.9))),
          speed: pr.speed,
        });
      },
    });
    assertComplete(zip, 200 * 1024 * 1024, t('Runtime pack'));
    // A pack from GitHub carries the SHA-256 digest GitHub published; nothing is extracted
    // unless it matches. (A custom runtimePackUrl set by the user has no digest to check.)
    if (pack.sha256) {
      onProgress({ stage: 'download', message: t('Verifying the runtime pack…'), percent: 90 });
      if ((await sha256File(zip)) !== pack.sha256) {
        discardPartial(zip);
        throw new Error(t("The runtime pack doesn't match its published SHA-256 checksum, so it was deleted. Please try again."));
      }
    }

    onProgress({ stage: 'extract', message: t('Extracting the runtime (about 1 minute)…'), percent: 91 });
    await this.extractZip(zip, p.root, {
      onEntry: (name, done, all) => {
        if (done % 50 === 0) {
          onProgress({ stage: 'extract', percent: Math.min(99, 91 + Math.round((done / all) * 8)), message: t('Extracting {done}/{total}', { done, total: all }) });
        }
      },
    });
    try {
      fs.writeFileSync(path.join(p.root, '.runtime-pack.json'), JSON.stringify({
        name: pack.name, tag: pack.tag, at: new Date().toISOString(), from: pack.url,
      }));
      fs.rmSync(zip, { force: true });
    } catch (_) { /* a failed marker write doesn't matter */ }

    // The pack's system.img is .xz compressed (like the full installer). Expand it now, or
    // the following checkEnv() sees "no system image" and downloads another 1.4 GB from Google.
    // A failed expansion must fail the setup with its reason: swallowing it used to leave
    // progress at 99% and then fall back to the official source, re-downloading 1.4 GB.
    onProgress({ stage: 'extract', message: t('Expanding the system image (about 1 minute, only once)…'), percent: 99 });
    await this.materializeImages((m) => onProgress({ stage: 'extract', message: m, percent: 99 }));

    onProgress({ stage: 'done', message: t('Runtime ready'), percent: 100 });
    return { ok: true, name: pack.name, tag: pack.tag };
  }

  /**
   * Candidate download URLs: direct first, then the user's mirror prefix. Goes through
   * Sources so mirror handling lives in one place and shares the speed-test cache.
   */
  _downloadUrls(url) {
    return this.sources.candidates(url);
  }

  /**
   * Extract with the bundled ZIP parser (no dependency on system tools).
   * Large entries (GB-sized system.img) are streamed and small ones read whole, to stay
   * under Node's single-Buffer limit.
   */
  async extractZip(zipPath, destDir, opts = {}) {
    // Large zips (emulator / system images) use the file-backed reader so a 1.5 GB zip isn't
    // loaded into memory (works on low-RAM machines); small ones use the faster in-memory reader.
    const big = fileSize(zipPath) > 64 * 1024 * 1024;
    const zip = big ? new ZipFile(zipPath) : new ZipArchive(fs.readFileSync(zipPath));
    const STREAM_THRESHOLD = 64 * 1024 * 1024;
    const total = zip.names().length;
    let done = 0;

    try {
      for (const name of zip.names()) {
        if (name.endsWith('/')) {
          fs.mkdirSync(path.join(destDir, name), { recursive: true });
          continue;
        }
        const target = path.join(destDir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const e = zip.entries.get(name);
        if (e.uncompSize > STREAM_THRESHOLD) {
          // eslint-disable-next-line no-await-in-loop
          await zip.pipeTo(name, fs.createWriteStream(target));
        } else {
          fs.writeFileSync(target, zip.read(name));
        }
        done += 1;
        if (opts.onEntry) opts.onEntry(name, done, total);
      }
    } finally {
      if (zip.close) zip.close();
    }
    return destDir;
  }

  // ---------------- Emulator (Google's official runtime) ----------------

  /** Fetch a text document with a size cap (the index files are about 400 KB) */
  async _fetchText(url, limit = 2 * 1024 * 1024) {
    const { openStream } = require('./download');
    const res = await openStream(url);
    return new Promise((resolve, reject) => {
      let d = '';
      res.on('data', (c) => { d += c; if (d.length > limit) res.destroy(); });
      res.on('end', () => resolve(d));
      res.on('error', () => resolve(d));
    });
  }

  /** Resolve the latest Windows emulator package URL from the SDK index */
  async resolveEmulatorUrl() {
    const cached = store.getSettings().runtime.emulatorUrl;
    if (cached && cached.trim()) return absUrl(cached);
    if (this._cache.emulatorUrl) return this._cache.emulatorUrl;
    try {
      const xml = await this._fetchText(SOURCES.sdkIndex);
      const block = /<remotePackage path="emulator"[\s\S]*?<\/remotePackage>/.exec(xml);
      if (block) {
        const base = baseOf(SOURCES.sdkIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base));
        const win = urls.find((u) => /windows_x64.*\.zip$/i.test(u));
        if (win) {
          this._cache.emulatorUrl = win;
          return win;
        }
      }
    } catch (_) { /* use the fallback */ }
    this._cache.emulatorUrl = SOURCES.emulatorFallback;
    return SOURCES.emulatorFallback;
  }

  /** Resolve the default system image URL from the sys-img indexes */
  async resolveSysimgUrl() {
    const cached = store.getSettings().runtime.sysimgUrl;
    if (cached && cached.trim()) return absUrl(cached, baseOf(SOURCES.sysImgIndexes[0]));
    if (this._cache.sysimgUrl) return this._cache.sysimgUrl;
    const want = `system-images;android-${DEFAULT_SYSIMG.api};${DEFAULT_SYSIMG.tag};${DEFAULT_SYSIMG.abi}`;
    for (const idx of [SOURCES.playImgIndex, ...SOURCES.sysImgIndexes]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const xml = await this._fetchText(idx);
        const re = new RegExp(`<remotePackage path="${want.replace(/[;]/g, ';')}"[\\s\\S]*?</remotePackage>`);
        const block = re.exec(xml);
        if (block) {
          const base = baseOf(idx);
          const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
            .filter((u) => /x86_64.*\.zip$/i.test(u));
          if (urls.length) {
            this._cache.sysimgUrl = urls[urls.length - 1];
            return this._cache.sysimgUrl;
          }
        }
      } catch (_) { /* try the next index */ }
    }
    this._cache.sysimgUrl = SOURCES.sysimgFallback;
    return SOURCES.sysimgFallback;
  }

  async emulatorVersion() {
    if (this._cache.emulatorVersion && this._cache.emulatorVerAt && Date.now() - this._cache.emulatorVerAt < 30000) {
      return this._cache.emulatorVersion;
    }
    const p = this.paths();
    const candidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      // Probed in an earlier session and the engine file hasn't changed: use the saved result (saves a 1 s+ process spawn)
      const cached = this.envCacheGet(c);
      if (cached && cached.version && cached.version.ok && Date.now() - (cached.at || 0) < ENV_CACHE_TTL) {
        this._cache.emulatorVersion = cached.version;
        this._cache.emulatorVerAt = Date.now();
        return cached.version;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await run(c, ['-version'], { timeout: 20000 });
      const text = `${r.stdout}${r.stderr}`;
      const m = /Android emulator version\s+([\d.]+)/i.exec(text);
      if (m) {
        this._cache.emulatorVersion = { ok: true, path: c, version: m[1] };
        this._cache.emulatorVerAt = Date.now();
        this.envCacheSet(c, { version: this._cache.emulatorVersion });
        return this._cache.emulatorVersion;
      }
    }
    return { ok: false, path: '', version: '' };
  }

  /**
   * On first start, expand the compressed images that ship with the package (only once).
   * In the single-file build system.img is .gz (3.1 GB -> about 580 MB); the emulator can't
   * use it until expanded. It is expanded outside the package because the portable build's
   * runtime folder is a fresh temp folder on every start, which would mean re-expanding each boot.
   */
  async materializeImages(onLog = () => {}) {
    const srcRoot = path.join(this.root, 'system-images');
    // The target must follow the same rule as paths().sysImgRoot, or the pack lands on D:
    // while the image is expanded back into %APPDATA% on C: (1.2 GB + 3.3 GB duplicated).
    const destRoot = this.paths().sysImgRoot;
    const jobs = [];
    const copies = []; // other files (kernel-ranchu / ramdisk / uncompressed .img ...) must land in the target too
    const found = new Map(); // dest -> job (prefer .xz when .xz and .gz of the same image both exist)
    const walk = (dir, rel = '') => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, path.join(rel, e.name)); continue; }
        // Supports .img.xz (LZMA2, ~25% smaller than .gz) and the older .img.gz
        if (/\.img\.(xz|gz)$/i.test(e.name)) {
          const dest = path.join(destRoot, rel, e.name.replace(/\.img\.(xz|gz)$/i, '.img'));
          const job = { src: p, dest, xz: /\.xz$/i.test(e.name) };
          const prev = found.get(dest);
          if (!prev || (job.xz && !prev.xz)) found.set(dest, job);
        } else {
          copies.push({ src: p, dest: path.join(destRoot, rel, e.name) });
        }
      }
    };
    walk(srcRoot);
    jobs.push(...found.values());
    if (!jobs.length && !copies.length) return 0;

    // Copy the non-image files first (the emulator needs kernel-ranchu etc. to find and boot the image)
    for (const c of copies) {
      try {
        if (path.resolve(c.src) === path.resolve(c.dest)) continue;   // expanding in place, nothing to copy
        const have = fileSize(c.dest);
        if (have > 0 && have === fileSize(c.src)) continue;
        fs.mkdirSync(path.dirname(c.dest), { recursive: true });
        fs.copyFileSync(c.src, c.dest);
      } catch (e) { onLog(t('Failed to copy an image file: {error}', { error: e.message })); }
    }

    let done = 0;
    const failures = [];
    for (const j of jobs) {
      const have = fileSize(j.dest);
      // "Already expanded" can't just mean > 32 MB: older versions had no .part file, and an
      // interrupted run could leave a few hundred MB that passed the threshold and then broke
      // boot. An expanded image is always larger than its archive, so smaller = unfinished.
      const srcSize = fileSize(j.src);
      if (have > 32 * 1024 * 1024 && (srcSize <= 0 || have >= srcSize)) continue;
      // Expand to .part and rename on success: an interruption (app closed / power loss /
      // disk full) can't leave a half system.img that looks finished, gets skipped next time
      // and then breaks boot, forcing the user to wipe data.
      const part = `${j.dest}.part`;
      try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
      fs.mkdirSync(path.dirname(j.dest), { recursive: true });
      onLog(t('First start: expanding system image {name} (about 1 minute, only once)', { name: path.basename(j.dest) }));
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          const { pipeline, Readable } = require('stream');
          if (j.xz) {
            // LZMA2: require the native binding's index.js directly. The package's default
            // entry (main.js / xz.js) requires 'stream-polyfill.mjs', which throws on Electron's
            // Node 20 (no require(ESM)), and its exports map doesn't allow
            // '@napi-rs/lzma/index.js', so locate the folder with require.resolve and load by path.
            const path0 = require('path');
            const lzmaDir = path0.dirname(require.resolve('@napi-rs/lzma'));
            const { xz } = require(path0.join(lzmaDir, 'index.js'));
            const webIn = Readable.toWeb(fs.createReadStream(j.src));
            const webOut = xz.decompressStream(webIn);
            pipeline(Readable.fromWeb(webOut), fs.createWriteStream(part), (err) => (err ? reject(err) : resolve()));
          } else {
            pipeline(
              fs.createReadStream(j.src),
              zlib.createGunzip(),
              fs.createWriteStream(part),
              (err) => (err ? reject(err) : resolve()),
            );
          }
        });
        fs.renameSync(part, j.dest);
        done += 1;
      } catch (e) {
        try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
        // Don't swallow it: the caller (setup / boot) must know the image wasn't expanded,
        // or it re-downloads 1.4 GB from the official source or fails to boot.
        failures.push(`${path.basename(j.dest)}: ${e.message}`);
        onLog(t('Failed to expand the image: {error}', { error: e.message }));
      }
    }
    if (failures.length) {
      const err = new Error(t('Failed to expand the system image ({details})', { details: failures.join('; ') }));
      err.code = 'MATERIALIZE_FAILED';
      err.failed = failures;
      throw err;
    }
    return done;
  }

  /** Is the system image complete? (system.img is required; missing or too small = not downloaded) */
  systemImageInfo() {
    const p = this.paths();
    const roots = [p.sysImgRoot, path.join(this.root, 'system-images'), path.join(this.appRoot, 'engine', 'system-images')];
    // Look in the default location (API 34 Play) first, then accept any image.
    // The single-file build may ship a smaller AOSP image; insisting on API 34 would report
    // it as "not downloaded" and force a new download.
    const preferred = [p.sysImgDir,
      path.join(this.appRoot, 'engine', 'system-images',
        `android-${DEFAULT_SYSIMG.api}`, DEFAULT_SYSIMG.tag, DEFAULT_SYSIMG.abi)];
    const candidates = [...preferred];
    for (const root of roots) {
      let apis = [];
      try { apis = fs.readdirSync(root).filter((d) => /^android-\d+$/.test(d)); } catch (_) { continue; }
      apis.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) candidates.push(path.join(root, api, tag, abi));
        }
      }
    }
    let missing = null;
    for (const dir of candidates) {
      const system = path.join(dir, 'system.img');
      const kernel = path.join(dir, 'kernel-ranchu');
      const size = fileSize(system);
      const m = /system-images[\\/]android-(\d+)[\\/]([^\\/]+)[\\/]([^\\/]+)$/.exec(dir);
      const api = m ? Number(m[1]) : DEFAULT_SYSIMG.api;
      const tag = m ? m[2] : DEFAULT_SYSIMG.tag;
      const abi = m ? m[3] : DEFAULT_SYSIMG.abi;
      if (size > MIN_SIZE.sysimg && fs.existsSync(kernel)) {
        return { ok: true, dir, size, api, tag, abi };
      }
      if (!missing && fs.existsSync(dir)) {
        missing = { ok: false, dir, size, api, tag, abi, note: size ? t('Image incomplete') : t('system.img missing') };
      }
    }
    if (missing) return missing;
    return { ok: false, dir: p.sysImgDir, size: 0, api: DEFAULT_SYSIMG.api, tag: DEFAULT_SYSIMG.tag, note: t('Not downloaded') };
  }

  /**
   * Hardware acceleration status.
   * On Windows the emulator supports WHPX (a Windows feature, needs a restart) and AEHD
   * (Google's own driver, works once installed).
   */
  async emulatorAccel() {
    // Status is polled every few seconds and -accel-check spawns an emulator process, so cache it
    if (this._cache.accel && this._cache.accelAt && Date.now() - this._cache.accelAt < 30000) {
      return withNote(this._cache.accel);
    }
    const p = this.paths();
    const exe = fs.existsSync(p.emulatorExe) ? p.emulatorExe
      : path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe');
    if (!fs.existsSync(exe)) return { ok: false, kind: 'none', note: t('Emulator not installed') };

    // Disk cache: no emulator process for this on cold start. Notes are stored in English and
    // translated on return. A "not available" result is trusted for only 10 minutes, since
    // the user may have just enabled virtualization / installed AEHD.
    const cached = this.envCacheGet(exe);
    if (cached && cached.accel) {
      const ttl = cached.accel.ok ? ENV_CACHE_TTL : ENV_CACHE_NEG_TTL;
      if (Date.now() - (cached.accelAt || 0) < ttl) {
        this._cache.accel = cached.accel;
        this._cache.accelAt = Date.now();
        return withNote(cached.accel);
      }
    }

    const aehdSys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    const hasAehdFile = fs.existsSync(aehdSys) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    const hv = await this.hypervisor();

    const r = await run(exe, ['-accel-check'], { timeout: 30000 });
    const text = `${r.stdout}${r.stderr}`;
    const usable = /accel:\s*\n?0\b/.test(text) && !/ERROR_ACCESS_DENIED|not installed/i.test(text);

    let result;
    if (usable) {
      const kind = hasAehdFile && /aehd/i.test(text) ? 'aehd' : 'whpx';
      result = { ok: true, kind, note: kind === 'whpx' ? 'WHPX hardware acceleration is on' : 'AEHD hardware acceleration is on' };
    } else if (/can't find the emulator-check|corrupted tools installation/i.test(text) && hasAehdFile) {
      // Some trimmed runtime packs lack emulator-check.exe, so -accel-check can't decide.
      // If the AEHD driver is installed, treat it as available: the emulator loads the driver
      // at start, and wrongly forcing -accel off (software emulation) crashes on some machines.
      result = { ok: true, kind: 'aehd', note: 'AEHD hardware acceleration is on (emulator-check missing; judged by the driver)' };
    } else if (hasAehdFile && /aehd/i.test(text) && !/ERROR_ACCESS_DENIED/i.test(text)) {
      result = { ok: true, kind: 'aehd', note: 'AEHD hardware acceleration is on' };
    } else if (hv.dll && /whpx/i.test(text) && !/error|denied/i.test(text)) {
      result = { ok: true, kind: 'whpx', note: 'WHPX hardware acceleration is on' };
    } else {
      result = {
        ok: false,
        kind: 'none',
        whpx: hv.whpx,
        aehdInstalled: hasAehdFile,
        viaTcg: true,
        note: 'No hardware acceleration: falling back to software emulation (works, but slowly). Install the AEHD driver or turn on "Virtual Machine Platform".',
      };
    }
    this._cache.accel = result;
    this._cache.accelAt = Date.now();
    this.envCacheSet(exe, { accel: result, accelAt: Date.now() });
    return withNote(result);
  }

  /** Download and install the emulator (the zip's top level is emulator/, extracted straight into the SDK root) */
  async installEmulator(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('emulator', p.root);
    const url = await this.resolveEmulatorUrl();
    const zip = path.join(p.tmp, 'emulator.zip');
    onProgress({ stage: 'download', message: t("Downloading the runtime engine (about 440 MB, from Google's official source)…"), percent: 1 });

    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: t('Downloading the runtime engine {got} MB / {total} MB', { got: (pr.got / 1048576).toFixed(0), total: (pr.total / 1048576).toFixed(0) })
          + (pr.speed ? ` (${(pr.speed / 1048576).toFixed(1)} MB/s)` : ''),
        percent: Math.round(pr.percent * 0.85),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.emulator, t('Runtime engine'));

    onProgress({ stage: 'extract', message: t('Extracting the runtime engine…'), percent: 88 });
    await this.extractZip(zip, p.root);
    fs.rmSync(zip, { force: true });

    // The SDK root must also contain platform-tools, or the emulator refuses to start
    this.ensurePlatformTools();

    const v = await this.emulatorVersion();
    if (!v.ok) throw new Error(t("The emulator won't run after extraction. Check whether antivirus software blocked it."));
    this._cache.emulatorVersion = v.version;
    onProgress({ stage: 'done', message: t('Runtime engine {version} ready', { version: v.version }), percent: 100 });
    return v;
  }

  /** The emulator requires platform-tools under the SDK root, or it exits with FATAL */
  ensurePlatformTools() {
    const p = this.paths();
    fs.mkdirSync(p.adbDir, { recursive: true });
    if (fs.existsSync(p.adbExe)) return true;
    const src = [
      path.join(this.appRoot, 'engine', 'platform-tools'),
      path.join(this.appRoot, 'tools', 'platform-tools'),
      path.dirname(this.adbVersionPath() || ''),
    ].find((d) => d && fs.existsSync(path.join(d, 'adb.exe')));
    if (!src) return false;
    for (const f of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
      const from = path.join(src, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(p.adbDir, f));
    }
    return fs.existsSync(p.adbExe);
  }

  adbVersionPath() {
    try {
      const s = store.getSettings();
      if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    } catch (_) { /* ignore */ }
    return '';
  }

  /** Download the single base image (Android 14 Play x86_64); no separate normal/compat images any more */
  async installSystemImage(onProgress = () => {}) {
    if (this.playImageInfo().ok) return this.playImageInfo();
    return this.installPlayImage(onProgress);
  }

  /** Is the ARM compatibility image (Google Play variant) in place? */
  playImageInfo() {
    const p = this.paths();
    const dir = path.join(p.sysImgRoot, `android-${PLAY_SYSIMG.api}`, PLAY_SYSIMG.tag, PLAY_SYSIMG.abi);
    const size = fileSize(path.join(dir, 'system.img'));
    if (size > MIN_SIZE.sysimg && fs.existsSync(path.join(dir, 'kernel-ranchu'))) {
      return { ok: true, dir, size, api: PLAY_SYSIMG.api, tag: PLAY_SYSIMG.tag };
    }
    return { ok: false, dir, size, note: size ? t('Image incomplete') : t('Not downloaded') };
  }

  /** Resolve the Google Play image URL (<url> is relative to the index file's folder) */
  async resolvePlayUrl() {
    if (this._cache.playUrl) return this._cache.playUrl;
    try {
      const xml = await this._fetchText(SOURCES.playImgIndex);
      const want = `system-images;android-${PLAY_SYSIMG.api};${PLAY_SYSIMG.tag};${PLAY_SYSIMG.abi}`;
      const block = new RegExp(`<remotePackage path="${want}"[\\s\\S]*?</remotePackage>`).exec(xml);
      if (block) {
        const base = baseOf(SOURCES.playImgIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
          .filter((u) => /x86_64.*\.zip$/i.test(u));
        if (urls.length) {
          this._cache.playUrl = urls[urls.length - 1];
          return this._cache.playUrl;
        }
      }
    } catch (_) { /* use the fallback */ }
    this._cache.playUrl = SOURCES.playImgFallback;
    return this._cache.playUrl;
  }

  /** Download and install the ARM compatibility image (Google Play variant, about 1.5 GB) */
  async installPlayImage(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('playimg', p.sysImgRoot);
    const url = await this.resolvePlayUrl();
    const zip = path.join(p.tmp, 'play-sysimg.zip');
    onProgress({ stage: 'download', message: t('Downloading the ARM compatibility image (Android 14, about 1.5 GB)…'), percent: 1 });
    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: t('Downloading the compatibility image {got} MB / {total} MB', { got: (pr.got / 1048576).toFixed(0), total: (pr.total / 1048576).toFixed(0) })
          + (pr.speed ? ` (${(pr.speed / 1048576).toFixed(1)} MB/s)` : ''),
        percent: Math.round(pr.percent * 0.8),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.sysimg, t('Compatibility image'));

    const dest = path.join(p.sysImgRoot, `android-${PLAY_SYSIMG.api}`, PLAY_SYSIMG.tag);
    fs.mkdirSync(dest, { recursive: true });
    onProgress({ stage: 'extract', message: t('Extracting the compatibility image (3 GB, takes 10+ seconds)…'), percent: 82 });
    await this.extractZip(zip, dest, {
      onEntry: (_n, i, total) => onProgress({
        stage: 'extract',
        message: t('Extracting the compatibility image {done}/{total}', { done: i, total }),
        percent: 82 + Math.round((i / Math.max(1, total)) * 15),
      }),
    });
    fs.rmSync(zip, { force: true });

    const info = this.playImageInfo();
    if (!info.ok) throw new Error(t('The compatibility image failed verification after extraction'));
    // The old (API 30) compatibility image is no longer used: remove it to free space
    for (const old of ['android-30']) {
      const legacy = path.join(p.sysImgRoot, old, 'google_apis_playstore');
      if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
    }
    onProgress({ stage: 'done', message: t('ARM compatibility image ready. Restart the runtime to use it.'), percent: 100 });
    return info;
  }

  /** Download the AEHD driver (small); installing needs admin rights and is left to the guided flow */
  async installAehd(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('aehd', p.aehdDir);
    const zip = path.join(p.tmp, 'aehd.zip');
    onProgress({ stage: 'download', message: t('Downloading the AEHD driver…'), percent: 10 });
    await downloadAnyParallel(this._downloadUrls(SOURCES.aehdFallback), zip, { connections: 2 });
    fs.mkdirSync(p.aehdDir, { recursive: true });
    await this.extractZip(zip, p.aehdDir);
    fs.rmSync(zip, { force: true });
    const has = fs.existsSync(path.join(p.aehdDir, 'aehd.Sys')) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    if (!has) throw new Error(t('The AEHD driver package did not extract correctly'));
    this._cache.accel = null;
    this._cache.accelAt = 0;
    onProgress({ stage: 'done', message: t('AEHD driver ready; installing it needs administrator rights'), percent: 100 });
    return { ok: true, dir: p.aehdDir, installer: path.join(p.aehdDir, 'silent_install.bat') };
  }

  // ---------------- QEMU ----------------

  /** Find the newest installer file name in the official directory listing (no hard-coded version) */
  async resolveQemuUrl() {
    const configured = store.getSettings().runtime.qemuUrl;
    if (configured && configured.trim()) return configured.trim();
    try {
      const { openStream } = require('./download');
      const res = await openStream(SOURCES.qemuIndex);
      const html = await new Promise((resolve, reject) => {
        let d = '';
        res.on('data', (c) => { d += c; if (d.length > 512 * 1024) res.destroy(); });
        res.on('end', () => resolve(d));
        res.on('error', reject);
      });
      const files = [...html.matchAll(/href="([^"]*qemu-w64-setup-(\d+)\.exe)"/g)]
        .map((m) => ({ file: m[1], ver: Number(m[2]) }))
        .sort((a, b) => b.ver - a.ver);
      if (files.length) {
        const f = files[0].file.replace(/^.*\//, '');
        return new URL(f, SOURCES.qemuIndex).href;
      }
    } catch (_) { /* use the fallback */ }
    return SOURCES.qemuFallback[0];
  }

  async installQemu(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('qemu', p.root);
    const setup = path.join(p.tmp, 'qemu-setup.exe');

    onProgress({ stage: 'resolve', message: t('Looking up the latest QEMU version…'), percent: 1 });
    const url = await this.resolveQemuUrl();
    onProgress({ stage: 'download', message: t('Downloading QEMU (about 200 MB)…'), percent: 2, url });

    await download(url, setup, {
      resume: true,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: t('Downloading QEMU… {got} MB / {total} MB', { got: (pr.got / 1048576).toFixed(0), total: (pr.total / 1048576).toFixed(0) })
          + (pr.speed ? ` (${(pr.speed / 1024).toFixed(0)} KB/s)` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });
    assertComplete(setup, MIN_SIZE.qemu, t('QEMU installer'));

    onProgress({ stage: 'install', message: t('Installing QEMU (silently)…'), percent: 96 });
    // qemu-w64-setup is an NSIS installer: /S = silent, /D = target folder (must be last and unquoted)
    const target = p.qemuDir;
    fs.mkdirSync(target, { recursive: true });
    await new Promise((resolve) => {
      const proc = spawn(setup, ['/S', `/D=${target}`], { windowsHide: true, stdio: 'ignore' });
      proc.on('exit', () => resolve());
      proc.on('error', () => resolve());
      setTimeout(() => { try { proc.kill(); } catch (_) {} resolve(); }, 600000);
    });

    const v = await this.qemuVersion();
    if (!v.ok) {
      throw new Error(t('qemu-system-x86_64.exe not found after installing QEMU. You can download QEMU manually and extract it to engine/qemu/.'));
    }
    fs.rmSync(setup, { force: true });
    this._cache.qemuVersion = v.version;
    onProgress({ stage: 'done', message: t('QEMU {version} ready', { version: v.version }), percent: 100 });
    return v;
  }

  // ---------------- System image ----------------

  async downloadIso(onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.isoPath || p.iso;
    await this.guardDisk('iso', path.dirname(dest));
    const custom = s.runtime.isoUrl && s.runtime.isoUrl.trim();
    const urls = custom ? [custom, ...SOURCES.iso] : SOURCES.iso;

    onProgress({ stage: 'download', message: t('Downloading Android-x86 9.0-r2 (about 900 MB, 8 connections)…'), percent: 1 });
    const r = await downloadAnyParallel(urls, dest, {
      connections: 8,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: t('Downloading the system image… {got} MB / {total} MB', { got: (pr.got / 1048576).toFixed(0), total: (pr.total / 1048576).toFixed(0) })
          + (pr.speed ? ` (${(pr.speed / 1024).toFixed(0)} KB/s)` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });

    const info = this.inspectIso(dest);
    if (!info.ok) {
      throw new Error(info.size && info.size < MIN_SIZE.iso
        ? t('System image unusable: {reason}. Click again to resume the download.', { reason: info.reason })
        : t('System image unusable: {reason}', { reason: info.reason }));
    }

    store.saveSettings({ runtime: { isoPath: dest } });
    onProgress({ stage: 'done', message: t('System image ready ({size} GB)', { size: (info.size / 1073741824).toFixed(2) }), percent: 100, path: dest });
    return { ...r, ...info };
  }

  /** Check an image/ISO imported by the user */
  inspectImage(file) {
    const size = fileSize(file);
    if (!size) throw new Error(t('The file does not exist or is empty'));
    const fd = fs.openSync(file, 'r');
    const head4 = Buffer.alloc(4);
    fs.readSync(fd, head4, 0, 4, 0);
    fs.closeSync(fd);
    const magic = head4.toString('hex');
    let kind = 'unknown';
    if (magic === '514649fb') kind = 'qcow2';
    else if (head4.toString('ascii', 0, 4) === 'KDMV') kind = 'vmdk';
    else if (size > 400 * 1024 * 1024 && magic !== '00000000') kind = 'raw-or-iso';
    return { kind, size, path: file };
  }

  importIso(file) {
    const info = this.inspectIso(file);
    if (!info.ok) {
      const e = new Error(info.reason || t('The image file is unusable'));
      e.invalidIso = true;
      throw e;
    }
    store.saveSettings({ runtime: { isoPath: file } });
    return { ok: true, ...info };
  }

  importDisk(file) {
    const info = this.inspectImage(file);
    store.saveSettings({ runtime: { diskPath: file } });
    return { ok: true, ...info };
  }

  // ---------------- Virtual disk ----------------

  async createDisk(sizeGB = 24, onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.diskPath || p.disk;
    if (fileSize(dest) > MIN_SIZE.disk) return { ok: true, path: dest, existed: true };

    onProgress({ stage: 'disk', message: t('Creating a {size} GB virtual disk…', { size: sizeGB }), percent: 40 });
    const qemuImg = fs.existsSync(p.qemuImg)
      ? p.qemuImg
      : path.join(path.dirname(store.getSettings().runtime.qemuPath || ''), 'qemu-img.exe');

    const tool = fs.existsSync(qemuImg) ? qemuImg : null;
    if (tool) {
      const r = await run(tool, ['create', '-f', 'qcow2', dest, `${sizeGB}G`], { timeout: 120000 });
      if (!r.ok) throw new Error(t('qemu-img failed to create the virtual disk: {error}', { error: r.stderr || r.stdout }));
    } else {
      throw new Error(t('qemu-img.exe not found. Install QEMU first.'));
    }
    store.saveSettings({ runtime: { diskPath: dest } });
    onProgress({ stage: 'done', message: t('Virtual disk created'), percent: 100, path: dest });
    return { ok: true, path: dest, size: fileSize(dest) };
  }

  // ---------------- Source reachability check ----------------

  async probeSources() {
    const [adb, qemu, iso] = await Promise.all([
      head(SOURCES.adb[0]),
      head(SOURCES.qemuFallback[0]),
      head(SOURCES.iso[0]),
    ]);
    return { adb, qemu, iso };
  }
}

module.exports = { Provisioner, SOURCES, MIN_SIZE, absUrl, baseOf };
