'use strict';
/**
 * Container-style layering: read-only base image + slim runtime + reclaimable scratch layer.
 *
 * Same idea as Docker:
 *   system-images/  = read-only base layer, one copy shared by all apps and sessions, never duplicated
 *   avd/*.avd/      = writable thin layer (qcow2 diffs + quickboot snapshots), stores changes only
 *   _tmp/ snapshots = reclaimable scratch layer
 *
 * This module only takes inventory and reclaims an explicit list. Dry run by default;
 * never touches the user's personal files.
 */
const fs = require('fs');
const path = require('path');
const { t } = require('../i18n');

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, out, depth + 1);
    else {
      try { out.push({ path: p, size: fs.statSync(p).size }); } catch (_) { /* ignore */ }
    }
  }
  return out;
}

function dirSize(dir) { return walk(dir).reduce((n, f) => n + f.size, 0); }
const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };

/**
 * Inventory the runtime's disk usage and list entries that are safe to reclaim.
 * @returns {{total:number, groups:Array, candidates:Array}}
 */
function analyze(root, { keepAvd = 'apkstart.avd', aggressive = false, keepSnapshots = false } = {}) {
  const groups = [];
  const candidates = [];
  if (!exists(root)) return { total: 0, groups, candidates };

  const groupOf = (name, dir) => {
    const size = dirSize(dir);
    groups.push({ name, size });
    return size;
  };
  const add = (p, size, reason, kind = 'file') => candidates.push({ path: p, size, reason, kind });

  groupOf('emulator engine', path.join(root, 'emulator'));
  groupOf('system images (read-only base layer)', path.join(root, 'system-images'));
  groupOf('AVD writable layer / snapshots', path.join(root, 'avd'));
  groupOf('platform-tools', path.join(root, 'platform-tools'));

  // 1) QEMU only needs the x86_64 target; binaries for the other architectures are pure waste
  const qemuDir = path.join(root, 'emulator', 'qemu', 'windows-x86_64');
  if (exists(qemuDir)) {
    for (const f of walk(qemuDir)) {
      if (/qemu-system-(aarch64|armel|i386)/i.test(path.basename(f.path))) {
        add(f.path, f.size, 'non-x86_64 QEMU target, not used at runtime');
      }
    }
  }

  // 2) License texts / redundant files inside image packages
  for (const f of walk(path.join(root, 'system-images'))) {
    if (/^(NOTICE\.txt|source\.properties)$/i.test(path.basename(f.path)) && f.size > 1024 * 1024) {
      add(f.path, f.size, 'large notice file inside the image package');
    }
  }

  // 3) Keep a single system image: once the API 34 Play image is in place, the old API 30 one is obsolete
  const play34 = path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img');
  if (exists(play34)) {
    const legacy = path.join(root, 'system-images', 'android-30');
    if (exists(legacy)) add(legacy, dirSize(legacy), 'old API 30 image (with outdated ARM translation layer)', 'dir');
  }
  const stray = path.join(root, 'x86_64');
  if (exists(stray)) add(stray, dirSize(stray), 'duplicate image folder from a misplaced extraction', 'dir');

  // 4) Inactive AVDs: the product only uses apkstart; leftovers from testing (apkstart-arm / -houdini...) can go
  const avdHome = path.join(root, 'avd');
  if (exists(avdHome)) {
    for (const e of fs.readdirSync(avdHome, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.endsWith('.avd') || e.name === keepAvd) continue;
      add(path.join(avdHome, e.name), dirSize(path.join(avdHome, e.name)),
        'inactive AVD (includes an old 8-16 GB user data image)', 'dir');
    }
    // 5) Lock files: leftovers cause "AVD is already running"
    for (const f of walk(avdHome)) {
      if (/\.lock$/i.test(f.path)) add(f.path, f.size, 'lock file left by an abnormal exit');
    }
    // 6) Quickboot snapshots: ram.img is about the VM's memory size; must be dropped after corruption or config changes
    const activeAvd = path.join(avdHome, keepAvd);
    if (exists(activeAvd) && !keepSnapshots) {
      for (const e of fs.readdirSync(activeAvd, { withFileTypes: true })) {
        // Normal snapshots plus old ones renamed after a failed delete are all reclaimable
        if (!e.isDirectory() || !/^snapshots(\.stale-\d+)?$/.test(e.name)) continue;
        const p = path.join(activeAvd, e.name);
        add(p, dirSize(p), 'old quickboot snapshot (rebuilt automatically after config changes)', 'dir');
      }
    }
  }

  // 7) Download cache / leftover QEMU ISOs
  for (const d of ['_tmp', 'images']) {
    const p = path.join(root, d);
    if (exists(p)) {
      const size = dirSize(p);
      if (size > 0) add(p, size, d === '_tmp' ? 'temporary download files' : 'old QEMU/ISO leftovers', 'dir');
    }
  }

  // 8) Aggressive trim: only when building a release package.
  // Note: Qt6WebEngineCoreAndroidEmu.dll is a load-time dependency of qemu-system-x86_64.exe;
  // deleting it stops the emulator from starting, so it must never be listed. qsn/netsim may be
  // used on demand by snapshots and networking, so they are kept too.
  if (aggressive) {
    const extras = [
      ['emulator/crashreport.exe', 'crash reporter (not needed for headless use)'],
    ];
    for (const [rel, reason] of extras) {
      const p = path.join(root, rel);
      if (exists(p)) add(p, fs.statSync(p).size, reason);
    }
  }

  const total = groups.reduce((n, g) => n + g.size, 0);
  return { total, groups, candidates };
}

/**
 * Reclaim. Requires an explicit apply:true; the caller (UI / build script) shows the list and gets confirmation first.
 * Safety: every target must be inside root, and root itself may never be deleted.
 */
function prune(root, { apply = false, keepAvd, aggressive = false, keepSnapshots = false, onRemove = () => {} } = {}) {
  const report = analyze(root, { keepAvd, aggressive, keepSnapshots });
  const rootAbs = path.resolve(root);
  const removed = [];
  let saved = 0;
  for (const c of report.candidates) {
    const p = path.resolve(c.path);
    if (p === rootAbs || !p.startsWith(rootAbs + path.sep)) continue;
    if (!exists(p)) continue;
    if (apply) {
      try {
        fs.rmSync(p, c.kind === 'dir' ? { recursive: true, force: true } : { force: true });
        removed.push(c);
        saved += c.size;
        onRemove(c);
      } catch (_) { /* file in use: skip, clean it next time */ }
    }
  }
  return { ...report, apply, removed, saved, after: apply ? report.total - saved : report.total };
}

/** Short summary for the settings page */
function summary(root) {
  const a = analyze(root);
  const mb = (n) => (n >= 1048576 * 1024
    ? `${(n / 1073741824).toFixed(2)} GB`
    : `${(n / 1048576).toFixed(0)} MB`);
  // Besides the runtime folder, users mostly care "how much disk does this take in total":
  // count the AVD (app data + snapshots), APK cache, icons and logs as well.
  const store = require('./store');
  const extra = [
    { key: 'avd', label: t('Android data (apps + snapshots)'), path: path.join(store.DATA_DIR, 'avd') },
    { key: 'apk', label: t('APK package cache'), path: store.APK_DIR },
    { key: 'icons', label: t('Desktop icon cache'), path: store.ICON_DIR },
    { key: 'logs', label: t('Logs'), path: path.join(store.DATA_DIR, 'logs') },
  ].map((g) => ({ ...g, size: dirSize(g.path) })).filter((g) => g.size > 0);

  const extraTotal = extra.reduce((n, g) => n + g.size, 0);
  const totalAll = a.total + extraTotal;
  return {
    total: totalAll,
    totalText: mb(totalAll),
    runtimeText: mb(a.total),
    groups: [
      { key: 'runtime', label: t('Runtime (engine + system images)'), size: a.total, text: mb(a.total) },
      ...extra.map((g) => ({ ...g, text: mb(g.size) })),
    ],
    reclaimable: a.candidates.reduce((n, c) => n + c.size, 0),
    reclaimableText: mb(a.candidates.reduce((n, c) => n + c.size, 0)),
    count: a.candidates.length,
  };
}

module.exports = { analyze, prune, summary, walk, dirSize };
