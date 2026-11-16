'use strict';
/**
 * Local persistence: app list + settings.
 * Data folder: %APPDATA%\apkstart
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'apkstart');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const APK_DIR = path.join(DATA_DIR, 'apks');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

/** Settings that older versions wrote and this edition no longer uses (dropped on load). */
const REMOVED_RUNTIME_KEYS = ['sourcePreference', 'autoMirror', 'giteeToken'];

const DEFAULT_SETTINGS = {
  adbPath: '',
  device: '127.0.0.1:5555',
  engine: {
    mode: 'builtin',         // builtin (bundled runtime, default) | attach (connect to an existing runtime, advanced)
    qemuPath: '',
    systemImage: '',
    memoryMB: 0,             // 0 = doctor picks based on the machine's RAM
    cores: 0,                // 0 = auto
    autoMemory: true,        // zero-config: derive memory/cores/disk/render settings automatically
    idleShutdownMinutes: 15,
    startVisible: true,
    // Must have a window: headless SurfaceFlinger produces no VSYNC, so apps run but nothing
    // shows. The windowed emulator gives native 60 fps + mouse/keyboard; ApkStart just
    // dresses it up as an app window.
    headless: false,
    gpuMode: 'auto',         // auto = pick a backend by emulator version and step down on failure
    // Render backend that crashed on launch last time (`<emulator version>|<gpu>`); in auto
    // mode it goes last next time, so we don't wait 20+ s before falling back to software
    // rendering on every boot. Upgrading the runtime invalidates it.
    badGpu: '',
    forceTcg: false,         // kept for advanced troubleshooting; doctor already falls back automatically
    audio: true,             // Android app sound (notifications/video). Turning it off saves a little CPU
    // ---- Lightweight container (all on by default to save resources; each can be turned off) ----
    liteMode: true,          // cap the vCPU quota so qemu doesn't saturate physical cores and slow Windows
    // One-word policy: save / balanced / smooth (video and games first).
    // The UI only exposes this option; saving translates it into liteMode / priorityMode /
    // renderSize. The individual switches stay available for advanced users.
    resourceMode: 'balanced',
    // Data partition size (GB): apps, game caches and their updates live here.
    // 0 = auto (6/8 GB depending on free disk). Raising it grows the partition in place
    // the next time Android starts, without losing installed apps.
    dataPartitionGB: 0,
    // Render resolution: lower = smoother and less power; auto = 720x1280 / 540x960 by acceleration
    renderSize: 'auto',
    // Faster DNS: give the emulator public DNS servers. Android's default 10.0.2.3 goes
    // through the host's DNS, which under VPNs / corporate networks / some ISPs can take
    // hundreds of ms, making the first screen of video apps stutter.
    fastDns: true,
    // Snapshot: the quickboot RAM snapshot makes later starts take seconds, at the cost of a
    // ~2-3 GB ram.bin on disk. Turn off when disk is tight (affects start speed only, not app data).
    keepSnapshot: true,
    // Log size cap (KB): roll over to a backup when exceeded so long use doesn't fill the disk
    logLimitKB: 2048,
    // Mouse mapping: left click is mapped natively by the emulator, no switch needed.
    // Right-click back and smooth wheel need a low-level hook, installed only while an app
    // window is in the foreground and removed when it loses focus.
    mouseRightBack: true,    // right click = Android Back (stops Qt treating right click as a tap)
    mouseWheelMode: 'smooth', // smooth = merge into one injected swipe | native = leave to Qt | off = ignore
    mouseSideButtons: false, // side buttons for Back/Forward: off by default
    deepTrim: false,         // aggressively trim system background packages (Play Store/setup wizard); off by default
    // balanced = yield to the foreground | performance = qemu Normal | game = qemu High + low-latency input
    priorityMode: 'balanced',
    // Prewarm: boot the Android environment in the background after ApkStart starts, so the
    // first app opens almost instantly. Costs about 1 GB of resident memory; can be turned off.
    prewarm: true,
  },
  runtime: {
    dir: '',                 // empty = %APPDATA%\apkstart\runtime
    qemuUrl: '',             // custom QEMU installer URL
    isoUrl: '',              // custom system image URL
    isoPath: '',             // system image (ISO) path
    diskPath: '',            // virtual disk the system is installed on
    diskSizeGB: 24,
    headless: false,         // hide the VM window (debugging only)
    installMode: 'guided',   // guided (manual install with guidance) | auto (experimental automatic install)
    emulatorUrl: '',         // custom emulator package URL (empty = resolve the latest from the SDK index)
    sysimgUrl: '',           // custom system image package URL
    compatImage: false,      // ARM compatibility: use the Google Play image (built-in native bridge for ARM-only apps)
    deployFailedAt: 0,       // timestamp of the last failed auto-deploy (0 = none); no auto re-download for 30 min after
    // Lite build runtime pack: from the update repo's GitHub releases (same place as app
    // updates), falling back to per-component downloads from dl.google.com. Set
    // runtimePackUrl to use your own copy instead.
    preferGithubRuntime: true,
    runtimePackUrl: '',
    // Optional download mirror prefix for GitHub release files. Empty = direct
    // (still uses 8-way chunked downloads to fill the bandwidth).
    mirrorPrefix: '',
    // Download connections for chunked downloads. Default 8; try 16 on slow or throttled links.
    downloadConnections: 8,
  },
  sharedDir: path.join(os.homedir(), 'ApkStartShared'),
  deviceSharedDir: '/sdcard/ApkStartShared',
  autoConnect: true,
  createShortcutOnInstall: true,
  createStartMenuShortcut: true, // Start menu shortcut = apps show up in Windows search
  shortcutDir: '',           // empty = desktop
  freeform: false,           // share one runtime window instead of Android freeform windows
  hideAfterLaunch: false,    // the main process must stay alive, or exiting kills the Android runtime
  notifyOnInstall: true,
  autoStart: false,          // start with Windows: off unless the user turns it on
  language: 'auto',          // 'auto' (follow Windows) | 'en' | 'ar'
  autoDeploy: true,          // first run sets everything up automatically, no step-by-step wizard
  // Welcome card: lastDate = date it last popped up on its own (at most once a day);
  // disabled = the user ticked "don't show again".
  welcome: { lastDate: '', disabled: false },
  display: {
    mode: 'window',          // window (portrait, freely resizable) | fullscreen (fit the screen)
    portrait: '900x1600',    // portrait resolution in window mode, adjustable in Settings
    density: 0,              // 0 = derive from resolution
    rememberBounds: true,    // remember each app's window position/size
    autoFullscreenOnLaunch: false,
    // Landscape = switch the AVD panel to 1280x720 and reboot (the only way to get it upright
    // and filling the window). Persisted here so ApkStart boots in this orientation next time.
    landscape: false,
  },
};

function ensureDirs() {
  for (const d of [DATA_DIR, ICON_DIR, APK_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    // Strip a UTF-8 BOM. With one, JSON.parse throws and all settings silently fall back to
    // defaults ("my settings are gone"). The file may be edited by hand or by sync tools.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDirs();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Resource policy -> concrete switches.
 *   save     : 2 vCPU + low priority + 540x960, for old laptops / leaving it running;
 *   balanced : half the physical cores (2-4) + yield to the foreground + 720x1280;
 *   smooth   : no vCPU cap + same priority as the foreground + 720x1280, video and games first.
 * No 1080p for now: the quickboot snapshot is tied to the resolution, so every change means
 * a cold boot, and 720p looks the same in a phone-shaped window while performing a tier better.
 */
function resourcePreset(mode) {
  switch (String(mode || '')) {
    case 'save':
      return { resourceMode: 'save', liteMode: true, priorityMode: 'balanced', renderSize: '540x960' };
    case 'smooth':
      return { resourceMode: 'smooth', liteMode: false, priorityMode: 'game', renderSize: '720x1280' };
    case 'balanced':
    default:
      return { resourceMode: 'balanced', liteMode: true, priorityMode: 'balanced', renderSize: 'auto' };
  }
}

const store = {
  DATA_DIR, ICON_DIR, APK_DIR,

  getSettings() {
    const s = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
    // Older versions defaulted to headless: apps started but had no window, i.e. "won't open".
    // Always migrate to windowed mode, and don't let old settings turn it off.
    s.engine.headless = false;
    // Older versions killed the whole Android runtime when the shell exited, so desktop
    // shortcuts flashed and closed.
    s.hideAfterLaunch = false;
    // Older versions used Android freeform windows; now the whole emulator window is the app
    // window and the app must fill it, or you get a window inside a window.
    s.freeform = false;
    // Drop settings this edition removed (e.g. a stored Gitee token), so the next save
    // doesn't write them back.
    if (s.runtime && typeof s.runtime === 'object') {
      for (const k of REMOVED_RUNTIME_KEYS) delete s.runtime[k];
    }
    return s;
  },

  saveSettings(patch) {
    const next = deepMerge(this.getSettings(), patch);
    // Only the resource policy changed: translate it into the three switches so the two
    // representations never disagree
    if (patch && patch.engine && patch.engine.resourceMode) {
      Object.assign(next.engine, resourcePreset(next.engine.resourceMode));
    }
    if (next.runtime && typeof next.runtime === 'object') {
      for (const k of REMOVED_RUNTIME_KEYS) delete next.runtime[k];
    }
    writeJson(SETTINGS_FILE, next);
    return next;
  },

  getApps() {
    const data = readJson(APPS_FILE, { apps: [] });
    return Array.isArray(data.apps) ? data.apps : [];
  },

  saveApps(apps) {
    writeJson(APPS_FILE, { apps });
  },

  upsertApp(app) {
    const apps = this.getApps();
    const i = apps.findIndex((a) => a.package === app.package);
    if (i >= 0) apps[i] = { ...apps[i], ...app };
    else apps.push(app);
    this.saveApps(apps);
    return app;
  },

  removeApp(pkg) {
    const apps = this.getApps().filter((a) => a.package !== pkg);
    this.saveApps(apps);
  },

  getApp(pkg) {
    return this.getApps().find((a) => a.package === pkg) || null;
  },

  iconPath(pkg) {
    return path.join(ICON_DIR, `${pkg}.png`);
  },

  apkPath(pkg, version = 'cur') {
    return path.join(APK_DIR, `${pkg}-${version}.apk`);
  },

  ensureDirs,
  DEFAULT_SETTINGS,
};

module.exports = store;
