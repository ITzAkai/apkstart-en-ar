'use strict';
/**
 * Portable packaging: produces dist/ApkStart-win64-portable/
 *   ApkStart.exe (renamed electron.exe) + resources/app (this app's source)
 * No installer needed, just unzip and run; an electron-builder installer can reuse the same layout.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Output folder can be overridden (e.g. when the target is locked by a running instance: build elsewhere, then swap)
let OUT = process.env.APKSTART_PACK_OUT
  ? path.resolve(process.env.APKSTART_PACK_OUT)
  : path.join(ROOT, 'dist', 'ApkStart-win64-portable');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

console.log('Packing portable edition ->', OUT);
// Don't delete an existing target tree: some setups block bulk deletes, and a failed pack
// would lose the last working build. Rename the old folder instead; if it's locked, use another folder.
if (fs.existsSync(OUT)) {
  try {
    const backup = `${OUT}.prev-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(OUT, backup);
    console.log('Previous build kept ->', backup);
  } catch (_) {
    // Antivirus / search indexer / Explorer can hold the folder handle for a long time, so the
    // rename fails with EBUSY; fall back to a versioned folder name, which works just as well.
    OUT = path.join(ROOT, 'dist', `ApkStart-v${require(path.join(ROOT, 'package.json')).version}-win64-portable`);
    console.log('Old folder is locked, writing to ->', OUT);
  }
}
fs.mkdirSync(path.join(OUT, 'resources', 'app'), { recursive: true });

// 1. Electron runtime
console.log('Copying Electron runtime...');
copy(ELECTRON_DIST, OUT);
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

// 1.1 Locale slimming: Electron ships 55 locales (41MB in total); the UI is English and Arabic only.
//     Keep en-US / ar and delete the rest.
const KEEP_LOCALES = new Set(['en-US.pak', 'ar.pak']);
let localeSaved = 0;
try {
  const locDir = path.join(OUT, 'locales');
  for (const f of fs.readdirSync(locDir)) {
    if (KEEP_LOCALES.has(f)) continue;
    localeSaved += (() => { try { return fs.statSync(path.join(locDir, f)).size; } catch (_) { return 0; } })();
    fs.rmSync(path.join(locDir, f), { force: true });
  }
} catch (_) { /* no locales folder: nothing to do */ }

// 1.2 Files nobody opens: changelog backups, unused descriptors
for (const rel of ['LICENSES.chromium.html.bak', 'vk_swiftshader_icd.json.bak']) {
  fs.rmSync(path.join(OUT, rel), { force: true });
}

// 1.3 Removable runtime libraries:
//     d3dcompiler_47.dll compiles ANGLE's HLSL to GPU code, but Windows 8.1+ ships the same DLL
//     in System32, so LoadLibrary falls back to the system copy when the bundled one is missing.
//     Tested: UI, icons and fonts render the same (--smoke screenshots identical). Saves 2.1MB compressed.
//     Note: vk_swiftshader.dll / vulkan-1.dll must stay: Chromium uses them as the software
//     fallback when the GPU driver is unavailable; without them the window is blank.
let pruneSaved = 0;
for (const rel of ['d3dcompiler_47.dll']) {
  const p = path.join(OUT, rel);
  try {
    pruneSaved += fs.statSync(p).size;
    fs.rmSync(p, { force: true });
  } catch (_) { /* not there */ }
}

// 2. The app itself
console.log('Copying app...');
const appDir = path.join(OUT, 'resources', 'app');
for (const item of ['package.json', 'src', 'LICENSE']) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) copy(src, path.join(appDir, item));
}

// 3. Optional folders
// Only documentation from engine/ ships; the large runtime components (emulator, system-images,
// platform-tools, avd) are downloaded from official sources on first launch, not bundled.
// tools/ holds development checks (console-window tests, speed tests) and isn't shipped.
const ENGINE_SKIP = new Set(['emulator', 'system-images', 'platform-tools', 'avd', 'aehd', '_dl', 'qemu']);
for (const opt of ['engine']) {
  const src = path.join(ROOT, opt);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(appDir, opt);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (opt === 'engine' && ENGINE_SKIP.has(entry.name)) continue;
    fs.cpSync(path.join(src, entry.name), path.join(dest, entry.name), { recursive: true });
  }
}

// 4. Rename the main executable and give it the app icon (otherwise Explorer shows Electron's atom).
//    rcedit ships with electron-builder's dependencies; skip quietly if it isn't there.
fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, 'ApkStart.exe'));
const RCEDIT = path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
if (fs.existsSync(RCEDIT)) {
  require('child_process').execFileSync(RCEDIT, [
    path.join(OUT, 'ApkStart.exe'), '--set-icon', path.join(ROOT, 'src', 'ui', 'assets', 'appicon.ico'),
  ], { stdio: 'inherit' });
  console.log('Set the ApkStart.exe icon');
} else {
  console.log('rcedit not found: ApkStart.exe keeps the Electron icon');
}

// 5. Version info
const pkg = require(path.join(ROOT, 'package.json'));
fs.writeFileSync(path.join(OUT, 'VERSION.txt'), `ApkStart ${pkg.version}\nBuilt: ${new Date().toISOString()}\n`);

// 6. Size report on every pack, so the package can't quietly grow
function dirSize(dir) {
  let n = 0;
  try {
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, it.name);
      n += it.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch (_) { /* ignore */ }
  return n;
}
const totalMB = dirSize(OUT) / 1048576;
console.log(
  `Done. Total ${totalMB.toFixed(0)} MB (locales saved ${(localeSaved / 1048576).toFixed(0)} MB, `
  + `redundant libraries saved ${(pruneSaved / 1048576).toFixed(1)} MB).`,
);
console.log('Compress: node build/zip.js dist/ApkStart-win64-portable <output.zip>');
console.log(`Run ${path.join(OUT, 'ApkStart.exe')} to start.`);
