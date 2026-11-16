'use strict';
/**
 * Runtime slimming: delete emulator files that our launch mode never loads.
 *
 * Based on emulator.js's fixed launch arguments:
 *   - only an x86_64 image (API30 AOSP)       -> qemu-system-aarch64.exe is unused
 *   - -gpu software (swiftshader rendering)  -> vulkan / gles_angle backends are unused
 *   - UI reduced to a 38px title bar         -> the emulator UI's translations and WebEngine panels are unused
 *
 * The networking pieces netsimd / netsim / nimble_bridge always stay:
 * they carry the wifi / bluetooth data path; without them apps have no network.
 *
 * Usage:
 *   node build/slim-runtime.js build/runtime                # safe level (default)
 *   node build/slim-runtime.js build/runtime --aggressive   # also remove QtWebEngine (-169MB)
 *   node build/slim-runtime.js build/runtime --dry-run
 */
const fs = require('fs');
const path = require('path');

/**
 * Safe level: remove things that are definitely never loaded (about -190MB).
 * Boundaries confirmed by rolling back one item at a time (important, don't add blindly):
 *   - Qt6WebEngineCoreAndroidEmu.dll is a hard (static import) dependency of emulator.exe; without it nothing starts -> keep
 *   - lib64/gles_angle provides vk_swiftshader, which swiftshader rendering needs -> keep
 *   - removing all of lib64/vulkan only falls back to software rendering (tested: boots and renders),
 *     but -gpu host needs vulkan-1.dll, so only its large parts are removed (see below)
 */
const SAFE = [
  ['emulator/qemu/windows-x86_64/qemu-system-aarch64.exe', 'arm64 QEMU binary (only x86_64 images ship)'],
  // Note: don't delete all of emulator/lib64/vulkan: vulkan-1.dll is the loader for -gpu host;
  // without it host rendering fails and only software rendering is left (required on AMD 780M). Only remove the big parts:
  ['emulator/lib64/vulkan/layers', 'Vulkan validation layers (unused for host rendering, -20MB)'],
  ['emulator/lib64/vulkan/glslangValidator.exe', 'shader validator (unused at runtime, -7MB)'],
  ['emulator/lib64/vulkan/libvulkan_lvp.dll', 'lavapipe software Vulkan fallback (unused with a system GPU driver, -53MB)'],
  ['emulator/lib64/vulkan/lvp_icd.json', 'lavapipe ICD descriptor (-1KB)'],
  ['emulator/lib64/vulkan/vk_swiftshader.dll', 'SwiftShader Vulkan (gles_angle has an identical copy, -23MB)'],
  ['emulator/lib64/qt/translations', 'emulator UI translations (only a 38px title bar is left)'],
  // Note: emulator-check.exe must stay: emulator -accel-check uses it to detect AEHD/WHPX;
  // without it, "no hardware acceleration" is assumed and it falls back to TCG (boot goes from 42s to 10+ minutes).
  ['emulator/qsn.exe', 'QEMU snapshot notification helper (no references from emulator.exe, verified with strings, -34MB)'],
  ['emulator/resources/Toren1BD_Main.png', 'VR panorama environment texture (unused, -3.7MB)'],
  ['emulator/resources/Toren1BD_Decor.png', 'VR panorama decor texture (-3.5MB)'],
  ['emulator/resources/Toren1BD.obj', 'VR panorama 3D model (-3.5MB)'],
  ['emulator/resources/macroPreviews', 'macro preview images (-2.7MB)'],
  ['emulator/resources/default360.mp4', 'default 360-degree panorama video (-2.4MB)'],
];

/** Aggressive level is currently empty: WebEngine is a hard dependency and gles_angle is needed for software rendering */
const AGGRESSIVE = [];

function sizeOf(p) {
  let s = 0;
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) s += sizeOf(path.join(p, e.name));
  } catch (_) { /* ignore */ }
  return s;
}

function slim(root, { aggressive = false, dryRun = false, log = console.log } = {}) {
  if (!fs.existsSync(path.join(root, 'emulator', 'emulator.exe'))) {
    throw new Error(`${root} is not a runtime folder (missing emulator/emulator.exe)`);
  }
  const list = aggressive ? SAFE.concat(AGGRESSIVE) : SAFE;
  let freed = 0;
  for (const [rel, why] of list) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const n = sizeOf(p);
    if (!dryRun) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        log(`  skipped ${rel}: ${e.message}`);
        continue;
      }
    }
    freed += n;
    log(`  removed ${rel} (${(n / 1048576).toFixed(0)} MB) - ${why}`);
  }
  log(`${dryRun ? 'Would free' : 'Freed'} ${(freed / 1048576).toFixed(0)} MB`);
  return freed;
}

module.exports = { slim };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, 'runtime'));
  const aggressive = process.argv.includes('--aggressive');
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Slimming: ${root} (${aggressive ? 'aggressive' : 'safe'} level)`);
  slim(root, { aggressive, dryRun });
}
