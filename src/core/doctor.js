'use strict';
/**
 * Device adaptation / automatic diagnosis (the zero-config base).
 *
 * Goal: no machine should ever need the user to tune parameters.
 *  - chooseProfile()  derives launch parameters from RAM, CPU, disk, acceleration and emulator version;
 *  - planVariants()   the fallback ladder after a failed boot (GPU -> acceleration -> memory -> cold boot);
 *  - diagnose()       turns the emulator's stderr into actionable advice;
 *  - shortPath()      handles non-ASCII / space-containing install paths (QEMU is very sensitive to them).
 *
 * Pure functions plus read-only probes: no settings writes, never starts Android, easy to unit test.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { t } = require('../i18n');

const ASCII = /^[\x20-\x7e]*$/;
const isAsciiPath = (p) => ASCII.test(String(p || ''));

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/** Host profile (milliseconds, read-only) */
function hostInfo() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const freeMB = Math.round(os.freemem() / 1048576);
  const cores = Math.max(1, (os.cpus() || []).length || 2);
  const home = os.homedir();
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB,
    freeMB,
    cores,
    home,
    homeAscii: isAsciiPath(home),
    tmp: os.tmpdir(),
    rdp: /RDP/i.test(String(process.env.SESSIONNAME || '')) || !!process.env.CLIENTNAME,
  };
}

/** Free space (MB) on the drive holding dir; 0 if unknown */
function freeDiskMB(dir) {
  try {
    let d = path.resolve(dir || '.');
    for (let i = 0; i < 6 && !fs.existsSync(d); i += 1) d = path.dirname(d);
    const st = fs.statfsSync(d);
    return Math.floor((st.bavail * st.bsize) / 1048576);
  } catch (_) {
    return 0;
  }
}

function versionNumbers(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/**
 * Since emulator 36.4.9 swiftshader_indirect is deprecated and -gpu software was added.
 * On 37.x, passing swiftshader_indirect can fail GL init or exit outright (varies a lot by device).
 * So candidates must be picked by version, and every candidate needs a fallback.
 */
function gpuCandidates(emulatorVersion) {
  const [major, minor, patch] = versionNumbers(emulatorVersion);
  const modern = major > 36 || (major === 36 && (minor > 4 || (minor === 4 && patch >= 9)));
  return modern
    // Order = auto mode's try order:
    // 1) host        - real GPU rendering, lowest CPU, most responsive;
    // 2) swangle     - ANGLE on top of SwiftShader. Much friendlier to Android WebView compositing
    //                  than bare software/swiftshader (apps that go black after the consent screen
    //                  are bare software rendering failing WebView compositing), so it comes second;
    // 3) software    - plain SwiftShader fallback; compatible, but WebView compositing often goes black;
    // 4) swiftshader - legacy name fallback.
    // Note safeGpu (the TCG fallback with acceleration off) still uses software: slow but most compatible.
    ? ['host', 'swangle', 'software', 'swiftshader']
    : ['host', 'swiftshader_indirect', 'swiftshader'];
}

/**
 * Screen spec. landscape=true gives a real landscape panel (1280x720).
 *
 * Why the panel size must change instead of a runtime `wm size`: the emulator LCD is the
 * "physical panel"; Qt sizes its window to the panel and draws the frame in the top-left.
 * A runtime `wm size` only changes Android's logical resolution while the panel stays
 * portrait - the result is a picture rotated 90 degrees in a strip at the top-left, black
 * borders everywhere and misaligned taps. Only swapping hw.lcd.width/height and restarting
 * gives an upright, full-window landscape.
 */
function lcdFor({ accelOk = true, crisp = true, landscape = false } = {}) {
  const base = accelOk && crisp ? { w: 720, h: 1280, dpi: 320 } : { w: 540, h: 960, dpi: 240 };
  return landscape ? { w: base.h, h: base.w, dpi: base.dpi } : base;
}

/** Windows 8.3 short path: the emulator cannot find files under a non-ASCII user name / install folder */
function shortPath(p) {
  if (process.platform !== 'win32' || !p || isAsciiPath(p)) return p;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (line && isAsciiPath(line) && fs.existsSync(line)) return line;
  } catch (_) { /* 8.3 names disabled: keep the original path */ }
  return p;
}

/**
 * "Lite container" quota: constrain only what hurts host responsiveness most - the vCPU count.
 *
 * The old logic gave a 16-core machine 4 cores; qemu's 4 vCPU threads kept physical cores
 * busy and the Windows desktop, mouse and browser fought over what was left ("it lags as
 * soon as it opens"). Two vCPUs are plenty for one Android app; more only slows the host.
 *
 * Memory and resolution are deliberately untouched: memory is already capped at 2-3 GB, and
 * lowering the resolution changes the quickboot snapshot fingerprint, forcing a cold boot on
 * every mode switch.
 *
 * Pure function; returns null when lite mode is off (keeps old callers / tests unchanged).
 */
function liteProfile({ host = hostInfo(), engine = {} } = {}) {
  if (engine && engine.liteMode === false) return null;
  const cores = engine && engine.resourceMode === 'save'
    ? 2
    // The old floor(cores/4) clamped to 2-3 gave an 8-core machine only 2 vCPUs, and
    // software-decoded video turned into a slideshow. Now: half the physical cores, max 4
    // (8 cores -> 4, 4 cores -> 2); the desktop keeps spare cores and video stays smooth.
    : clamp(Math.floor((host.cores || 2) / 2), 2, 4);
  return { cores, priority: 'below' };
}

/**
 * Derive zero-config launch parameters.
 * Explicit engine.memoryMB / cores / gpuMode in settings act as caps/overrides, but an unset
 * value no longer falls back to a hard-coded 4 GB / 4 cores that breaks low-memory machines.
 */
function chooseProfile({
  host = hostInfo(), accel, emulatorVersion = '', diskMB = 0,
  port = 5554, adbPort = 5044, overrides = {}, settings = null,
} = {}) {
  const accelOk = !!(accel && accel.ok);
  // 3 GB is enough for Android 14 and mainstream apps; more only inflates RAM use and snapshot size
  let memoryMB = clamp(Math.floor((host.totalMB * 0.22) / 256) * 256, 2048, 3072);
  // "Save resources" mode: light workloads (video, reading) don't need 3 GB, cap at 2 GB.
  // That saves about 1 GB of resident qemu memory and 1 GB of quickboot snapshot.
  // Only applies when the user did not set memory manually; a manual value always wins.
  const rmode = settings && settings.engine && settings.engine.resourceMode;
  if (rmode === 'save' && !overrides.memoryMB) {
    memoryMB = clamp(memoryMB, 2048, 2048);
  }
  // Lower it when free physical memory is short; Android 14 needs at least 2 GB, below that only slow TCG works
  if (host.freeMB && host.freeMB < memoryMB + 1024) {
    memoryMB = Math.max(2048, Math.floor((host.freeMB * 0.5) / 256) * 256);
  }
  if (overrides.memoryMB) memoryMB = clamp(Number(overrides.memoryMB) || memoryMB, 1536, 8192);

  let cores = clamp(Math.floor(host.cores / 2), 2, 4);
  if (overrides.cores) cores = clamp(Number(overrides.cores) || cores, 1, 8);
  // Lite mode only narrows cores when the user did not set them manually
  const lite = settings ? liteProfile({ host, engine: settings.engine || {} }) : null;
  if (lite && !overrides.cores) cores = Math.min(cores, lite.cores);

  const disk = diskMB || freeDiskMB(host.tmp);
  // /data size: apps, game asset packs and their updates all live here, and 4 GB fills up fast
  // (in-app updates report "not enough storage"). Default to 6 GB when the disk allows;
  // users can set it in Settings (growing it resizes in place on next boot, no data loss).
  const wantGB = Number((settings && settings.engine && settings.engine.dataPartitionGB) || 0);
  const autoDataMB = disk && disk < 12288 ? 4096 : 6144;
  const dataMB = wantGB > 0 ? clamp(Math.round(wantGB * 1024), 2048, 65536) : autoDataMB;

  const gpus = gpuCandidates(emulatorVersion);
  const gpu = overrides.gpuMode && gpus.includes(overrides.gpuMode) ? overrides.gpuMode : gpus[0];

  // Render resolution: in auto mode pick by acceleration (software emulation drops to 540x960).
  // Orientation first: landscape is decided by the physical panel size, which must be written
  // into the AVD and needs a restart, so settings.display.landscape is applied before renderSize.
  const wantLandscape = !!(settings && settings.display && settings.display.landscape);
  const wantLcd = String((settings && settings.engine && settings.engine.renderSize) || 'auto');
  const lcd = /^\d{3,4}x\d{3,4}$/.test(wantLcd)
    ? (() => {
      const [w0, h0] = wantLcd.split('x').map(Number);
      // If an explicit resolution disagrees with the orientation, fix it (landscape: long side is width)
      const long = Math.max(w0, h0);
      const short = Math.min(w0, h0);
      const w = wantLandscape ? long : short;
      const h = wantLandscape ? short : long;
      return { w, h, dpi: short <= 540 ? 240 : (short <= 720 ? 320 : 420) };
    })()
    : lcdFor({ accelOk, landscape: wantLandscape });

  return {
    memoryMB,
    cores,
    heapMB: memoryMB >= 3072 ? 384 : 256,
    dataMB,
    lcd,
    gpu,
    gpuCandidates: gpus,
    accel: accelOk ? 'auto' : 'off',
    accelOk,
    port,
    adbPort,
    snapshot: true,
    lite: !!lite,
    // Pure software emulation does boot on Windows, but an Android 14 cold boot can take 5-10 minutes
    bootTimeoutMs: accelOk ? 240000 : 600000,
    emulatorVersion,
    host,
  };
}

/**
 * Turn the "advanced" settings into overrides.
 * 0 / auto / unset all mean "don't override" and keep auto-derivation;
 * values apply only when the user turned off auto memory and entered numbers.
 */
function overridesFromSettings(engine = {}) {
  const e = engine || {};
  const manual = e.autoMemory === false;
  return {
    memoryMB: manual ? Number(e.memoryMB) || 0 : 0,
    cores: manual ? Number(e.cores) || 0 : 0,
    gpuMode: e.gpuMode && e.gpuMode !== 'auto' ? e.gpuMode : '',
  };
}

/**
 * Single entry point for display / diagnosis: computes the same parameters as a real boot
 * without starting Android. The settings page used to call chooseProfile() without version
 * and acceleration info, so on 37.x it wrongly showed the deprecated swiftshader_indirect /
 * software emulation, which did not match what actually ran.
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044 } = {}) {
  return chooseProfile({
    accel, emulatorVersion, diskMB, port, adbPort, settings,
    overrides: overridesFromSettings(settings && settings.engine),
  });
}

/**
 * Retry matrix after a failure, from best to most conservative, at most 4 attempts:
 * switch GPU backend -> turn off hardware acceleration (TCG) -> lower memory and cold boot.
 */
function planVariants(profile) {
  const out = [];
  const gpus = profile.gpuCandidates || [];
  const firstGpu = profile.gpu || gpus[0] || 'software';
  const safeGpu = gpus.find((g) => /software|swiftshader/.test(g)) || firstGpu;
  const ordered = [firstGpu, ...gpus.filter((g) => g !== firstGpu && /swiftshader|swangle/.test(g))].slice(0, 2);
  for (const gpu of ordered) {
    out.push({ ...profile, gpu, label: `${gpu} / ${profile.accel === 'auto' ? t('hardware acceleration') : t('software emulation')}`, wipe: false, snapshot: true });
  }
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    label: t('Software emulation without acceleration (slow, but most compatible)'),
    wipe: false,
    snapshot: false,
  });
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    memoryMB: 2048,
    cores: 2,
    dataMB: Math.min(profile.dataMB, 2048),
    label: t('Safe cold boot (minimum memory, no snapshot)'),
    // This must NEVER wipe. It used to be wipe:true, and when the disk was full every attempt
    // failed, so the retries wiped the snapshot and user data, taking installed apps and saves
    // with them ("disk got full, then all my ApkStart apps were gone").
    // ensureDataPartition decides when userdata must be rebuilt (only when the image is damaged),
    // not a -wipe-data launch flag.
    wipe: false,
    snapshot: false,
    lastResort: true,
  });
  // De-duplicate (same gpu/accel/wipe combo is not retried), but keep the last resort:
  // it is the only no-snapshot plan and may equal the previous one on low-memory machines.
  const seen = new Set();
  return out.filter((v) => {
    const k = `${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}|${v.lastResort ? 'last' : ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Find a free port pair (emulator console + adb registration must be adjacent even/odd) */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function freePortPair(start = 5554) {
  for (let p = start; p <= start + 40; p += 2) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p) && await isPortFree(p + 1)) return p;
  }
  return start;
}

/**
 * adb server port: fixed, not probed.
 * It used to search upward from 5044 for a free port, but the adb server is a resident
 * process holding that port, so every ApkStart start spawned another adb server (6 in one
 * session), and the port kept changing, so the next start could not take over the emulator.
 * 5044 is ApkStart's own port (the user's own adb uses 5037), so just use it.
 */
async function freeAdbPort(start = 5044) {
  return Number(process.env.APKSTART_ADB_PORT) || start;
}

/**
 * Quickboot snapshot fingerprint: only these changes invalidate an old snapshot (black screen /
 * won't boot after loading). Image / engine version only.
 *
 * Deliberately excludes GPU, acceleration and memory: auto-retry switches those often, and
 * including them would trigger -wipe-data on every retry and clear installed apps.
 *
 * Deliberately excludes dataMB: an old snapshot still works after the data partition grows
 * (qemu remounts at the new size). Including it meant "I only wanted more space, and got a
 * dead snapshot + cold boot + deleted data" - we hit that once and lost every app.
 */
function snapshotKey(plan, imageDir) {
  return crypto.createHash('sha1').update([
    imageIdentity(imageDir), plan.emulatorVersion || '', plan.api || '', plan.tag || '',
  ].join('|')).digest('hex').slice(0, 16);
}

/**
 * System image "identity": only the part after `system-images/`.
 *
 * Which drive the image lives on doesn't matter; the same image in another folder must not
 * count as "a different image". Otherwise moving the runtime from C: to D: (which our own
 * Settings recommends) makes the AVD sysdir mismatch -> image considered changed -> -wipe-data
 * -> installed apps gone. This really happened, so both places (AVD config, snapshot key)
 * must use the identity, not the absolute path.
 */
function imageIdentity(dir) {
  const p = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const i = p.indexOf('system-images/');
  if (i >= 0) return p.slice(i);
  return p.split('/').slice(-3).join('/');
}

// title / hint are English source strings; diagnose() translates them at lookup time.
const RULES = [
  {
    code: 'ACCESS_VIOLATION',
    // emulator/qemu on Windows exits with 0xC0000005 (decimal 3221225477): in practice usually
    // the graphics driver / Vulkan backend crashing right as the guest starts, unrelated to
    // CPU, memory or image (switching to -gpu software on the same machine often fixes it).
    // Must come before GPU_INIT: crash logs usually also contain renderer init lines.
    re: /emulator exit 3221225477|exit code 3221225477|0xC0000005|STATUS_ACCESS_VIOLATION/i,
    title: 'Renderer crashed (0xC0000005 access violation)',
    hint: 'Retrying automatically with a more conservative renderer; this one will not be tried first next time. If it keeps happening, update your graphics driver, or lower the quality in Settings → Performance & resources and turn off Remote Desktop / VM GPU passthrough, then try again.',
  },
  {
    code: 'GPU_INIT',
    // Only match failure context: normal logs also mention Vulkan/EGL/ANGLE and must not be treated as fatal
    re: /Failed to initialize GL emulation|Could not initialize (OpenGL|emulated framebuffer)|Failed to create .*GLES|EGL_(BAD|NOT_INITIALIZED|CONTEXT_LOST)|Failed to (load|initialize) .*vulkan|vulkan.*(failed|error)|ANGLE.*(fail|error)/i,
    title: 'Graphics renderer failed to initialize',
    hint: 'Retrying automatically with software rendering. If it still fails, update your graphics driver, or turn off Remote Desktop / VM GPU passthrough and try again.',
  },
  {
    code: 'GPU_MODE',
    re: /Unknown option|invalid .*-gpu|Unrecognized .*gpu|Unsupported gpu/i,
    title: 'This runtime does not accept that GPU mode',
    hint: 'Retrying automatically with a GPU mode that matches the runtime version (swiftshader_indirect on older versions, software on newer ones).',
  },
  {
    code: 'ACCEL',
    re: /x86_64 emulation currently requires hardware acceleration|acceleration.*not (installed|available|supported)|WHPX.*(not|failed)|AEHD.*(not|failed)|ERROR_ACCESS_DENIED/i,
    title: 'Hardware acceleration is not available',
    hint: 'Fell back to software emulation (the first start will be much slower). For smooth performance, turn on "Virtual Machine Platform" in Windows Features, or install the AEHD driver, then restart your PC.',
  },
  {
    code: 'MEMORY',
    re: /Cannot allocate memory|not enough memory|commit charge|Failed to allocate|out of memory/i,
    title: 'Memory allocation failed',
    hint: 'Automatically lowered the memory and cores given to Android. Close memory-hungry programs and try again.',
  },
  {
    code: 'PORT_BUSY',
    re: /port.*(in use|busy)|Address already in use|bind.*failed|Failed to (setup|bind) .*console/i,
    title: 'Emulator port is in use',
    hint: 'Switched to a free port automatically. If it keeps happening, quit other emulators (Nox, MuMu, BlueStacks, etc.) or restart your PC.',
  },
  {
    code: 'AVD_LOCK',
    re: /already running|lock file|\.lock|AVD is in use|emulator is running/i,
    title: 'A lock file was left over from the last run',
    hint: 'Cleared the AVD lock files and restarted automatically.',
  },
  {
    code: 'IMAGE',
    re: /system\.img.*(missing|not found|corrupt)|kernel-ranchu.*(missing|not found)|invalid magic|Failed to open .*\.img|APEX.*(fail|error|loop)|boot loop|verity.*fail/i,
    title: 'System image is missing or damaged, or incompatible with old user data',
    hint: 'Restarting automatically with clean user data. If it still fails, delete the image under "Runtime" and download it again.',
  },
  {
    code: 'DLL',
    re: /0xc0000135|STATUS_DLL_NOT_FOUND|missing DLL|Qt6.*not found|MSVCP140|VCRUNTIME|can't start because|The code execution cannot proceed/i,
    title: 'Runtime files were removed by antivirus, or the VC++ runtime is missing',
    hint: 'Add the ApkStart folder to your antivirus exclusions, extract the package again, and install the Microsoft Visual C++ 2015-2022 Redistributable.',
  },
  {
    code: 'DISK_FULL',
    re: /No space left|disk full|not enough space/i,
    title: 'Not enough disk space to start Android',
    hint: 'Move the runtime folder (Settings → System integration → Runtime data folder) to a drive with more space, or turn off "Keep Quick Boot snapshot" / shrink the data partition in Settings. Android data is never deleted automatically.',
  },
  {
    code: 'NON_ASCII',
    re: /Unicode|non-ASCII|cannot find the path/i,
    title: 'The install path contains non-English or special characters',
    hint: 'Switched to the Windows short path automatically. If it still fails, move ApkStart to a folder with an English-only path (such as C:\\ApkStart).',
  },
  {
    // After a forced kill the AVD folder keeps hardware-qemu.ini.lock / multiinstance.lock and
    // the emulator refuses to start with a message easily misread as a CPU problem. Must precede CPU rules.
    code: 'AVD_LOCK',
    re: /Running multiple emulators with the same AVD|AVD .*is already running|hardware-qemu\.ini\.lock/i,
    title: 'The last run did not exit cleanly and left lock files behind',
    hint: 'ApkStart clears stale locks and retries automatically. If it keeps happening, check whether another emulator is using the same runtime.',
  },
  {
    code: 'CPU_FEATURE',
    re: /host doesn't support requested feature|CPUID.*not supported|unsupported CPU|missing.*(AVX|SSE4|xsave)/i,
    title: 'The CPU lacks an instruction set the runtime needs',
    hint: 'On some older CPUs this is only a warning and Android still boots. If it really will not start, switch the engine under "Runtime" to an older compatible version, or use a PC that supports VT-x/AVX.',
  },

  {
    code: 'SNAPSHOT',
    re: /snapshot|Quick Boot|ram\.img|Saving state/i,
    title: 'Quick Boot snapshot is damaged',
    hint: 'Discarded the old snapshot and cold-booted automatically; a new snapshot is saved the next time Android exits normally.',
  },
];

/** Turn the log into {code,title,hint} for the UI and auto-retry decisions */
function diagnose(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || '')).slice(-24000);
  for (const r of RULES) {
    if (r.re.test(text)) return { code: r.code, title: t(r.title), hint: t(r.hint) };
  }
  return {
    code: 'UNKNOWN',
    title: t('The runtime did not finish booting'),
    hint: t('Retried automatically with several parameter combinations. Click "Export diagnostic report" to send the log to the author.'),
  };
}

/** One-line human-readable summary, shown in Settings so advanced users see what was picked */
function describeProfile(p) {
  return t('Auto: {mem} GB RAM · {cores} cores · {gpu} renderer · {accel} · {boot}{lite} · port {port}', {
    mem: (p.memoryMB / 1024).toFixed(1),
    cores: p.cores,
    gpu: p.gpu,
    accel: p.accelOk ? t('hardware acceleration') : t('software emulation'),
    boot: p.snapshot ? t('on-demand snapshot') : t('cold boot'),
    lite: p.lite ? ` · ${t('lite container')}` : '',
    port: p.port,
  });
}

/** Export a diagnostic report (plain text, easy to email / paste into an issue) */
function writeReport({ dataDir, profile, logLines = [], extra = {} }) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const d = diagnose(logLines);
  const body = [
    'ApkStart diagnostic report',
    `Generated: ${new Date().toLocaleString()}`,
    '',
    '== Host ==',
    JSON.stringify(hostInfo(), null, 2),
    '',
    '== Auto profile ==',
    JSON.stringify(profile || {}, null, 2),
    describeProfile(profile || chooseProfile()),
    '',
    '== Diagnosis ==',
    `${d.code}: ${d.title}`,
    d.hint,
    '',
    '== Extra ==',
    JSON.stringify(extra, null, 2),
    '',
    '== Runtime log (last 300 lines) ==',
    ...(Array.isArray(logLines) ? logLines.slice(-300) : String(logLines || '').split('\n')),
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { file, diagnosis: d };
}

/**
 * Check whether the Microsoft VC++ 2015-2022 x64 runtime is installed.
 * The Android emulator (Qt6) and qemu both need it; without it they fail to start on other
 * machines (0xc0000135 / MSVCP140 missing). The installer bundles vc_redist.x64.exe; this
 * only detects, so we can show a clear message and a one-click install before launch.
 */
function vcRedistOk() {
  if (process.platform !== 'win32') return true;
  // Check the DLLs first: msvcp140 / vcruntime140 are exactly what Qt6 and qemu load.
  // A file check avoids spawning reg.exe (some security tools block it, and it slows the
  // 60 s self-check) and doesn't false-alarm when a cleaner tool deleted the registry key.
  const sys = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  try {
    if (fs.existsSync(path.join(sys, 'msvcp140.dll'))
      && fs.existsSync(path.join(sys, 'vcruntime140.dll'))) return true;
  } catch (_) { /* fall back to the registry */ }

  const key = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  for (const k of [key, key.replace('SOFTWARE\\', 'SOFTWARE\\WOW6432Node\\')]) {
    try {
      const out = execFileSync('reg', ['query', k, '/v', 'Installed'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/Installed\s+REG_DWORD\s+0x1/i.test(out)) return true;
    } catch (_) { /* key missing = not installed */ }
  }
  return false;
}

module.exports = {
  hostInfo, freeDiskMB, isAsciiPath, shortPath, lcdFor, liteProfile,
  versionNumbers, gpuCandidates, chooseProfile, planVariants,
  overridesFromSettings, autoProfile,
  freePortPair, freeAdbPort, snapshotKey, imageIdentity,
  diagnose, describeProfile, writeReport, vcRedistOk,
};
