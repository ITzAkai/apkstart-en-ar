'use strict';
/**
 * Clean up leftovers from old versions.
 *
 * Upgrading ApkStart often leaves "several versions installed, none removed cleanly": every
 * portable version adds another ApkStart-vX.Y.Z-win64-portable folder; NSIS upgrades can leave
 * uninstall entries pointing at deleted folders; updates leave temp packages in the data folder.
 *
 * Only **provably safe** cleanup is done here:
 *   - only old version folders that really contain ApkStart.exe, never the one currently running;
 *   - only registry uninstall entries whose InstallLocation no longer exists (already dead entries);
 *   - only temp files in our own update cache and Start menu / desktop shortcuts pointing at missing targets.
 * Whenever a step is uncertain it is skipped, and the reason is reported honestly to the UI.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { t } = require('../i18n');

const EXE = 'ApkStart.exe';

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(f);
        else n += fs.statSync(f).size;
      } catch (_) { /* in use / no permission, skip */ }
    }
  };
  walk(p);
  return n;
}

function norm(p) {
  try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); }
}

/**
 * Look for old version folders in several places programs may live.
 *
 * It used to scan only the current exe's parent + LOCALAPPDATA\Programs + ProgramFiles, so a
 * portable copy extracted anywhere else (E:\Downloads, the desktop, some project folder) was
 * never found - that's why "old versions in other folders can't be cleaned". Now several sources:
 *   - common install locations;
 *   - shallow scan of each drive root (many portable copies sit right in D:\ApkStart-...);
 *   - folders of the real exe targeted by existing desktop / Start menu shortcuts (most accurate: if it was installed, it's there).
 */
function candidateRoots(installDir) {
  const roots = new Set();
  const add = (p) => { if (p) roots.add(p); };
  add(path.dirname(installDir));
  const local = process.env.LOCALAPPDATA;
  if (local) add(path.join(local, 'Programs'));
  add(process.env.ProgramFiles);
  add(process.env['ProgramFiles(x86)']);
  const home = os.homedir();
  if (home) {
    add(path.join(home, 'Downloads'));
    add(path.join(home, 'Desktop'));
    add(path.join(home, 'Documents'));
  }
  try {
    for (const drv of ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\']) {
      if (fs.existsSync(drv)) add(drv.replace(/\\+$/, ''));
    }
  } catch (_) { /* ignore */ }
  return [...roots];
}

/**
 * Find where ApkStart.exe really lives from shortcuts (.lnk / .desktop).
 * The most reliable discovery method: if the user ever created a desktop icon or Start menu
 * entry, the target path is in it, no matter which drive or how deep the folder.
 */
function rootsFromShortcuts() {
  const dirs = new Set();
  const homes = [os.homedir(), process.env.APPDATA, process.env.LOCALAPPDATA]
    .filter(Boolean);
  const linkDirs = [];
  for (const h of homes) {
    linkDirs.push(path.join(h, 'Desktop'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ApkStart'));
  }
  for (const d of linkDirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!/\.(lnk|desktop)$/i.test(e.name)) continue;
      const full = path.join(d, e.name);
      try {
        if (/\.desktop$/i.test(e.name)) {
          const txt = fs.readFileSync(full, 'utf8');
          const m = /^Exec=(.+)$/m.exec(txt);
          if (m) {
            const exePath = m[1].trim().replace(/^"|"$/g, '').split(/\s+/)[0];
            if (exePath && /[\\/]ApkStart(\.exe)?$/i.test(exePath)) dirs.add(path.dirname(exePath));
          }
        } else {
          // .lnk is binary, but the target path is embedded in readable form; scan the bytes for ApkStart*.exe
          const buf = fs.readFileSync(full);
          const s = buf.toString('latin1');
          const re = /[A-Za-z]:\\[^\x00\x01-\x1f]*?ApkStart(?:-[^\x00\x01-\x1f]*)?[\\/]?ApkStart\.exe|[A-Za-z]:\\[^\x00\x01-\x1f]*?ApkStart\.exe/gi;
          let mm;
          while ((mm = re.exec(s))) {
            dirs.add(path.dirname(mm[0].replace(/\x00.*$/, '')));
          }
        }
      } catch (_) { /* unreadable, skip */ }
    }
  }
  return [...dirs];
}

/** Old program folders: named ApkStart*, containing ApkStart.exe, and not the current install folder */
function scanDirs(installDir) {
  const out = [];
  const seen = new Set();
  const cur = norm(installDir);
  const consider = (full) => {
    const key = norm(full);
    if (seen.has(key)) return;
    seen.add(key);
    if (key === cur) return;
    // Must really be an ApkStart folder, so a same-named folder is never deleted by mistake
    if (!fs.existsSync(path.join(full, EXE))) return;
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: t('Old program folder (contains {exe})', { exe: EXE }),
    });
  };
  for (const root of candidateRoots(installDir)) {
    let list = [];
    try { list = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      if (!/^ApkStart/i.test(e.name)) continue;
      consider(path.join(root, e.name));
    }
  }
  // Folders found via shortcuts: may be an old version folder itself, or its parent / child is
  for (const d of rootsFromShortcuts()) {
    if (/^ApkStart/i.test(path.basename(d))) consider(d);
    // Also check its siblings (dist often holds several version folders side by side)
    const parent = path.dirname(d);
    let sib = [];
    try { sib = fs.readdirSync(parent, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of sib) {
      if (e.isDirectory() && /^ApkStart/i.test(e.name)) consider(path.join(parent, e.name));
    }
  }
  return out;
}

/** Registry uninstall entries pointing at folders that no longer exist */
function scanRegistry() {
  const out = [];
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', root, '/s', '/f', 'ApkStart', '/t', 'REG_SZ'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    } catch (_) { continue; }
    // reg query output is in blocks of "key -> values"; split by block
    const blocks = String(text).split(/\r?\n\r?\n/);
    for (const b of blocks) {
      const key = (/^(HKEY_[^\r\n]+)$/m.exec(b) || [])[1];
      if (!key) continue;
      if (!/\\ApkStart/i.test(key)) continue;
      const loc = (/InstallLocation\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const disp = (/DisplayName\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const unins = (/UninstallString\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const install = (loc || '').trim().replace(/^"|"$/g, '');
      const uninsPath = (unins || '').trim().replace(/^"|"$/g, '');
      const installMissing = install ? !fs.existsSync(install) : false;
      // Only handle dead entries: no longer installed but still listed in installed apps
      const deadUninstaller = uninsPath && !fs.existsSync(uninsPath.split('"')[0]);
      if (!installMissing && !deadUninstaller) continue;
      out.push({
        kind: 'registry',
        path: key,
        size: 0,
        note: disp ? t('Stale uninstall entry: {name}', { name: String(disp).trim() }) : t('Stale uninstall entry'),
      });
    }
  }
  return out;
}

/** Update cache / temp packages */
function scanTemp(dataDir) {
  const out = [];
  const dirs = [path.join(dataDir, 'update'), os.tmpdir()];
  for (const d of dirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      const name = e.name;
      const isOurs = /^ApkStart.*\.(zip|exe|part\d*|tmp)$/i.test(name)
        || /^ApkStart-.*\.part\d+$/i.test(name);
      if (!isOurs) continue;
      const full = path.join(d, name);
      let size = 0;
      try { size = e.isDirectory() ? dirSize(full) : fs.statSync(full).size; } catch (_) { /* ignore */ }
      out.push({ kind: 'temp', path: full, size, note: t('Temporary update download') });
    }
  }
  return out;
}

/** Old / abandoned Quick Boot snapshots: default_boot was left by early versions (one ram.img is about 3 GB),
 *  *.stale-* are leftovers renamed when they couldn't be deleted. The current snapshot is apkstart and is never touched. */
function scanSnapshots(avdHome) {
  const out = [];
  if (!avdHome) return out;
  const snapDir = path.join(avdHome, 'apkstart.avd', 'snapshots');
  let list = [];
  try { list = fs.readdirSync(snapDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of list) {
    if (!e.isDirectory()) continue;
    if (e.name === 'apkstart') continue;   // snapshot currently in use
    const full = path.join(snapDir, e.name);
    out.push({
      kind: 'snapshot',
      path: full,
      size: dirSize(full),
      note: e.name.startsWith('default_boot') ? t('Quick Boot snapshot left by an old version') : t('Leftover abandoned snapshot'),
    });
  }
  return out;
}

function scan({ installDir, dataDir, avdHome }) {
  const items = [];
  const push = (list) => { for (const x of list) items.push(x); };
  push(scanDirs(installDir));
  push(scanRegistry());
  push(scanTemp(dataDir));
  push(scanSnapshots(avdHome));
  const total = items.reduce((n, x) => n + (x.size || 0), 0);
  return { items, totalBytes: total };
}

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

function clean(items, { installDir }) {
  const cur = norm(installDir);
  let freed = 0;
  const removed = [];
  const failed = [];
  for (const it of items || []) {
    try {
      if (it.kind === 'dir') {
        // Belt and braces: never delete the folder currently running
        if (norm(it.path) === cur) { failed.push({ path: it.path, reason: t('This is the version currently running') }); continue; }
        if (!fs.existsSync(path.join(it.path, EXE))) { failed.push({ path: it.path, reason: t('Folder does not contain {exe}', { exe: EXE }) }); continue; }
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: t('Files are in use (a window may still be open)') });
      } else if (it.kind === 'snapshot') {
        // Only abandoned snapshot folders under apkstart.avd\snapshots; never the live "apkstart" one
        const inSnapDir = /[\\/]apkstart\.avd[\\/]snapshots[\\/][^\\/]+$/i.test(it.path);
        if (!inSnapDir || path.basename(it.path) === 'apkstart') { failed.push({ path: it.path, reason: t('Delete failed') }); continue; }
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: t('Files are in use (a window may still be open)') });
      } else if (it.kind === 'registry') {
        const r = execFileSync('reg', ['delete', it.path, '/f'], { windowsHide: true, timeout: 10000 });
        void r;
        removed.push(it.path);
      } else if (it.kind === 'temp') {
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: t('File is in use') });
      } else if (it.kind === 'shortcut') {
        if (rm(it.path)) removed.push(it.path);
        else failed.push({ path: it.path, reason: t('Delete failed') });
      }
    } catch (e) {
      failed.push({ path: it.path, reason: e.message });
    }
  }
  return { removed, failed, freedBytes: freed };
}

module.exports = { scan, clean };
