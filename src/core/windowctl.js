'use strict';
/**
 * Dress the Android Emulator's Qt window up as "one native window per app".
 *
 * Why not screen mirroring: headless SurfaceFlinger emits no VSYNC (screenrecord measured 2
 * frames in 3 seconds), so software mirroring is laggy and CPU-hungry. The windowed emulator is
 * already native 60 fps with native mouse/keyboard; this only does a few cheap Win32 calls:
 * set title / icon / size / fullscreen.
 *
 * PowerShell ships with Windows. The script is pure ASCII and non-ASCII titles are passed in
 * UTF-8 JSON, because Windows PowerShell 5.1 reads a .ps1 as ANSI and would garble them.
 * Any failure degrades silently: the window still works, just without the rename/fullscreen.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'win', 'windowctl.ps1');
const TIMEOUT = 8000;

function parseOut(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** @param {object} params { pid, action, title, icon, bounds } */
function call(params) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !fs.existsSync(SCRIPT) || !params || params.pid === undefined) {
      resolve(null);
      return;
    }
    const json = path.join(os.tmpdir(),
      `apkstart-wctl-${crypto.randomBytes(4).toString('hex')}.json`);
    try {
      fs.writeFileSync(json, JSON.stringify(params), 'utf8');
    } catch (_) { resolve(null); return; }

    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, json,
    ], { timeout: TIMEOUT, windowsHide: true, maxBuffer: 1024 * 64 }, (err, stdout) => {
      try { fs.unlinkSync(json); } catch (_) { /* ignore */ }
      if (err) { resolve(null); return; }
      const r = parseOut(stdout);
      resolve(r.OK === '1' ? r : null);
    });
  });
}

/** Read the current window position, used to remember each app's window size */
async function getBounds(pid) {
  const r = await call({ pid, action: 'get' });
  if (!r || !Number(r.W) || !Number(r.H)) return null;
  return {
    x: Number(r.X) || 0, y: Number(r.Y) || 0,
    w: Number(r.W), h: Number(r.H),
    maximized: r.MAX === '1',
  };
}

/**
 * Make the runtime window present itself as the current app.
 * @param {object} o { pid, label, icon, mode:'window'|'fullscreen', bounds, screen }
 */
async function present(o) {
  const { pid, label, icon, mode, bounds, screen } = o || {};
  // pid=0 is valid: when reusing an emulator started by another process there is no handle, so the script finds the window by process name
  if (pid === undefined || pid === null) return null;
  return call({
    pid,
    action: mode === 'fullscreen' ? 'fullscreen' : 'window',
    title: label || '',
    icon: icon && fs.existsSync(icon) ? icon : '',
    bounds: bounds || null,
    screen: mode === 'fullscreen' ? (screen || null) : null,
  });
}

async function focus(pid) { return call({ pid, action: 'focus' }); }

/** Tell Explorer to refresh icons/shortcuts so a new desktop icon shows up without pressing F5 */
async function refreshShell() { return call({ pid: 0, action: 'refresh' }); }

module.exports = { call, getBounds, present, focus, refreshShell, SCRIPT };
