'use strict';
/**
 * App window: one running Android app = one clean Windows window.
 *
 * The window has only a 38px title bar at the top (rotate / minimize / maximize / close);
 * everything below is the embedded emulator window (SetParent), so there is no Android home
 * screen, no emulator side toolbar, and no second taskbar icon.
 */
const { BrowserWindow, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { hookOptions } = require('./pointer');
const store = require('./store');
const { t } = require('../i18n');

const TITLEBAR_H = 38;
/**
 * The emulator window has an 8px gray padding all around (Qt frame margin), and the real LCD
 * picture starts at +8px. Growing the child window by 16px and offsetting it 8px up-left pushes
 * that gray ring outside the client area, so the picture fills the edges cleanly.
 */
const EMU_PAD = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iconUrl(p) {
  if (!p || !fs.existsSync(p)) return '';
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}?v=${fs.statSync(p).mtimeMs}`;
}

class AppWindow {
  constructor({ agent, setOrientation, mouseHook = false, pointerConfig = null }) {
    this.agent = agent;
    this.setOrientation = setOrientation || null;
    // The global mouse hook is installed only while the app window is in front and at least one
    // mapping is on. pointerConfig is a function: a Settings change takes effect on the next focus, no restart.
    this.mouseHook = mouseHook;
    this.pointerConfig = pointerConfig;
    this.win = null;
    this.pkg = null;
    this.state = { label: '', tip: '', ready: false, landscape: false };
    this._fitTimer = null;
    this._closedCb = null;
  }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  /** Target content size in portrait / landscape (scaled to fit the screen) */
  static sizeFor(area, portrait, landscape) {
    const p = portrait || { w: 540, h: 960 };
    // Leave margins: title bar 38 + 24 top and bottom, 40 left and right
    const availH = Math.max(360, (area.h || 1040) - TITLEBAR_H - 48);
    const availW = Math.max(300, (area.w || 1920) - 80);
    const k = landscape
      ? Math.min(availW / p.h, availH / p.w)
      : Math.min(availH / p.h, availW / p.w);
    const w = Math.round((landscape ? p.h : p.w) * k);
    const h = Math.round((landscape ? p.w : p.h) * k);
    // Belt and braces: never exceed the usable screen area, or the OS clips it ("black borders / not filled")
    return {
      w: Math.max(320, Math.min(w, Math.round(availW))),
      h: Math.max(360, Math.min(h, Math.round(availH))),
    };
  }

  _area() {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const a = d.workArea || d.bounds;
    return { x: a.x, y: a.y, w: a.width, h: a.height };
  }

  _scale() {
    try {
      const b = this.win ? this.win.getBounds() : this._area();
      return screen.getDisplayMatching(b).scaleFactor || 1;
    } catch (_) {
      return 1;
    }
  }

  /**
   * Open (or reuse) the app window.
   * @param {object} o { pkg, label, iconPath, portrait, fullscreen, onClosed }
   */
  open(o) {
    const { pkg, label, iconPath, portrait, fullscreen } = o;
    this._closedCb = o.onClosed || null;
    if (this.isOpen && this.pkg === pkg) {
      this.win.show();
      this.win.focus();
      return this.win;
    }
    this.close({ keepApp: true });

    this.pkg = pkg;
    this.portrait = portrait || { w: 540, h: 960 };
    this.state = { label: label || t('App'), tip: t('Starting the Android runtime…'), ready: false, landscape: false };

    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, false);
    const w = Math.max(320, size.w);
    const h = Math.max(420, size.h + TITLEBAR_H);

    const iconFile = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

    this.win = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 320,
      minHeight: 420,
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + (area.h - h) / 2),
      show: false,
      frame: false,
      thickFrame: true,
      resizable: true,
      maximizable: true,
      backgroundColor: '#0b0c0e',
      title: label || 'ApkStart',
      icon: iconFile,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
    // The page would change the window title to shell.html's <title> and the taskbar could no
    // longer tell which app this is; block it so the OS title always equals the app name
    // (taskbar tooltip and Alt+Tab rely on it).
    this.win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      try { this.win.setTitle(label || 'ApkStart'); } catch (_) { /* window may be destroyed */ }
    });
    this.win.once('ready-to-show', () => {
      this.win.show();
      this._push();
    });

    // When Electron maximizes, the window size settles in several steps (OS animation, DPI
    // recalculation). A single 40 ms debounced fit often caught an intermediate state, leaving
    // the embedded picture in a strip at the top-left with blank space on the right
    // ("maximized but not filled"). Fit repeatedly instead, each round using the latest getContentBounds.
    const refit = () => this.scheduleFit(6);
    this.win.on('resize', refit);
    this.win.on('move', refit);
    this.win.on('maximize', refit);
    this.win.on('unmaximize', refit);
    this.win.on('restore', () => {
      this.agent.show().catch(() => {});
      this.scheduleFit(6);
    });
    this.win.on('minimize', () => { this.agent.hide().catch(() => {}); });
    this.win.on('close', () => { this._closing = true; });
    this.win.on('closed', () => {
      if (this._selfClose) return;   // close() finishes up itself after parking
      this.win = null;
      const pkg = this.pkg;
      this.pkg = null;
      this._closing = false;
      // Close paths that bypass close() (Alt+F4, taskbar close, system shutdown) must also stop
      // the Android app and detach the emulator window. Otherwise the window is gone but the app
      // keeps running, and reopening just switches to it ("it won't close").
      if (pkg && this._onCloseApp) {
        try { this._onCloseApp(pkg); } catch (_) { /* ignore */ }
      }
      Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(() => {
        if (this._closedCb) this._closedCb(pkg);
      });
    });
    // Install the global hook only while the app window is really in front and at least one
    // mouse mapping is on; uninstall immediately on blur/close so ApkStart never slows the
    // system mouse in the background.
    this.win.on('focus', () => this._syncHook(true));
    this.win.on('blur', () => this._syncHook(false));

    if (fullscreen) this.win.maximize();
    return this.win;
  }

  _pointerOptions() {
    const getter = this.pointerConfig || this.mouseHook;
    const raw = typeof getter === 'function' ? getter() : getter;
    return hookOptions(raw);
  }

  _syncHook(active) {
    const opts = this._pointerOptions();
    // In game / low-latency mode never install the global mouse hook: WH_MOUSE_LL calls back
    // synchronously for every desktop mouse event and adds pointer latency; FPS games need
    // the Qt window to receive raw input directly.
    const game = !!(store.getSettings().engine && store.getSettings().engine.priorityMode === 'game');
    const on = !!active && opts.enabled && !game;
    if (this.agent && typeof this.agent.setHook === 'function') {
      this.agent.setHook(on, opts).catch(() => {});
    }
  }

  /** Mouse mapping changed in Settings: resync for the current focus (without reinstalling the hook thread) */
  refreshPointer() {
    const focused = this.isOpen && !!this.win.isFocused();
    if (!focused) {
      // Window not in front: only uninstall, don't let the hook idle in the background
      if (this.agent && typeof this.agent.setHook === 'function') {
        this.agent.setHook(false).catch(() => {});
      }
      return;
    }
    this._syncHook(true);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this._push();
  }

  _push() {
    if (!this.isOpen) return;
    try {
      this.win.webContents.send('shell:state', {
        ...this.state,
        iconUrl: this.iconUrl || '',
      });
    } catch (_) { /* window may have just closed */ }
  }

  setIcon(p) { this.iconUrl = iconUrl(p); this._push(); }

  /**
   * Embed the emulator window into this window and fill the area below the title bar.
   * Resident suppression stays on: it skips the window already embedded in ours and keeps
   * every other window (including qemu / netsimd black console windows) hidden - turning it
   * off would give them another chance to show up.
   * The emulator window is occasionally not created yet (machines where snapshot restore is
   * very fast), so retry a few times.
   */
  async embed() {
    if (!this.isOpen) return false;
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!this.isOpen) return false;
      const hwnd = this._hwnd();
      if (!hwnd) return false;
      // eslint-disable-next-line no-await-in-loop
      const r = await this.agent.embed(hwnd, this._rect()).catch((e) => ({ ok: false, error: e.message }));
      last = r;
      if (r && r.ok) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(attempt < 2 ? 300 : 800);
    }
    // Carry the failure reason out: the caller writes it to app.log, so it's obvious whether
    // the emulator window wasn't found or SetParent failed, no guessing.
    this.lastEmbedError = last ? (last.error || `emu=${last.emu}`) : 'no-response';
    return false;
  }

  async fitNow() {
    if (!this.isOpen) return;
    await this.agent.fit(this._rect()).catch(() => {});
  }

  /** Rectangle the emulator child window should occupy (physical pixels, with the 8px padding pushed out of view) */
  _rect() {
    const sf = this._scale();
    const b = this.win.getContentBounds();
    const top = Math.round(TITLEBAR_H * sf);
    return {
      x: -EMU_PAD,
      y: top - EMU_PAD,
      w: Math.round(b.width * sf) + EMU_PAD * 2,
      h: Math.round((b.height - TITLEBAR_H) * sf) + EMU_PAD * 2,
      // The -EMU_PAD strip on top overlaps the title bar; the window agent clips it (see agent.fit clipTop)
      clipTop: EMU_PAD,
    };
  }

  /**
   * @param {number} rounds how many fit rounds in a row (each recomputes the latest bounds while the size changes)
   */
  scheduleFit(rounds = 1) {
    if (!this.isOpen) return;
    if (this._fitTimer) clearTimeout(this._fitTimer);
    const run = async (left) => {
      await this.fitNow().catch(() => {});
      if (left > 1) {
        this._fitTimer = setTimeout(() => run(left - 1), 160);
      } else {
        this._fitTimer = null;
      }
    };
    this._fitTimer = setTimeout(() => run(Math.max(1, rounds)), 40);
  }

  _hwnd() {
    try {
      const buf = this.win.getNativeWindowHandle();
      const v = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
      return v.toString();
    } catch (_) {
      return null;
    }
  }

  /**
   * Portrait/landscape toggle (title bar rotate button) = really switch the physical panel.
   *
   * Why it has to be done this way (lessons learned):
   *   - wm size: only changes Android's logical resolution while the emulator LCD stays portrait;
   *     Qt draws the frame top-left -> picture rotated 90 degrees in a strip, black borders, taps misaligned;
   *   - wm density: framebuffer size unchanged, picture doesn't fill, large blank area on the right when maximized;
   *   - adb emu rotate: only rotates the picture, the system is still portrait.
   * The only way to get an upright, full landscape is to switch hw.lcd.width/height to 1280x720
   * and restart the emulator. That takes about 30-60 s, so do it once and say so clearly.
   *
   * @param {(next:boolean)=>Promise<boolean>} [onRestart] restart implementation injected by the caller
   */
  async rotate(onRestart) {
    if (!this.isOpen) return this.state.landscape;
    const next = !this.state.landscape;
    this.setState({ tip: next ? t('Switching to landscape (restarts the Android runtime, about 30-60 seconds)…') : t('Switching back to portrait (restarts the Android runtime, about 30-60 seconds)…'), ready: false });
    if (typeof onRestart === 'function') {
      const ok = await onRestart(next).catch(() => false);
      if (ok) {
        this.state.landscape = next;
        this._push();
        // Panel size changed, so the window aspect ratio follows; fit a few rounds to converge
        for (let i = 0; i < 5; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(400);
          // eslint-disable-next-line no-await-in-loop
          await this.fitNow();
        }
        this.setState({ ready: true, tip: '' });
        return next;
      }
    }
    // Without an injected restart (or if it failed) fall back to density, which at least switches the layout
    if (this.setOrientation) await this.setOrientation(next).catch(() => {});
    this.state.landscape = next;
    this.setState({ ready: true, tip: '' });
    return next;
  }

  /** Switch to the given orientation when needed (fullscreen = landscape, windowed = portrait) */
  async setLandscape(want) {
    if (!this.isOpen) return this.state.landscape;
    if (!!this.state.landscape === !!want) return this.state.landscape;
    return this.rotate();
  }

  toggleMaximize() {
    if (!this.isOpen) return;
    if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
    this.scheduleFit();
  }

  minimize() { if (this.isOpen) this.win.minimize(); }

  /**
   * Close the window. By default also stops this Android app (saves memory) but keeps the
   * engine, so the next open is instant.
   *
   * Order matters: first detach and hide the emulator window from the host, then destroy the
   * host. The other way round, Windows re-parents the cross-process child window to the
   * desktop with its old visibility, and a black "Android Emulator - apkstart5554" window
   * appears out of nowhere.
   */
  close({ keepApp = false } = {}) {
    if (!this.isOpen) return;
    const win = this.win;
    const pkg = this.pkg;
    this._syncHook(false);
    if (!keepApp && pkg && this._onCloseApp) this._onCloseApp(pkg);
    this._selfClose = true;
    this.win = null;
    this.pkg = null;
    const done = () => {
      try { win.destroy(); } catch (_) { /* ignore */ }
      this._selfClose = false;
      this._closing = false;
      if (this._closedCb) this._closedCb(pkg);
    };
    Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(done, done);
  }

  onCloseApp(cb) { this._onCloseApp = cb; }
}

module.exports = { AppWindow, TITLEBAR_H };
