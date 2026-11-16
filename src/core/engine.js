'use strict';
/**
 * Runtime engine: the QEMU + Android-x86 VM bundled with ApkStart
 *
 * Design principles:
 *  - Fully self-contained by default (builtin): adb / QEMU / system image are all managed by ApkStart, no third-party emulator needed
 *  - Every Android operation goes through adb, so the engine is replaceable
 *  - The VM starts on demand and is reclaimed when idle; once up it stays resident, so installing/opening apps is near-instant
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { AdbClient } = require('./adb');
const store = require('./store');
const { Provisioner } = require('./provision');
const { EmulatorEngine } = require('./emulator');
const doctor = require('./doctor');
const container = require('./container');
const { t } = require('../i18n');

const LOG_DIR = path.join(store.DATA_DIR, 'logs');
const MONITOR_PORT = 5556;
const EMU_PORT = 5554;
const EMU_SERIAL = `emulator-${EMU_PORT}`;

/** Whether anything listens on a TCP port (used to check if the last run's emulator is still alive) */
function portAlive(port, timeout = 150) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

const ATTACH_ENDPOINTS = [
  { name: 'Windows Subsystem for Android', serial: '127.0.0.1:58526' },
  { name: 'LDPlayer', serial: '127.0.0.1:5555' },
  { name: 'MuMu Player', serial: '127.0.0.1:7555' },
  { name: 'Nox Player', serial: '127.0.0.1:62001' },
  { name: 'MEmu', serial: '127.0.0.1:21503' },
];

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.emulator = new EmulatorEngine(appRoot);
    this.vmProc = null;
    this.vmStarting = false;
    this.installing = false;
    this.lastActivity = Date.now();
    this._watchdog = null;
    this._freeformReady = false;
    this._client = null;
    this._bootLog = [];
    this._activeApps = new Set();  // container session: currently open app windows
    this.emuSerial = EMU_SERIAL;   // the port is picked dynamically; the serial follows it
    store.ensureDirs();
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  get settings() { return store.getSettings(); }

  /** Whether the emulator engine is running */
  get emuRunning() { return this.emulator.running(); }

  // ---------------- Basics ----------------

  adbPath() {
    const s = this.settings;
    const p = this.provisioner.paths();
    if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    if (fs.existsSync(p.adbExe)) return p.adbExe;
    const local = path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe');
    if (fs.existsSync(local)) return local;
    return AdbClient.resolveAdb('', this.appRoot);
  }

  client(serial) {
    const useSerial = serial
      || (this.settings.engine.mode === 'attach' ? this.settings.device : this.emuSerial);
    const adbPath = this.adbPath();
    if (!this._client || this._client.serial !== useSerial || this._client.adbPath !== adbPath) {
      // When switching port/adb, don't leave the old persistent adb shell holding a connection in the background
      if (this._client && this._client.disposeInput) this._client.disposeInput();
      this._client = new AdbClient({ adbPath, serial: useSerial });
    }
    return this._client;
  }

  touch() { this.lastActivity = Date.now(); }

  log(line) {
    this._bootLog.push({ t: Date.now(), line });
    if (this._bootLog.length > 300) this._bootLog.shift();
  }

  // ---------------- Status ----------------

  async status() {
    const env = await this.provisioner.checkEnv();
    const s = this.settings;
    const client = this.client();
    const result = {
      mode: s.engine.mode,
      installed: !!s.runtime.installed,
      env,
      engineKind: env.engine,
      emulatorOk: env.emulator.ok,
      emulatorVersion: env.emulator.version,
      sysimgOk: env.sysimg.ok,
      sysimgNote: env.sysimg.note,
      accel: env.accel,
      vmRunning: this.emulator.running() || !!(this.vmProc && !this.vmProc.killed),
      vmStarting: this.vmStarting,
      installing: this.installing,
      adbOk: env.adb.ok,
      adbVersion: env.adb.version,
      qemuOk: env.qemu.ok,
      qemuVersion: env.qemu.version,
      deviceOnline: false,
      android: '',
      sdk: 0,
      freeform: false,
      ready: false,
      needsSetup: null,
      error: '',
      serial: this.emuSerial,
      autoProfile: this.emulator.profile ? doctor.describeProfile(this.emulator.profile) : '',
      diagnosis: this.emulator.lastDiagnosis || null,
      attempts: this.emulator.attempts || [],
      // "Why it didn't start last time": fall back to the persisted record when memory is empty, so Settings/diagnostics show the real cause
      lastFailure: (this.emulator.lastFailure ? this.emulator.lastFailure() : null),
    };

    if (!env.adb.ok) {
      result.needsSetup = 'adb';
      result.error = t('adb is missing. Run setup on the Runtime page to download it automatically.');
      return result;
    }

    try {
      result.deviceOnline = await client.isOnline();
      if (result.deviceOnline) {
        const [android, sdk, ff] = await Promise.all([
          client.androidVersion().catch(() => ''),
          client.sdkInt().catch(() => 0),
          client.shell('settings get global enable_freeform_support').catch(() => '0'),
        ]);
        result.android = android;
        result.sdk = sdk;
        result.freeform = String(ff).trim() === '1' || this._freeformReady;
      }
    } catch (e) {
      result.error = e.message;
    }

    if (result.deviceOnline) result.ready = true;
    else if (!env.emulator.ok) result.needsSetup = 'emulator';
    else if (!env.sysimg.ok) result.needsSetup = 'sysimg';
    // Missing hardware acceleration is no longer a blocking step: doctor falls back to software emulation
    // and on boot failure retries GPU/acceleration/memory combinations in turn.
    else result.needsSetup = 'boot';

    result.phase = result.deviceOnline
      ? 'ready'
      : this.installing
        ? 'installing'
        : result.vmRunning
          ? 'booting'
          : 'idle';

    return result;
  }

  /** Advanced mode: detect an existing runtime on this PC (non-default) */
  async probe() {
    const adbPath = this.adbPath();
    const one = (ep) => new Promise((resolve) => {
      const c = new AdbClient({ adbPath, serial: ep.serial });
      const timer = setTimeout(() => resolve(null), 4000);
      c.isOnline().then((online) => {
        clearTimeout(timer);
        if (!online && ep.serial.includes(':')) return c.connect().then((ok) => (ok ? ep : null));
        return online ? ep : null;
      }).then(resolve).catch(() => { clearTimeout(timer); resolve(null); });
    });
    const found = await Promise.all(ATTACH_ENDPOINTS.map(one));
    return found.filter(Boolean);
  }

  // ---------------- Start / stop the VM ----------------

  buildArgs({ install = false, headless = false } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const hv = this._hv || { whpx: false };
    const disk = s.runtime.diskPath || p.disk;
    const iso = s.runtime.isoPath || p.iso;
    const accel = hv.whpx ? 'whpx' : 'tcg';

    const args = [
      '-name', 'ApkStart Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', hv.whpx ? 'host' : 'max',
      '-smp', String(Math.max(2, s.engine.cores || 4)),
      '-m', String(s.engine.memoryMB || 4096),
      '-rtc', 'base=localtime',
      '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555',
      '-device', 'virtio-net-pci,netdev=net0',
      '-vga', 'std',
      '-usb', '-device', 'usb-tablet',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (headless || s.runtime.headless) args.push('-display', 'none');

    if (install) {
      args.push('-boot', 'order=d');
      args.push('-cdrom', iso);
    } else {
      args.push('-boot', 'order=c');
    }
    args.push('-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`);
    return args;
  }

  async boot({ install = false, onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    this._hv = env.hypervisor;

    // Preferred: the official emulator (own device model and GPU translation, best experience)
    if (env.emulator.ok && env.sysimg.ok) {
      return this.bootEmulator({ env, onLog });
    }

    return this.bootQemu({ install, env, onLog });
  }

  /**
   * Boot Android with the official emulator.
   * Unlike QEMU+ISO there is no "install the OS" step: the image is the system and boots on first start.
   */
  async bootEmulator({ env, onLog = () => {} } = {}) {
    if (this.vmStarting) {
      const started = Date.now();
      while (this.vmStarting && Date.now() - started < 300000) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
      }
      const c = this.client();
      if (await c.isOnline()) {
        await this.prepare(c);
        return { ok: true, client: c, reused: true };
      }
    }

    const accel = env && env.accel ? env.accel : await this.provisioner.emulatorAccel();
    if (!accel.ok) {
      onLog(t('No hardware acceleration detected: falling back to software emulation (the first boot will be noticeably slower; nothing to configure)'));
    }

    this.vmStarting = true;
    try {
      // The probe runs inside EmulatorEngine's boot loop: on process exit / fatal log lines it retries with other flags.
      // One adb command per round: it used to spawn three processes (get-state + getprop + pm path),
      // costing 300-500ms per round during a snapshot restore - right when the user is opening an app.
      let probeStart = Date.now();
      let errStreak = 0;
      let lastHeal = 0;
      const probe = async ({ serial }) => {
        if (!this.emulator.running()) return 'fatal';
        if (!this._probeClient || this._probeClient.serial !== serial) {
          this._probeClient = new AdbClient({ adbPath: this.adbPath(), serial });
        }
        const c = this._probeClient;
        try {
          const out = String(await c.shell('getprop sys.boot_completed; pm path android', { timeout: 8000 }));
          const lines = out.split(/\r?\n/).map((l) => l.trim());
          const booted = lines[0] === '1' || /^1$/.test(lines[0] || '');
          const pmReady = lines.some((l) => /^package:/.test(l));
          errStreak = 0;
          if (booted && pmReady) return 'ok';
          return booted ? 'pending' : 'booting';
        } catch (_) {
          errStreak += 1;
          // The adb transport occasionally gets stuck offline / unauthorized (another adb server grabbed the port,
          // or the handshake was interrupted); then every shell call fails and the probe stays pending -
          // the caller only sees "boot timed out" after a wasted 240s. After 6 errors in a row, restart the server once.
          const now = Date.now();
          if (errStreak >= 6 && now - probeStart > 25000 && now - lastHeal > 30000) {
            lastHeal = now;
            onLog(t('adb connection problem; restarting the adb server and waiting…'));
            await this.emulator.resetAdbServer().catch(() => {});
            this._probeClient = null;
          }
          return 'pending';
        }
      };

      const st = await this.emulator.start({
        headless: this.settings.engine.headless !== false,
        onLog,
        probe,
      });
      // start() reports failure by returning {ok:false} rather than throwing (low disk, repeated failures, etc.).
      // The old code ignored this field and returned ok:true - the caller thought it was ready,
      // then adb spat "device not found" and the user saw "nothing happens" instead of the real cause.
      if (!st || st.ok === false) {
        return {
          ok: false,
          error: (st && st.error) || t('The Android runtime failed to start'),
          needsSpace: !!(st && st.needsSpace),
          attempts: (st && st.attempts) || [],
          diagnosis: this.emulator.lastDiagnosis,
          exitCode: st && st.exitCode,
        };
      }
      this.lastActivity = Date.now();
      this.emuSerial = st.serial || this.emulator.serial;
      const client = this.client(this.emuSerial);
      await this.prepare(client);
      // Save the snapshot "when idle": saving now writes 1-3GB and competes for disk I/O with the app just opened
      this._armSnapshotSave(20000);
      return { ok: true, client, engine: 'emulator', serial: this.emuSerial, profile: st.profile, network: st.network || null };
    } catch (e) {
      // Pass the retry/diagnosis verdict to the UI as is, instead of wrapping it in a vague "failed to start"
      return { ok: false, error: e.message, diagnosis: e.diagnosis, report: e.report, attempts: e.attempts };
    } finally {
      this.vmStarting = false;
    }
  }

  // ---------------- Prewarm (keep the environment resident, like WSA) ----------------

  /** Save the quickboot snapshot when idle: only write to disk with no app windows open, to avoid competing with app launches for I/O */
  _armSnapshotSave(delay = 20000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), {
      delay,
      isIdle: () => this._activeApps.size === 0,
    });
  }

  /** For the installer etc.: save a fresh snapshot after installing an app, so the next boot is still instant */
  scheduleSnapshotSave(delay = 12000) { this._armSnapshotSave(delay); }

  /**
   * Prewarm: boot the Android environment in the background before the user opens an app.
   * Same idea as WSA: the environment stays resident, so tapping an icon is just one am start.
   *  - Fully silent: no dialogs, no errors; failure doesn't affect opening apps normally;
   *  - Idempotent: while booting or ready it reuses the same Promise, never launching a second VM;
   *  - Frugal: after boot, qemu is parked at the lowest priority.
   */
  prewarm({ onLog = () => {} } = {}) {
    if (this._prewarmPromise) return this._prewarmPromise;
    if (this._activeApps.size > 0) return Promise.resolve({ ok: true, skipped: 'busy' });
    // Advanced mode reuses someone else's already-running runtime; don't start one of our own for the user
    if (this.settings.engine.mode === 'attach') return Promise.resolve({ ok: false, skipped: 'attach' });
    const t0 = Date.now();
    const p = (async () => {
      try {
        const env = await this.provisioner.checkEnv();
        if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) return { ok: false, skipped: 'not-ready' };
        const r = await this.ensure({ onLog: (m) => onLog(`prewarm: ${m}`) });
        if (r && r.ok) {
          // The user may have opened an app during prewarm: don't push it down to idle priority then
          if (this._activeApps.size === 0) await this.emulator.setPriority('idle').catch(() => {});
          const ms = Date.now() - t0;
          this.log(`Prewarm done (${Math.round(ms / 1000)}s)`);
          return { ok: true, bootMs: ms };
        }
        return { ok: false, error: r && r.error };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
    this._prewarmPromise = p;
    const clear = () => { if (this._prewarmPromise === p) this._prewarmPromise = null; };
    p.then(clear, clear);
    return p;
  }

  async bootQemu({ install = false, env, onLog = () => {} } = {}) {
    if (!env.qemu.ok) throw new Error(t('QEMU is not installed. Finish runtime setup first.'));
    if (install && !env.iso.ok) throw new Error(t('The system image (ISO) is not ready'));

    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.disk;
    if (!install && !fs.existsSync(disk)) throw new Error(t('Android has not been installed to the virtual disk yet'));

    this.vmStarting = true;
    const args = this.buildArgs({ install });
    const logFile = path.join(LOG_DIR, install ? 'qemu-install.log' : 'qemu.log');
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n\n=== ${new Date().toISOString()} ${install ? 'INSTALL' : 'BOOT'} ===\n${env.qemu.path} ${args.join(' ')}\n`);

    onLog(env.hypervisor.whpx
      ? t('Starting runtime (WHPX hardware acceleration)…')
      : t('Starting runtime (software emulation only)…'));
    if (!env.hypervisor.whpx) onLog(env.hypervisor.note);

    const proc = spawn(env.qemu.path, args, {
      cwd: path.dirname(env.qemu.path),
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    this.vmProc = proc;
    this.installing = install;
    this.lastActivity = Date.now();

    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      onLog(t('Failed to start: {error}', { error: e.message }));
      this.vmProc = null;
      this.vmStarting = false;
    });
    proc.on('exit', (code) => {
      this.log(`qemu exit ${code}`);
      onLog(t('Runtime exited (code={code})', { code }));
      this.vmProc = null;
      this.vmStarting = false;
      this.installing = false;
    });

    await new Promise((r) => setTimeout(r, 1500));
    this.vmStarting = false;
    if (!this.vmProc) throw new Error(t('QEMU failed to start. See the log: {file}', { file: logFile }));

    // Install mode: the ISO holds a Linux installer with no adb, so don't wait for adb
    if (install) {
      onLog(t('The installer has started. Follow the steps in the VM window to finish installing.'));
      return { ok: true, install: true, needsManualInstall: true };
    }

    const client = this.client('127.0.0.1:5555');
    const timeout = env.hypervisor.whpx ? 180000 : 900000;
    const linked = await this.waitAdb(client, timeout, onLog);
    if (!linked) {
      return {
        ok: false,
        error: t('The VM started, but adb could not connect. Enable "Developer options → ADB over network" in the VM and try again.'),
      };
    }
    const ready = await this.waitAndroidReady(client, Math.max(60000, timeout / 2), onLog);
    if (!ready.ok) {
      return {
        ok: false,
        error: ready.stage === 'kernel'
          ? t('The Android kernel did not finish booting. Check the runtime log (the image may be damaged, or acceleration is not working).')
          : t('Android booted, but system services are not ready (it may be stuck on the first-boot setup screen; finish the wizard in the VM window).'),
      };
    }
    await this.prepare(client);
    return { ok: true, client };
  }

  /**
   * Wait until Android is really usable: adb online != system usable.
   * Must wait for sys.boot_completed=1 and a responsive package manager, or am start fails outright.
   */
  async waitAndroidReady(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let bootCompleted = false;
    let lastNotice = 0;
    while (Date.now() - start < timeoutMs) {
      /* eslint-disable no-await-in-loop */
      const online = await client.isOnline();
      if (!online) {
        await client.connect().catch(() => false);
      } else {
        if (!bootCompleted) {
          const v = await client.shell('getprop sys.boot_completed').catch(() => '');
          if (String(v).trim() === '1') {
            bootCompleted = true;
            onLog(t('Android kernel started, waiting for system services… ({s}s)', { s: Math.round((Date.now() - start) / 1000) }));
          }
        }
        if (bootCompleted) {
          const pm = await client.shell('pm path android').catch(() => '');
          if (/package:/.test(pm)) {
            onLog(t('Android is ready ({s}s)', { s: Math.round((Date.now() - start) / 1000) }));
            return { ok: true, ms: Date.now() - start };
          }
        }
      }
      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        onLog(bootCompleted
          ? t('Waiting for system services… {s}s', { s: Math.round((Date.now() - start) / 1000) })
          : t('Booting Android… {s}s', { s: Math.round((Date.now() - start) / 1000) }));
      }
      /* eslint-enable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, stage: bootCompleted ? 'services' : 'kernel', ms: Date.now() - start };
  }

  async waitAdb(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let lastNotice = 0;
    const needConnect = String(client.serial || '').includes(':')
      && !/^emulator-/.test(client.serial);
    while (Date.now() - start < timeoutMs) {
      // Serials like emulator-5554 are registered by the emulator itself; no adb connect needed
      if (needConnect) {
        // eslint-disable-next-line no-await-in-loop
        await client.connect().catch(() => false);
      }
      // eslint-disable-next-line no-await-in-loop
      if (await client.isOnline()) return true;
      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        onLog(t('Waiting for Android to start… {s}s', { s: Math.round((Date.now() - start) / 1000) }));
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepare(client) {
    if (!this._freeformReady) {
      try { this._freeformReady = await client.ensureFreeform(); } catch (_) { /* ignore */ }
    }
    this.startWatchdog();
  }

  /** Graceful stop: the emulator shuts down via its console, QEMU via the monitor */
  async stop({ graceful = true } = {}) {
    const adbPath = this.adbPath();
    if (this.emulator.running()) {
      await this.emulator.stop({ adbPath });
      return true;
    }
    // An adopted emulator (adoptExisting) has no proc handle in this process; the old logic just
    // returned false - so the idle watchdog could never shut it down and the container kept eating CPU/RAM.
    // This path shuts it down via the adb console, force-killing by port as a last resort.
    //
    // Note: emulator.exe is only a launcher and exits after spawning qemu, so machines we started ourselves
    // often land here too. saveSnapshotNow must run before shutdown, or the snapshot is never saved
    // and every launch is a full cold boot (this step is the 25s vs 8s difference).
    let online = false;
    try { online = await this.client().isOnline(); } catch (_) { /* ignore */ }
    if (online && this.emuSerial) {
      if (adbPath && this.emulator.snapshotWorthSaving !== false) {
        await this.emulator.saveSnapshotNow(adbPath, { timeout: 60000 }).catch(() => false);
      }
      await this.client().exec(['emu', 'kill'], { timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 400));
        // eslint-disable-next-line no-await-in-loop
        const still = await this.client().isOnline().catch(() => false);
        if (!still) break;
      }
      const still = await this.client().isOnline().catch(() => false);
      if (still) {
        const m = /:(\d+)$/.exec(this.emuSerial);
        const port = m ? Number(m[1]) - 1 : this.emulator.port;
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
      }
      this._activeApps.clear();
      return true;
    }
    if (!this.vmProc) return false;
    if (graceful) {
      try { await this.monitorCmd('system_powerdown'); } catch (_) { /* ignore */ }
      for (let i = 0; i < 16; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        if (!this.vmProc) return true;
      }
      try { await this.monitorCmd('quit'); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
    return true;
  }

  // ---------------- QEMU monitor ----------------

  monitorCmd(cmd, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: MONITOR_PORT });
      let buf = '';
      let sent = false;
      const done = (err, data) => {
        try { sock.destroy(); } catch (_) { /* ignore */ }
        if (err) reject(err); else resolve(data);
      };
      sock.setTimeout(timeout, () => done(new Error('QEMU monitor timed out')));
      sock.on('error', (e) => {
        // QEMU drops the connection after commands like quit (ECONNRESET/EPIPE); that's normal
        if (sent && /ECONNRESET|EPIPE/i.test(e.code || String(e))) done(null, buf);
        else done(e);
      });
      sock.on('data', (c) => {
        buf += c.toString();
        if (!sent && buf.includes('(qemu)')) {
          sent = true;
          sock.write(`${cmd}\n`);
          setTimeout(() => done(null, buf), 300);
        }
      });
      sock.on('connect', () => {
        if (!cmd) setTimeout(() => done(null, buf), 250);
      });
    });
  }

  async sendKey(keys, delay = 140) {
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await this.monitorCmd(`sendkey ${k}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ---------------- Install the OS to the virtual disk ----------------

  async startInstaller({ onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    if (!env.iso.ok) {
      throw new Error(env.iso.reason || t('Download or import the Android system image (ISO) first'));
    }
    if (!env.disk.ok) await this.provisioner.createDisk(this.settings.runtime.diskSizeGB || 24, () => {});
    this.installing = true;
    const r = await this.boot({ install: true, onLog });
    if (!r.ok) throw new Error(r.error || t('Failed to start the installer environment'));
    return r;
  }

  /** After installation: close the installer -> write the marker -> boot from disk from then on */
  async markInstalled() {
    if (this.installing) {
      try { await this.stop({ graceful: true }); } catch (_) { /* ignore */ }
    }
    store.saveSettings({ runtime: { installed: true } });
    this.installing = false;
    return true;
  }

  // ---------------- ensure ----------------

  /**
   * Take over the emulator left running by the previous session.
   * Each emulator has its own console port (5554/5556/...), and its adb port is +1.
   * If the port connects and the system has boot_completed, use it as our runtime directly,
   * so "close ApkStart, then open an app" is instant instead of cold-booting another one.
   */
  /**
   * Find all live emulator console ports.
   * Don't scan sequentially from 5554: ports drift upward across launches (5554 -> 5556 -> 5558...),
   * a fixed range always misses one sooner or later, and a miss starts yet another machine. Instead find
   * every TCP port qemu listens on by process name, so none are missed.
   */
  async emulatorPorts() {
    const run = (cmd, args) => new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        resolve(err ? '' : String(out || ''));
      });
    });
    const ports = new Set();
    try {
      const tl = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const pids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) pids.add(m[2]);
      }
      if (!pids.size) return [];
      const ns = await run('netstat', ['-ano', '-p', 'TCP']);
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && pids.has(m[2])) ports.add(Number(m[1]));
      }
    } catch (_) { /* fall back to port probing */ }

    if (ports.size) {
      // Both the console port (even) and the adb port (+1) listen; keep only console ports
      const all = [...ports].sort((a, b) => a - b);
      const consoles = all.filter((p) => ports.has(p + 1));
      return consoles.length ? consoles : all;
    }
    // Fallback: without qemu process info, probe directly (refused connections return instantly, cheap)
    const found = [];
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await portAlive(port, 120)) found.push(port);
    }
    return found;
  }

  async adoptExisting({ onLog = () => {} } = {}) {
    const alive = await this.emulatorPorts();
    if (!alive.length) {
      onLog(t('No previous runtime found; preparing a cold boot'));
      return null;
    }
    onLog(t('Found {n} leftover runtimes (ports {ports}); trying to take over', { n: alive.length, ports: alive.join(', ') }));

    // The adb server may still hold an offline record from the previous process (happens if the emulator restarted adbd);
    // clear it before connecting, or get-state keeps returning offline and a healthy machine gets killed as "not ready".
    await this.client().exec(['kill-server'], { withSerial: false, timeout: 8000 }).catch(() => {});

    for (const port of alive) {
      const serial = `127.0.0.1:${port + 1}`;
      const c = this.client(serial);
      let booted = '';
      for (let i = 0; i < 6 && booted !== '1'; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await c.connect().catch(() => false);
        // eslint-disable-next-line no-await-in-loop
        const state = (await c.exec(['get-state'], { timeout: 5000 }).then((r) => r.stdout).catch(() => '')).trim();
        if (state === 'device') {
          // eslint-disable-next-line no-await-in-loop
          booted = (await c.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '')).trim();
        }
        if (booted !== '1') await new Promise((r) => setTimeout(r, 700));
      }
      if (booted !== '1') {
        onLog(t('Found the previous runtime ({serial}) but it is not ready; shutting it down and booting again', { serial }));
        // It holds the AVD lock: leaving it makes the new instance exit immediately ("never boots no matter what").
        // adb can't even connect, so the only option is to find the process by console port and force-kill it.
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            const { execFile } = require('child_process');
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      this.emuSerial = serial;
      this.emulator.port = port;
      store.saveSettings({ device: serial });
      onLog(t('Took over the running runtime ({serial})', { serial }));
      // eslint-disable-next-line no-await-in-loop
      await this.prepare(c);
      return { ok: true, client: c, engine: 'emulator', reused: true };
    }
    return null;
  }

  /** Which process listens on a TCP port (used to force-kill a hung emulator) */
  async pidOnPort(port) {
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(0);
        const line = stdout.split('\n').find((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l));
        const m = line && /(\d+)\s*$/.exec(line.trim());
        return resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /**
   * Clean up orphan emulators left by the previous run that weren't adopted.
   * The emulator is detached, so qemu survives closing ApkStart; on the next launch it still holds the AVD lock,
   * and the cold boot dies with FATAL "Running multiple emulators with the same AVD".
   * The implementation lives in EmulatorEngine; the retry path (killAttempt) uses the same logic.
   */
  async killOrphanEmulators({ onLog = () => {} } = {}) {
    return this.emulator.killOrphanProcesses({ onLog });
  }

  /**
   * Idempotent entry point: prewarm and a user click can happen at the same time; they share one Promise,
   * so the two sides don't each decide "not online" and launch an emulator each (AVD lock clash + double RAM).
   */
  async ensure({ onLog = () => {} } = {}) {
    if (this._ensurePromise) return this._ensurePromise;
    const p = this._ensureInner({ onLog });
    this._ensurePromise = p;
    const clear = () => { if (this._ensurePromise === p) this._ensurePromise = null; };
    p.then(clear, clear);
    return p;
  }

  async _ensureInner({ onLog = () => {} } = {}) {
    const client = this.client();
    if (await client.isOnline()) {
      await this.prepare(client);
      return { ok: true, client, engine: 'builtin', reused: true };
    }

    // The emulator stays alive after ApkStart exits (so the next open is instant), but the new process has no
    // handle to it and the adb server may have restarted - isOnline() alone would say "no runtime"
    // and start another one. Adopt the live emulator first, to avoid duplicate machines eating RAM.
    const adopted = await this.adoptExisting({ onLog });
    if (adopted) return adopted;

    // An emulator left by the last session / started by another process: reuse it even on another port, never start a second one
    try {
      const devices = await client.devices();
      const running = devices.find((d) => /^emulator-\d+$/.test(d.serial) && d.state === 'device');
      if (running) {
        this.emuSerial = running.serial;
        const m = /(\d+)$/.exec(running.serial);
        if (m) this.emulator.port = Number(m[1]);
        const c2 = this.client(running.serial);
        await this.prepare(c2);
        return { ok: true, client: c2, engine: 'emulator', reused: true };
      }
    } catch (_) { /* none found: boot normally */ }

    // Process alive but device offline (most likely stuck booting): stop it and boot again instead of waiting
    if (this.emulator.running()) {
      onLog(t('Detected a stuck runtime; restarting…'));
      await this.emulator.stop({ adbPath: this.adbPath() });
    }

    const s = this.settings;

    // Advanced mode: connect to an existing runtime
    if (s.engine.mode === 'attach') {
      onLog(t('Looking for an existing runtime…'));
      const found = await this.probe();
      if (found.length) {
        store.saveSettings({ device: found[0].serial });
        const c2 = this.client(found[0].serial);
        if (await c2.isOnline()) {
          await this.prepare(c2);
          return { ok: true, client: c2, engine: found[0].name };
        }
      }
      return { ok: false, needsSetup: 'attach', error: t('No usable existing runtime found') };
    }

    // Default: the bundled runtime
    // The single-file build ships compressed images; unpack them first (instant if already unpacked).
    // Don't swallow unpack errors: otherwise checkEnv() just says "system image missing"
    // and the user thinks it was never downloaded, not that unpacking failed (disk full / corrupted file).
    await this.provisioner.materializeImages(onLog).catch((e) => {
      onLog(t('Failed to unpack the system image: {error}', { error: e.message }));
      this.log(`materialize failed: ${e.message}`);
    });
    const env = await this.provisioner.checkEnv();

    // Emulator path: the image is the system, no "install to disk" step
    if (env.emulator.ok && env.sysimg.ok) {
      // After closing ApkStart an un-adopted emulator may linger (detached qemu still alive),
      // holding the AVD lock so the cold boot dies with FATAL "Running multiple emulators with the same AVD".
      // When adoption fails, clear these orphans before cold-booting so "close and reopen" always works.
      await this.killOrphanEmulators({ onLog }).catch(() => {});
      try {
        const r = await this.boot({ onLog });
        if (r.ok) return { ok: true, client: r.client, engine: 'emulator', profile: r.profile, network: r.network || null };
        return {
          ok: false, error: r.error, env,
          diagnosis: r.diagnosis, report: r.report, attempts: r.attempts, exitCode: r.exitCode,
        };
      } catch (e) {
        return { ok: false, error: e.message, env };
      }
    }

    // QEMU path (user-supplied ISO already installed to the virtual disk)
    if (!s.runtime.installed) {
      return {
        ok: false,
        needsSetup: env.emulator.ok ? 'sysimg' : 'provision',
        error: env.emulator.ok
          ? t('The system image is still missing. Download it on the Runtime page.')
          : t('Runtime components are not set up yet'),
        env,
      };
    }

    try {
      const r = await this.boot({ onLog });
      if (r.ok) return { ok: true, client: r.client, engine: 'builtin' };
      return { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------------- Per-app container sessions ----------------

  /**
   * How "open like a container" works:
   * Android boots once and stays resident (quickboot snapshot + adoptExisting takeover);
   * after that, opening an app is just am start + attaching its existing window, without rebooting the system.
   * Three extra things reduce system load:
   *   - stop other user apps' processes so the environment only runs what the current app needs;
   *   - while a window is open, give qemu a priority that yields to the foreground;
   *   - file sync / notification polling only run while a window is open (handed to the UI via onActive).
   */
  async beginApp(pkg, { onActive = () => {} } = {}) {
    const first = this._activeApps.size === 0;
    this._activeApps.add(pkg);
    this.touch();
    const state = container.nextSessionState([...this._activeApps], 'open', pkg);
    const s = this.settings;
    const mode = (s.engine && s.engine.priorityMode) || 'balanced';
    // Scheduling level while an app is in the foreground. balanced uses normal (not below):
    // below lets qemu starve when the system is busy - dropped video frames, taps that respond late -
    // the main cause of "input doesn't keep up". normal is just on par with the desktop and doesn't take extra CPU/RAM/GPU.
    const level = mode === 'game' ? 'game' : 'normal';

    if (first) {
      // An app is about to open: postpone the "save snapshot when idle", don't compete for disk during app launch
      this.emulator.cancelSnapshotSave();
    }
    // Ensure the priority on every open/switch back: endApp drops an idle qemu to idle,
    // and without raising it again on switch-back it stays low -> sluggish input. setPriority is idempotent;
    // when already at the target the script changes nothing and costs very little.
    await this.emulator.setPriority(level).catch(() => {});
    if (first) {
      try { onActive(true); } catch (_) { /* a failure to start polling must not block opening the app */ }
    }

    const installed = store.getApps().map((a) => a && a.package).filter(Boolean);
    const plan = container.buildSessionCommands({
      pkg,
      installed,
      deep: !!(s.engine && s.engine.deepTrim),
      // The app was just am-started; clearing background now might hit a process coming to the foreground, so cleanup happens in endApp
      killBackground: false,
    });
    if (plan.commands.length) {
      await this.client().shell(plan.commands.join(' ; '), { timeout: 20000 }).catch(() => '');
    }
    this.log(container.describeSession(state, plan));
    return { ...state, plan };
  }

  /**
   * Close an app window: stop its processes; if it was the last window, put the container into
   * a "resident but nearly idle" parked state (clear background + Android idle + lower qemu priority).
   * No shutdown, no AVD deletion - the next open is still instant.
   */
  async endApp(pkg, { onIdle = () => {} } = {}) {
    this._activeApps.delete(pkg);
    await this.client().forceStop(pkg).catch(() => {});
    const state = container.nextSessionState([...this._activeApps], 'close', pkg);
    if (state.idle) {
      const s = this.settings;
      const cmds = container.buildIdleCommands({ deep: !!(s.engine && s.engine.deepTrim) });
      await this.client().shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => '');
      // In game mode keep high priority even with no app window for now,
      // otherwise the next open has to raise it again and the first input lags noticeably.
      const keepHigh = (s.engine && s.engine.priorityMode) === 'game';
      await this.emulator.setPriority(keepHigh ? 'normal' : 'idle').catch(() => {});
      // Most idle right now: save RAM state as a snapshot so the next boot restores instead of cold-booting
      this._armSnapshotSave(8000);
      try { onIdle(true); } catch (_) { /* ignore */ }
      this.log('Container parked (Android resident, 0 app processes, qemu at lowest priority)');
    }
    return state;
  }

  get activeApps() { return [...this._activeApps]; }
  get containerIdle() { return this._activeApps.size === 0; }

  /** Restore disabled system packages when Settings toggles "deep trim" */
  async restoreSystemApps() {
    const cmds = container.buildRestoreCommands();
    await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
    return true;
  }

  setGuestPriority(level) { return this.emulator.setPriority(level); }

  // ---------------- Idle reclaim ----------------

  startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(async () => {
      const s = this.settings;
      const limit = (s.engine.idleShutdownMinutes || 0) * 60000;
      if (!limit) return;
      // An adopted emulator has no local proc handle, so vmRunning is false:
      // this used to return here and the container was never reclaimed. Now also check whether adb is online.
      if (!this.vmRunning) {
        const online = await this.client().isOnline().catch(() => false);
        if (!online) return;
      }
      if (this._activeApps.size > 0 || Date.now() - this.lastActivity < limit) return;
      try {
        const running = await this.client().runningPackages();
        const alive = running.filter((p) => !/launcher|systemui|settings|inputmethod|android\.systemui/i.test(p));
        if (alive.length === 0) await this.stop();
        else this.lastActivity = Date.now();
      } catch (_) { /* ignore */ }
    }, 60000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  get vmRunning() { return this.emulator.running() || !!(this.vmProc && !this.vmProc.killed); }

  // ---------------- Diagnostics / slimming (called from the UI) ----------------

  async diagnostics() {
    const env = this.provisioner.paths();
    const checked = await this.provisioner.checkEnv();
    const profile = this.emulator.profile || doctor.autoProfile({
      settings: this.settings,
      accel: checked.accel,
      emulatorVersion: checked.emulator.version || '',
      diskMB: doctor.freeDiskMB(store.DATA_DIR),
    });
    // In-memory attempts only cover this session; after a restart they're empty when the report is exported.
    // Use the last persisted failure record then, plus the tail of emulator.log - otherwise the report
    // says only UNKNOWN and the real cause is hidden (issues #20/#25 both tripped on this).
    const persisted = this.emulator.lastFailure ? this.emulator.lastFailure() : null;
    const liveAttempts = this.emulator.attempts || [];
    const attempts = liveAttempts.length ? liveAttempts : ((persisted && persisted.attempts) || []);
    const diagnosis = this.emulator.lastDiagnosis || (persisted && persisted.diagnosis) || null;
    const exitCode = this.emulator.lastExitCode != null ? this.emulator.lastExitCode
      : (persisted ? persisted.exitCode : null);
    let logLines = this.emulator.recentLog(300);
    if (!logLines.length && this.emulator.tailLogFile) logLines = this.emulator.tailLogFile(300);
    return doctor.writeReport({
      dataDir: store.DATA_DIR,
      profile,
      logLines,
      extra: {
        attempts,
        diagnosis,
        exitCode,
        exitMeaning: persisted && persisted.exitMeaning ? persisted.exitMeaning : '',
        lastFailure: persisted,
        runtimeDir: env.root,
        serial: this.emuSerial,
        bootLog: this.bootLog,
      },
    });
  }

  usage() { return require('./layers').summary(this.provisioner.paths().root); }

  /**
   * Reclaim old images / old AVDs / lock files / snapshots in the runtime.
   * Root cause of "clicking Clean up doesn't free anything": while the runtime was running, keepSnapshots excluded
   * the current AVD's quickboot snapshot (a ram.img of several GB), so a single-AVD setup had almost nothing to clean.
   * Callers can now pass includeSnapshots explicitly: stop the runtime first, then prune, so snapshots are really reclaimed.
   */
  async cleanup({ apply = false, aggressive = false, includeSnapshots = false } = {}) {
    let stoppedVm = false;
    if (includeSnapshots && this.vmRunning) {
      await this.stop().catch(() => {});
      stoppedVm = true;
    }
    const report = require('./layers').prune(this.provisioner.paths().root, {
      apply, aggressive, keepSnapshots: !includeSnapshots && this.vmRunning,
    });
    // If the VM was stopped during preview, tell the user: they can restart the runtime manually after cleanup
    return { ...report, apply, stoppedVm };
  }

  /**
   * Fully reset Android data (wipe the /data user partition + installed apps + quickboot snapshot),
   * returning the AVD to a clean "freshly installed system, no third-party apps" state.
   * This really deletes an 8-16GB user data image, so it needs a second confirmation (handled by the UI), and it only touches
   * the active AVD (apkstart.avd), never the read-only base image or other AVDs.
   * config.ini / hardware-qemu.ini are kept so the AVD stays valid; the next app launch cold-boots and rebuilds data.
   * @returns {{ok:boolean, reclaimed:number, avdDir:string, error?:string}}
   */
  async resetAndroidData() {
    const fs = require('fs');
    const path = require('path');
    try {
      if (this.vmRunning) await this.stop().catch(() => {});
      const avdDir = path.join(this.provisioner.paths().avdHome, 'apkstart.avd');
      let reclaimed = 0;
      if (fs.existsSync(avdDir)) {
        for (const e of fs.readdirSync(avdDir, { withFileTypes: true })) {
          const p = path.join(avdDir, e.name);
          // Delete: user data images (qcow2 overlay + base), quickboot snapshots, leftover lock files/dirs.
          // Keep: config.ini / hardware-qemu.ini / AVD.conf / cache.img / encryptionkey* / initrd /
          //       modem_simulator / all *.ini / *.txt / *.cache - they are the AVD's identity and infrastructure;
          //       deleting them breaks the AVD or the next boot. On the next app launch the emulator rebuilds /data like -wipe-data.
          const isUserdata = /^userdata(-qemu)?(-[0-9]+)?\.img(\.qcow2)?$/.test(e.name)
            || /^userdata\.img(\.qcow2)?\.\d+$/.test(e.name);
          const isSnapshot = /^snapshots(\.stale-\d+)?$/.test(e.name);
          const isLock = /\.lock$/.test(e.name);
          if (!e.isDirectory() && !isUserdata && !isLock) continue;
          if (e.isDirectory() && !isSnapshot && !isLock) continue;
          try {
            if (e.isDirectory()) {
              const s = require('./layers').dirSize(p);
              fs.rmSync(p, { recursive: true, force: true });
              reclaimed += s;
            } else {
              const s = fs.statSync(p).size;
              fs.rmSync(p, { force: true });
              reclaimed += s;
            }
          } catch (_) { /* in use: skip for now, clear it next time */ }
        }
      }
      // Once the user data image is gone, the "installed apps" record must be cleared too,
      // or the desktop/launcher keeps showing apps that no longer exist.
      try { store.saveApps([]); } catch (_) { /* ignore */ }
      return { ok: true, reclaimed, avdDir };
    } catch (e) {
      return { ok: false, reclaimed: 0, avdDir: '', error: e.message };
    }
  }

  /**
   * Wait for the VM to get network.
   *
   * Observed: `sys.boot_completed` only means the system is up; Wi-Fi association + DHCP take
   * another ten-odd seconds to over a minute before 10.0.2.16 is assigned. Apps that load their home feed right away
   * render a solid black page without network (the privacy dialog is local, so it shows fine),
   * and the user sees "black screen after tapping Agree and continue". So wait for the network before launching the app.
   *
   * @returns {Promise<{ok:boolean,reason:string,ip?:string,gateway?:string}>}
   */
  async waitForNetwork({ timeoutMs = 90000, onLog = () => {}, adbPath = '' } = {}) {
    const t0 = Date.now();
    let last = null;
    let lastNotice = 0;
    let offlineSince = 0;
    while (Date.now() - t0 < timeoutMs) {
      const online = await this.client().isOnline().catch(() => false);
      if (!online) {
        // A just-restarted VM has a period where even adb isn't online; don't give up at the first offline
        // (that's what used to happen: device-offline right after a data reset, reported as "repair failed").
        if (!offlineSince) offlineSince = Date.now();
        if (Date.now() - offlineSince > 45000) return { ok: false, reason: 'device-offline' };
      } else {
        offlineSince = 0;
        // eslint-disable-next-line no-await-in-loop
        last = await this.emulator.checkNetwork(adbPath || this.adbPath()).catch(() => null);
        if (last && last.ok) return last;
      }
      if (Date.now() - lastNotice > 10000) {
        lastNotice = Date.now();
        onLog(t('Waiting for the Android VM to connect to the network… {s}s', { s: Math.round((Date.now() - t0) / 1000) }));
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 3000));
    }
    return last || { ok: false, reason: 'timeout' };
  }

  /**
   * Repair "the Android VM has no network".
   * Most of the time Wi-Fi association is just slower than boot completion; restarting and waiting fixes it,
   * **without** wiping user data; only after the wait times out is the user pointed to "Reset Android data".
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, error?:string}>}
   */
  /**
   * Make sure the VM has network: wait first; if that fails, cold-boot once (bypassing a possibly network-less snapshot) and wait again.
   * This is the real fix for "black screen after tapping Agree": apps must only launch once the network is ready.
   *
   * @returns {Promise<{ok:boolean,reason?:string,ip?:string,gateway?:string}>}
   */
  async ensureNetwork({ onLog = () => {}, firstWaitMs = 25000, secondWaitMs = 90000 } = {}) {
    let net = await this.waitForNetwork({ onLog, timeoutMs: firstWaitMs });
    if (net && net.ok) return net;
    // A cold boot is expensive (tens of seconds); do it only once per process, otherwise every app launch repeats it
    // and the user experiences "minutes to open an app".
    if (this._netColdBootTried) return net;
    this._netColdBootTried = true;
    onLog(t('Network still not ready; cold-booting the VM once (without the snapshot) and retrying…'));
    try {
      await this.stop({ graceful: false }).catch(() => {});
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) return { ok: false, reason: 'boot-failed' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    net = await this.waitForNetwork({ onLog, timeoutMs: secondWaitMs });
    if (net && net.ok) {
      // Save a snapshot as soon as the network works, so NIC state is restored with it next time
      try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
    }
    return net;
  }

  /**
   * Repair "the Android VM has no network".
   * Order: cold boot (data untouched) -> wait for network -> only then reset data (loses in-app data).
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, wiped?:boolean, error?:string}>}
   */
  async repairNetwork({ onLog = () => {} } = {}) {
    try {
      // Reset data directly: in testing this is the only reliable way to get this image online.
      // (Cold-booting and waiting 3 minutes first is wasted time - a cold boot on existing user data never connects to Wi-Fi.)
      onLog(t('Repairing the VM network: resetting Android data and rebooting (your app list is kept; apps are reinstalled when you open them)…'));
      if (this.vmRunning) await this.stop({ graceful: false }).catch(() => {});
      // Give the previous qemu / netsimd a moment to exit cleanly, or -wipe-data hits the AVD lock
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceWipeOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) {
        return { ok: false, error: (boot && boot.error) || t('The VM failed to start'), boot: false, wiped: true };
      }
      const network = await this.waitForNetwork({ onLog, timeoutMs: 240000 });
      if (network && network.ok) {
        // Save the "network OK" state as a snapshot right away: NIC state is restored with it next time,
        // otherwise closing and reopening brings back the no-network state.
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(t('Network restored ({ip}, gateway {gateway}); a working snapshot has been saved.', {
          ip: network.ip || '', gateway: network.gateway || t('reachable'),
        }));
      } else {
        onLog(t('Still no network after the reset. Check whether the host network or firewall is blocking the emulator (netsimd uses local loopback ports).'));
      }
      return { ok: !!(network && network.ok), network, boot: true, wiped: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  dispose() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._client && this._client.disposeInput) this._client.disposeInput();
    this.emulator.cancelSnapshotSave();
    // NEVER force-kill qemu here:
    //  1) a force-kill truncates a quickboot snapshot being written, leaving a ram.img shell of several GB;
    //     the next boot fails to load it -> full cold boot - the direct cause of "two minutes every time I open it";
    //  2) left alive, the next ApkStart launch can adopt it and apps open instantly (same behavior as WSA).
    // Uninstall takes a different path (app:removeSelf explicitly cleans up processes).
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
  }

  get bootLog() { return this._bootLog.slice(-60); }
}

module.exports = { Runtime, MONITOR_PORT };
