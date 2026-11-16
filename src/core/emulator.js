'use strict';
/**
 * Emulator engine: drives Google's official Android Emulator as the ApkStart runtime.
 *
 * The big difference from the old version: we no longer assume one set of flags works on every PC.
 *  1. doctor.chooseProfile() derives flags from RAM / CPU / disk / acceleration / engine version;
 *  2. on boot failure, planVariants() falls back step by step (GPU backend -> software emulation -> minimal-RAM cold boot);
 *  3. picks free ports dynamically, clears AVD locks, converts non-ASCII paths to short paths, invalidates snapshots when the image changes;
 *  4. quickboot snapshot + small data partition: a shared read-only base layer that restores in seconds, "like a container".
 *
 * The probe callback comes from the caller (Runtime) and decides whether Android is really ready.
 */
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');
const doctor = require('./doctor');
const userdata = require('./userdata');
const { t } = require('../i18n');

const AVD_NAME = 'apkstart';
const SNAPSHOT_NAME = 'apkstart';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Turn Windows emulator/qemu exit codes into plain words.
 * 0xC0000005 (3221225477) is the most common crash: an access violation, in practice
 * usually the GPU driver / Vulkan backend dying as the guest starts. Software rendering avoids it.
 *
 * Returns English (it is also written to logs and the failure record); callers that show it
 * in the UI wrap it in t(), and every value here has an Arabic entry.
 */
function describeExitCode(code) {
  // When killed by a signal the code is null (taskkill / adb emu kill on Windows both do this).
  // That is not a "normal exit", but not a crash either: return '' and let the caller show the raw code.
  if (code == null) return '';
  switch (Number(code)) {
    case 0: return 'Exited normally';
    case 1: return 'Bad launch arguments or environment';
    case 3221225477: return '0xC0000005 access violation, rendering backend crashed';
    case 3221225725: return '0xC00000FD stack overflow';
    case 3221225781: return '0xC0000135 missing DLL (VC++ runtime, or runtime files removed by antivirus)';
    case 3221225506: return '0xC0000022 access denied (driver or permission problem)';
    case 3221225595: return '0xC000007B image bitness mismatch or corrupted DLL';
    default: return '';
  }
}

class EmulatorEngine {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.proc = null;
    this._log = [];
    this.port = 5554;
    this.adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044;
    this.profile = null;
    this.attempts = [];
    this.lastDiagnosis = null;
    this.lastExitCode = null;
    // The snapshot's ram.bin is about the VM's RAM size (2-4GB).
    // Machines that cold-boot fast shouldn't pay gigabytes of disk for it; only save when boot is really slow.
    this.snapshotWorthSaving = null;
  }

  log(line) {
    this._log.push({ t: Date.now(), line });
    if (this._log.length > 600) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  /**
   * Persist the last boot failure to disk.
   * The old version kept it only in memory (this.attempts), so a diagnostic report exported after
   * restarting ApkStart showed attempts: [] and bootLog: [] - which is why the reports in
   * issues #20/#25 didn't reveal the cause.
   */
  _persistFailure(extra = {}) {
    try {
      const dir = path.join(store.DATA_DIR, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const data = {
        at: new Date().toISOString(),
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
        diagnosis: this.lastDiagnosis,
        attempts: this.attempts,
        ...extra,
      };
      fs.writeFileSync(path.join(dir, 'last-failure.json'), JSON.stringify(data, null, 2), 'utf8');
    } catch (_) { /* failing to persist must not affect the main flow */ }
  }

  /** Read back the last failure record (for the diagnostic report / pre-boot hints) */
  lastFailure() {
    try {
      return JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), 'utf8'));
    } catch (_) { return null; }
  }

  _clearFailure() {
    try { fs.rmSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), { force: true }); } catch (_) { /* ignore */ }
  }

  get serial() { return `emulator-${this.port}`; }

  /** emulator.exe and the system image dir (prefer the user runtime dir, fall back to engine/ in the repo) */
  locate() {
    const p = this.provisioner.paths();
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    const emulatorExe = emuCandidates.find((c) => fs.existsSync(c)) || '';
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, root: emulatorExe ? path.dirname(path.dirname(emulatorExe)) : p.root };
  }

  /** Pick the image: use the universal image (API 34 Play) if present; no more manual "compat mode" */
  imageChoice() {
    const play = this.provisioner.playImageInfo();
    const base = this.provisioner.systemImageInfo();
    if (play.ok) {
      return { compat: true, api: play.api, tag: play.tag, dir: play.dir, abi: 'x86_64' };
    }
    return { compat: false, api: base.api, tag: base.tag, dir: base.dir, abi: base.abi || this.provisioner.paths().sysAbi };
  }

  /**
   * Invalidate the quickboot snapshot.
   * The snapshot holds both RAM and disk state; loading an old one after installing an app or
   * clearing data makes "the app I just installed disappear after a restart".
   */
  invalidateSnapshot() {
    this.cancelSnapshotSave();
    this._snapSaved = false;
    try {
      const snapDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots');
      fs.rmSync(snapDir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Remove locks left by an abnormal exit.
   * Note hardware-qemu.ini.lock is a **directory**, not a file; a plain rmSync(force) can't delete it,
   * and then the emulator keeps failing with "Running multiple emulators with the same AVD"
   * (happens after a single force-kill). It must be removed recursively.
   */
  clearLocks(avdDir) {
    try {
      for (const f of fs.readdirSync(avdDir)) {
        if (!/\.lock$/i.test(f)) continue;
        try {
          fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
        } catch (_) { /* in use: skip, clear it next time */ }
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * Whether the AVD has a **complete** quickboot snapshot.
   * "Directory not empty" isn't enough: an interrupted save leaves a shell with a 12-byte snapshot.pb;
   * the emulator tries to load it, fails ("does not have the requested snapshot") and falls back to
   * a cold boot, wasting seconds. Check file sizes, and clean up shells and the legacy default_boot (3GB).
   */
  hasSnapshot() {
    const base = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
    const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
    const pb = size(path.join(base, 'snapshot.pb'));
    // Newer emulators (37.x) write ram.bin, older ones ram.img.
    // Checking only ram.img is very costly: a freshly saved 3GB snapshot gets deleted as a shell,
    // every boot gets -no-snapshot-load and cold-boots forever - half of the "slow to open" problem.
    const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
    if (pb > 1024 && ram > 1024 * 1024) return true;
    if (pb === 0 && ram === 0) return false;   // nothing there, nothing to delete
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    this._cleanLegacySnapshots();
    return false;
  }

  /** Remove legacy / failed-rename snapshot dirs (ram.img in default_boot can reach 3GB) */
  _cleanLegacySnapshots() {
    const dir = path.dirname(path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (name === SNAPSHOT_NAME) continue;
      if (/^default_boot$|\.stale-\d+$/i.test(name)) {
        try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * Kill orphan emulators holding the AVD lock.
   * emulator.exe is only a launcher; the real qemu is spawned as a separate (detached) process,
   * so killing our own proc handle often leaves an orphan holding multiinstance.lock, and the next
   * boot dies with FATAL "Running multiple emulators with the same AVD".
   * Two sources: the pid in the AVD lock, plus qemu/emulator processes listening on ports.
   */
  async killOrphanProcesses({ onLog = () => {} } = {}) {
    if (process.platform !== 'win32') return 0;
    const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);

    // Fast path (hit on every cold boot):
    //  - no .lock -> no live emulator can hold this AVD, return;
    //  - lock but nothing listening -> just leftovers from a force-kill, clear them.
    // The old code always ran wmic (1-3s, CPU heavy), noticeably slowing cold boots.
    let locks = [];
    try { locks = fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)); } catch (_) { locks = []; }
    if (!locks.length) return 0;
    if (!(await this._anyEmulatorPortAlive())) {
      this.clearLocks(avdDir);
      return 0;
    }

    const pids = new Set();
    // 1) The pid the emulator wrote into its lock (most reliable)
    try {
      const f = path.join(avdDir, 'hardware-qemu.ini.lock', 'pid');
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (pid) pids.add(pid);
      }
    } catch (_) { /* ignore */ }
    // 2) Fallback: live qemu by process name + listening port (tasklist/netstat are 10x faster than wmic)
    try {
      const [tl, ns] = await Promise.all([
        new Promise((res) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
        new Promise((res) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
      ]);
      const qemuPids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) qemuPids.add(m[2]);
      }
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && qemuPids.has(m[2])) pids.add(Number(m[2]));
      }
    } catch (_) { /* no process list: rely on the lock-file pid only */ }
    pids.delete(process.pid);
    if (!pids.size) {
      this.clearLocks(avdDir);
      return 0;
    }
    onLog(t('Cleaning up {n} leftover emulator processes', { n: pids.size }));
    await Promise.all([...pids].map((pid) => new Promise((r) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r());
    })));
    await sleep(1200);
    this.clearLocks(avdDir);
    return pids.size;
  }

  /** Whether any emulator console port in 5554-5620 is listening (refused connections return instantly) */
  async _anyEmulatorPortAlive() {
    const net = require('net');
    const probe = (port) => new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(120, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await probe(port)) return true;
    }
    return false;
  }

  /**
   * Prepare the AVD: write config.ini. Rewritten on every boot from the current auto profile so fallback retries take effect immediately.
   */
  ensureAvd({
    memoryMB = 2048, cores = 2, gpu = 'software', dataMB = 4096,
    heapMB = 256, accel = 'auto', snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const p = this.provisioner.ensureDirs();
    const home = p.avdHome;
    const avdDir = path.join(home, `${AVD_NAME}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });
    this.clearLocks(avdDir);

    // Screen: with hardware acceleration, 720x1280@320 is sharp and text is crisp;
    // pure software emulation drops to 540x960 for frame rate (56% of the area; the visual loss is far smaller than the smoothness gain).
    const screen = lcd || doctor.lcdFor({ accelOk: this.profile ? this.profile.accelOk : accel !== 'off' });

    const choice = this.imageChoice();
    const tag = choice.tag;
    const api = choice.api;
    const tagDisplay = choice.compat ? 'Google Play (ARM compatible)' : 'AOSP';

    fs.writeFileSync(
      path.join(home, `${AVD_NAME}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir.replace(/\\/g, '/')}\ntarget=android-${api}\n`,
    );

    const cfgPath = path.join(avdDir, 'config.ini');
    const wantImg = choice.dir
      ? `${choice.dir.replace(/\\/g, '/')}/`
      : `system-images/android-${api}/${tag}/${choice.abi}/`;
    this.wipePending = false;
    if (fs.existsSync(cfgPath)) {
      const prev = fs.readFileSync(cfgPath, 'utf8');
      const prevTag = /tag\.id=(.+)$/m.exec(prev);
      const prevImg = /image\.sysdir\.1=(.+)$/m.exec(prev);
      // Compare image identity, not absolute paths: the same image on another drive/dir is not a new image,
      // otherwise changing the runtime dir would wipe every installed app (see doctor.imageIdentity).
      const prevId = prevImg ? doctor.imageIdentity(prevImg[1].trim()) : '';
      const wantId = doctor.imageIdentity(wantImg);
      if ((prevTag && prevTag[1].trim() !== tag) || (prevId && prevId !== wantId)) {
        // Old userdata is incompatible with the new image (APEX boot loop): must rebuild
        this.wipePending = true;
      }
    }

    // Config fingerprint changed -> the old quickboot snapshot will fail to load or show a black screen; invalidate it.
    // Note: only the **snapshot** is invalidated, never -wipe-data - user data holds installed apps and saves.
    const key = `${doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    let prevKey = '';
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* first run */ }
    const snapshotStale = !!(prevKey && prevKey !== key);
    if (this.wipePending || snapshotStale || wipe) {
      // Deletion may be blocked by the system / security software (snapshot dirs are often several GB).
      // On failure rename it so the emulator won't load it; never abort the boot because cleanup failed.
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) { /* ignore */ }
      }
    }
    // Only an image change (tag / sysdir) needs -wipe-data: old userdata's APEX is incompatible with
    // the new image and would boot-loop. Changing size / resolution / render backend doesn't count.
    fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch must be the ABI itself (x86_64 must not be cut to x86)
    const cpuArch = choice.abi === 'arm64-v8a' ? 'arm64'
      : choice.abi === 'armeabi-v7a' ? 'arm' : choice.abi;

    const cfg = [
      `AvdId=${AVD_NAME}`,
      'avd.ini.displayname=ApkStart',
      'avd.ini.encoding=UTF-8',
      `abi.type=${choice.abi}`,
      `hw.cpu.arch=${cpuArch}`,
      `hw.cpu.ncore=${cores}`,
      `hw.ramSize=${memoryMB}`,
      `vm.heapSize=${heapMB}`,
      `image.sysdir.1=${wantImg}`,
      `tag.id=${tag}`,
      `tag.display=${tagDisplay}`,
      // The old version hard-coded 16G, creating huge files on small disks / quotas and slowing the first boot
      `disk.dataPartition.size=${dataMB}M`,
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      'hw.keyboard=yes',
      'hw.lcd.width=' + screen.w,
      'hw.lcd.height=' + screen.h,
      'hw.lcd.density=' + screen.dpi,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      `PlayStore.enabled=${choice.compat}`,
      // Snapshots are controlled entirely by the -snapshot apkstart flag: a dedicated name, so we never
      // load the legacy default_boot (RAM state of the API30 image; loading it means a boot loop).
      'hw.sdCard=no',
      'hw.audioInput=none',
      'hw.camera.back=none',
      'hw.camera.front=none',
      'hw.gps=no',
      // The orientation/accelerometer sensor must be off: when on, Android auto-rotates from the sensor and
      // turns portrait content sideways (whole picture rotated 90 degrees, black bars). Layout switching now relies only on
      // wm density (changing smallestWidth); the sensor is neither needed nor allowed.
      'hw.sensors.orientation=no',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, cfg);

    // The /data partition must actually be usable first, or everything after is wasted waiting (see ensureDataPartition)
    const data = this.ensureDataPartition(avdDir, dataMB);

    return {
      home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`), image: choice,
      wipePending: this.wipePending, screen, data,
    };
  }

  /**
   * Make sure the userdata partition is a **really usable** ext4 - the foundation of "tap an app, home screen in 30s".
   *
   * Why we have to do it ourselves (all three learned the hard way):
   *  1. The userdata.img in the system image package is a 1MB all-zero placeholder; real formatting is done by
   *     avdmanager calling the SDK's mke2fs. ApkStart writes config.ini and launches the emulator directly, skipping that ->
   *     /data is all zeros -> kernel "Invalid ext4 superblock on /dev/block/vdc" -> guest falls into a recovery
   *     reboot loop -> adbd never comes up -> the probe stays pending until the 240s timeout. Symptom: minutes to open an app.
   *  2. The emulator's bundled e2fsck/resize2fs is cygwin e2fsprogs 1.42.12, which **doesn't know the encrypt
   *     feature** and exits 8 if the bit is set, so growing the filesystem must happen before setting the bit.
   *  3. The filesystem must be >= the partition size: with only 64MB, APEX unpacking + dexopt fill it immediately,
   *     then every setxattr returns ENOSPC -> SELinux labels can't be written -> netd/media/tombstoned
   *     all exit 1 -> boot hangs on the boot animation and adb stays offline.
   */
  ensureDataPartition(avdDir, dataMB = 4096) {
    const emulatorExe = this.locate().emulatorExe;
    if (!emulatorExe || !fs.existsSync(emulatorExe)) return { ok: false, reason: 'no-emulator' };
    try { fs.mkdirSync(avdDir, { recursive: true }); } catch (_) { /* ignore */ }
    const emuDir = path.dirname(emulatorExe);
    const img = path.join(avdDir, 'userdata-qemu.img');
    const wantBytes = Math.max(1024, Math.round(dataMB || 4096)) * 1024 * 1024;
    let size = 0;
    try { size = fs.statSync(img).size; } catch (_) { /* doesn't exist */ }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      // Only "leave it alone" if the file is big enough AND the filesystem actually grew to that size.
      // Checking file size alone misses a real failure: qemu-img grew the file but resize2fs failed,
      // so the file is 6GB while Android sees 64MB - the user sees "not enough space" when installing a game.
      const fsBytes = userdata.fsBytes(img);
      const fsOk = fsBytes >= Math.min(size, wantBytes) * 0.95;
      if (size >= wantBytes && fsOk) return { ok: true, created: false, size, fsBytes };
      // Configured size grew (or the filesystem didn't grow): resize in place, no rebuild, keep installed apps
      try {
        userdata.clearEncryptFlag(img);
        if (size < wantBytes) this._qemuImg('resize', img, wantBytes);
        this._resize2fs(img);
        userdata.setEncryptFlag(img);
        const grown = userdata.fsBytes(img);
        this.log(`userdata resized: file ${size} -> ${wantBytes}, filesystem ${fsBytes} -> ${grown}`);
        return { ok: true, created: false, grown: true, size: wantBytes, fsBytes: grown };
      } catch (e) {
        this.log(`userdata resize failed (keeping the existing partition): ${e.message}`);
        // The old partition still works, but the caller must be told honestly "it didn't grow this time" so Settings doesn't show success
        return { ok: false, created: false, size, fsBytes, error: e.message };
      }
    }

    // First run / legacy all-zero placeholder / corrupted image: build a fresh one
    try {
      fs.rmSync(img, { force: true });
      fs.rmSync(`${img}.qcow2`, { force: true });
      // No encrypt bit at first (the old e2fsck/resize2fs only work without it)
      fs.writeFileSync(img, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: false }));
      this._qemuImg('resize', img, wantBytes);
      this._resize2fs(img);
      userdata.setEncryptFlag(img);
      this.log(`userdata rebuilt: ${(wantBytes / 1024 / 1024 / 1024).toFixed(1)}GB ext4 (4K blocks, FBE capable)`);
      return { ok: true, created: true, size: wantBytes };
    } catch (e) {
      // Best effort: even if growing failed, restore the encrypt bit so FBE can initialize (the partition will be small)
      try { userdata.setEncryptFlag(img); } catch (_) { /* ignore */ }
      this.log(`userdata rebuild failed: ${e.message}`);
      return { ok: false, created: true, error: e.message };
    }
  }

  /** The emulator's bundled qemu-img.exe: grow the raw image file to the target size (sparse, instant).
   *  Mind the argument order: `qemu-img <command> -f raw <file> <size>`.
   *  Putting -f before the command makes it a global option and fails with "unrecognized option". */
  _qemuImg(op, ...rest) {
    const exe = path.join(path.dirname(this.locate().emulatorExe), 'qemu-img.exe');
    const r = spawnSync(exe, [op, '-f', 'raw', ...rest], {
      cwd: path.dirname(exe), windowsHide: true, encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(t('qemu-img {op} failed: {error}', { op, error: (r.stderr || '').trim() || r.status }));
  }

  /** The emulator's bundled resize2fs.exe (cygwin build; must run inside bin64 to find its DLLs) */
  _resize2fs(img) {
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = path.join(bin, 'resize2fs.exe');
    if (!fs.existsSync(exe)) throw new Error(t('resize2fs.exe is missing'));
    const r = spawnSync(exe, [img], {
      cwd: bin, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    if (r.status !== 0) throw new Error(t('resize2fs failed: {error}', { error: (r.stderr || '').trim() || r.status }));
  }

  /** The emulator finds the SDK / AVD through these env vars; non-ASCII paths are converted to 8.3 short paths */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // The AVD dir must match provisioner.paths().avdHome: with a bundled read-only runtime (resources/runtime
    // next to the EXE), root/avd doesn't exist and isn't writable, so the AVD lives in the user data dir.
    const avdHome = doctor.shortPath(this.provisioner.paths().avdHome);
    const adbPort = String(plan.adbPort || process.env.ANDROID_ADB_SERVER_PORT || '5044');
    return {
      ...process.env,
      ANDROID_SDK_ROOT: safeRoot,
      ANDROID_HOME: safeRoot,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_EMULATOR_HOME: avdHome,
      ANDROID_ADB_SERVER_PORT: adbPort,
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
      ...(plan.accel === 'off' ? { ANDROID_I_WANT_MY_TCG: 'yes' } : {}),
    };
  }

  buildArgs({
    headless = true, accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
      // Audio: on by default (so Android app sounds and video audio play).
      // Pass -no-audio only when the user explicitly turns it off in Settings, to save a little CPU.
      ...(this.settings?.engine?.audio === false ? ['-no-audio'] : []),
      '-no-boot-anim',
      '-no-metrics',
      // Disable crash reporting: once an old crash report exists, the emulator shows a modal "consent to upload"
      // dialog that blocks the main thread and never boots (log: Showing crashdialog to get consent).
      '-crash-report-mode', 'disabled',
      '-gpu', gpu,
      '-memory', String(memoryMB),
      '-cores', String(cores),
    ];
    // Network: the AOSP emulator uses QEMU user-mode NAT (-netdev user) by default; Android gets a
    // virtual 10.0.2.x address and traffic goes out through the host's physical NIC.
    // This mode does NOT create any virtual NIC / virtual switch on Windows
    // (that only happens with -netdev tap or bridging, which we never use).
    // So Android apps behave like a device behind the host's NAT; the host network stack is untouched,
    // no driver to install, no extra network adapter.
    // Explicitly unthrottled: the default is "full", but some -gpu / -net combos pick up the emulator's
    // conservative profile, and video apps visibly lag on their first screen.
    args.push('-netdelay', 'none', '-netspeed', 'full');
    // DNS: Android defaults to 10.0.2.3 (forwarded to the host's DNS). Behind a VPN / corporate network / some ISPs
    // a single lookup can take hundreds of ms, showing up as "the page spins for ages before loading". Use
    // public DNS (Cloudflare, Google) as primary; the system still falls back on failure. Can be turned off in Settings (for intranet domains).
    if (this.settings?.engine?.fastDns !== false) {
      args.push('-dns-server', '1.1.1.1,8.8.8.8');
    }
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless) {
      args.push('-no-window');
    } else {
      // Note: **do not pass -no-skin**. It overrides -skin above and the panel size falls back to the
      // old value in config.ini - symptoms: "switched to landscape in Settings but still portrait",
      // and "the picture only fills a strip in the top-left". The panel size must come from -skin.
      // The device frame isn't drawn anyway (ShowDeviceFrame=no + the style flags).
      // Note: do not use -qt-hide-window either. It makes the emulator **not create** the Qt window at all,
      // and the window agent embeds exactly that window into the app window via SetParent -
      // with it the probe never finds the window and the user sees an all-black app window.
      // Hiding is done by the window agent's continuous suppression instead (see QuietSweep in win/agent.ps1).
    }
    // Only pass -snapshot when the snapshot really exists: on a fresh AVD (or right after invalidation)
    // qemu waits forever for RAM state that doesn't exist - the process lives but never boots;
    // the caller only sees "boot timed out", retries with new flags, and hits the AVD lock with
    // "Running multiple emulators with the same AVD".
    // The snapshot flags decide "8s vs 90s next boot", and this is the second critical point:
    // the old code passed -no-snapshot when there was no snapshot, but -no-snapshot also disables **saving on exit**,
    // so the first cold boot never produced a snapshot and every launch did a full boot.
    // The right flag is -no-snapshot-load: don't load this time (no waiting for a missing snapshot),
    // but still save RAM state as apkstart on exit and restore it next time.
    // A snapshot takes a ram.bin of about 2-3GB (users short on disk can turn it off; it only affects boot speed)
    const wantSnapshot = this.settings?.engine?.keepSnapshot !== false;
    if (wipe) {
      // When resetting data we must not load the old snapshot (data no longer matches), but **must allow saving a new one**:
      // network repair relies on "first boot after reset has network -> save snapshot -> restore next time".
      // The old code pushed -no-snapshot here, which also disabled saving, so the snapshot was never written.
      args.push('-no-snapshot-load');
    } else if (!wantSnapshot) {
      args.push('-no-snapshot');
    } else if (snapshot !== false) {
      args.push('-snapshot', SNAPSHOT_NAME);
      // Network self-heal requires a cold boot: the snapshot may have been saved without network and would restore without it.
      if (!this.hasSnapshot() || this._coldBoot) args.push('-no-snapshot-load');
    } else {
      args.push('-no-snapshot');
    }
    if (wipe) args.push('-wipe-data');
    if (accel === 'off') args.push('-accel', 'off');
    return args;
  }

  /** Launch one process (no boot wait; that happens in start()'s probe loop) */
  spawnOnce(plan, { headless, onLog, logFile }) {
    const loc = this.locate();
    const env = this.env(loc.root, plan);
    const args = this.buildArgs({
      headless, accel: plan.accel, port: plan.port, gpu: plan.gpu,
      memoryMB: plan.memoryMB, cores: plan.cores,
      snapshot: plan.snapshot, wipe: plan.wipe, lcd: plan.lcd,
    });
    this._logWrite(logFile, `\n--- ${new Date().toISOString()} ${plan.label} ---\n${loc.emulatorExe} ${args.join(' ')}\n`);

    const proc = spawn(loc.emulatorExe, args, {
      cwd: path.dirname(loc.emulatorExe),
      env,
      windowsHide: true,
      // detached: keep the emulator out of ApkStart's process group.
      // On exit Electron closes its job object, killing child processes with it -
      // symptom: "close ApkStart, reopen, another 20s cold boot". Detached, the emulator stays alive
      // and the next launch takes it over (see Runtime.adoptExisting), so apps open instantly.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    try { proc.unref(); } catch (_) { /* ignore */ }

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          this.log(l.trim());
          this._logWrite(logFile, `${l.trim()}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('exit', (code) => {
      this.lastExitCode = code;
      const meaning = describeExitCode(code);
      this.log(`emulator exit ${code}${meaning ? ` (${meaning})` : ''}`);
      this._logWrite(logFile, `emulator exit ${code}${meaning ? ` (${meaning})` : ''}\n`);
      this.proc = null;
      onLog(meaning
        ? t('Runtime exited (code={code}, {meaning})', { code, meaning: t(meaning) })
        : t('Runtime exited (code={code})', { code }));
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      this._logWrite(logFile, `spawn error: ${e.message}\n`);
      this.proc = null;
    });

    // qemu is a detached process; lower its priority once it's really up.
    // Otherwise 2-4 vCPU threads compete with the Windows desktop at Normal priority,
    // and the user feels it as "open ApkStart and the mouse gets laggy, the whole PC slows down".
    const perf = this.settings?.engine?.priorityMode === 'performance';
    setTimeout(() => {
      this.setPriority(perf ? 'normal' : 'below').catch(() => {});
    }, 3500).unref?.();
    return { proc, args };
  }

  /** Write the emulator log, with size-based rotation so long-term use doesn't fill the disk */
  _logWrite(file, text) {
    const limit = Math.max(2048, Number(this.settings?.engine?.logLimitKB || 2048) * 4);
    require('./logfile').append(file, text, limit);
  }

  /** Current state of the /data image (for Settings; works without Android running) */
  dataInfo() {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    let bytes = 0;
    try { bytes = fs.statSync(img).size; } catch (_) { /* not created yet */ }
    return {
      avdDir: dir,
      imageBytes: bytes,
      imageGB: bytes ? Number((bytes / 1073741824).toFixed(1)) : 0,
      configuredGB: Number(this.settings?.engine?.dataPartitionGB || 0),
    };
  }

  /**
   * Grow the /data partition to the given size now (the emulator must be stopped, or the image is in use).
   * Uses ensureDataPartition's in-place path: qemu-img resize + resize2fs,
   * no rebuild, installed apps and saves are kept.
   */
  resizeDataPartition(dataMB) {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    return this.ensureDataPartition(dir, dataMB);
  }

  /**
   * Set the priority of local qemu/emulator processes (only those whose command line has our AVD name).
   * level: idle (container parked) | below (an app is in the foreground) | normal (performance first).
   */
  setPriority(level = 'below') {
    if (process.platform !== 'win32') return Promise.resolve(0);
    const script = path.join(__dirname, 'win', 'priority.ps1');
    if (!fs.existsSync(script)) return Promise.resolve(0);
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Avd', AVD_NAME, '-Level', level,
      ], { windowsHide: true, timeout: 15000 }, (_err, out) => {
        const m = /CHANGED=(\d+)/.exec(String(out || ''));
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /** Force-kill the current attempt (including the qemu process tree) */
  async killAttempt() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch (_) { /* ignore */ }
      if (process.platform === 'win32' && proc.pid) {
        try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* ignore */ }
      }
    }
    await sleep(800);
    // The proc handle is often gone already (emulator.exe exits after launching; qemu is detached).
    // Without a by-name sweep, the next round hits the AVD lock and dies with FATAL.
    await this.killOrphanProcesses().catch(() => {});
  }

  /**
   * Rebuild the adb server on our dedicated port.
   *
   * This was the main culprit behind "two minutes to open an app"; the old code only ran kill-server:
   * the emulator connects to the adb daemon on ANDROID_ADB_SERVER_PORT right as it starts,
   * and if it can't, it **never registers the device** - adb devices either lacks emulator-5554
   * or shows it offline forever (log: "Unable to connect to adb daemon on port: 5044").
   * The probe then never gets sys.boot_completed, times out after 3 minutes and retries,
   * each retry a full cold boot, and the snapshot can't be saved because "device offline" - a dead loop.
   *
   * So kill first (drop the old device record), then start, and only return once the port is really listening.
   */
  /** Lets the caller restart the server once when the adb transport is stuck (offline / unauthorized) */
  async resetAdbServer() {
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    return this._resetAdbServer(port);
  }

  async _resetAdbServer(adbPort) {
    let adb = 'adb';
    try { adb = this.provisioner.adbVersionPath() || 'adb'; } catch (_) { /* use the one on PATH */ }
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) };
    const run = (args, timeout) => new Promise((resolve) => {
      try {
        execFile(adb, args, { timeout, windowsHide: true, env }, () => resolve());
      } catch (_) { resolve(); }
    });
    await run(['kill-server'], 6000);
    await run(['start-server'], 12000);
    // On some machines adb start-server returns quickly before the port is listening;
    // wait until it accepts connections (up to ~3s, normally tens of ms).
    const net = require('net');
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const alive = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: Number(adbPort) });
        let done = false;
        const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
        sock.setTimeout(150, () => fin(false));
        sock.once('connect', () => fin(true));
        sock.once('error', () => fin(false));
      });
      if (alive) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(120);
    }
    return false;
  }

  /**
   * Wait for the "exits right after spawn" case.
   * With bad flags / missing DLLs the emulator usually exits within a second; if the process is still
   * alive return immediately instead of a fixed 2.5s wait - a snapshot restore is half done by then.
   */
  _waitSpawnSettled(ms = 900) {
    const proc = this.proc;
    if (!proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const onExit = () => fin(true);
      const fin = (exited) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { proc.removeListener('exit', onExit); } catch (_) { /* ignore */ }
        resolve(exited);
      };
      const timer = setTimeout(() => fin(false), ms);
      proc.once('exit', onExit);
    });
  }

  /**
   * Force the next boot to be a cold boot (don't load the quickboot snapshot).
   *
   * The snapshot includes NIC state: if it was saved without network, every restore stays
   * without network. Network self-heal cold-boots once to get past a bad snapshot.
   */
  forceColdBootOnNextStart() { this._coldBoot = true; }

  /**
   * Add -wipe-data to the next boot (used only by "Repair network" after other attempts fail).
   * Deleting the userdata image file is not equivalent to the emulator's `-wipe-data`; it must use the latter.
   */
  forceWipeOnNextStart() { this._forceWipe = true; }

  /**
   * Check whether the VM can actually reach the network.
   *
   * Why: the Android VM's Wi-Fi config lives in /data; once corrupted (typically the same AndroidWifi
   * listed twice in `cmd wifi list-networks` with clashing network ids), wlan0 stays NO-CARRIER with no IP.
   * Pages that need the network then render as a black screen - "black screen after tapping Agree"
   * comes from this, not from the GPU/rendering at all.
   *
   * @param {string} [adbPath] explicit adb executable (Runtime has the more authoritative resolution)
   * @returns {Promise<{ok:boolean, reason:string, gateway?:string, ip?:string}>}
   */
  async checkNetwork(adbPath = '', { waitMs = 0, interval = 3000 } = {}) {
    const fs = require('fs');
    const path = require('path');
    let adb = adbPath || '';
    if (!adb) {
      try { adb = this.provisioner.adbVersionPath() || ''; } catch (_) { adb = ''; }
    }
    if (!adb) {
      // adbVersionPath() only checks the version file, which is empty in many install layouts;
      // looking up the bundled platform-tools under the runtime root is more reliable.
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 8000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
    // Android's multiple routing tables make the main table of `ip route` look empty (the default route is in per-interface tables),
    // and the shell uid isn't in the apps' network group, so `ping` often falsely reports "Network is unreachable"
    // even when Wi-Fi is connected and apps work. So we only check "got an IPv4 address",
    // cross-checked with the `cmd wifi status` connection state; no ping.
    const addr = await sh('ip -o addr');
    const ips = [];
    const re = /inet ((?:\d{1,3}\.){3}\d{1,3})\//g;
    let m = re.exec(addr);
    while (m) {
      const ip = m[1];
      if (!/^127\./.test(ip)) ips.push(ip);
      m = re.exec(addr);
    }
    const wifi = await sh('cmd wifi status');
    const connected = /Wifi is connected/i.test(wifi);
    if (!ips.length) {
      // Wi-Fi association + DHCP often finish tens of seconds after sys.boot_completed.
      // If the caller gave waitMs, keep waiting instead of declaring "no network" right now.
      if (waitMs > 0) {
        const t0 = Date.now();
        while (Date.now() - t0 < waitMs) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, interval));
          // eslint-disable-next-line no-await-in-loop
          const again = await this.checkNetwork(adbPath, { waitMs: 0 });
          if (again.ok) return again;
        }
      }
      return { ok: false, reason: connected ? 'no-ip-address' : 'wifi-not-connected', addrs: ips };
    }
    const ip = ips[0];
    const gw = /^10\.0\.2\./.test(ip) ? '10.0.2.2' : ip.replace(/\.\d+$/, '.1');
    return { ok: true, reason: '', gateway: gw, ip, wifiConnected: connected };
  }

  /**
   * Boot with automatic retries.
   * @param {Function} probe async callback returning 'ok' | 'pending' | 'fatal'
   */
  async start({ headless = false, onLog = () => {}, probe = null, maxAttempts = 4 } = {}) {
    if (this.proc && !this.proc.killed) {
      return { ok: true, reused: true, serial: this.serial, port: this.port };
    }

    const loc = this.locate();
    if (!loc.emulatorExe) throw new Error(t('The runtime engine is not installed. Finish setup on the Runtime page first.'));
    const choice = this.imageChoice();
    if (choice.compat ? !this.provisioner.playImageInfo().ok : !this.provisioner.systemImageInfo().ok) {
      throw new Error(t('The system image is not ready. Download the Android system image on the Runtime page first.'));
    }

    const s = this.settings;
    // Check disk space before booting: the emulator writes the AVD (data partition + snapshot, several GB),
    // so only the free space on that disk decides whether it can boot; the runtime dir only gets logs and needs far less.
    // We used to take the minimum of both, so "data dir already moved to D:, C: has 400MB left"
    // was wrongly reported as low disk space - making the move pointless.
    const avdHome = this.provisioner.paths().avdHome;
    const avdFreeMB = doctor.freeDiskMB(avdHome);
    const diskMB = doctor.freeDiskMB(loc.root);
    const needMB = 2500;
    if (avdFreeMB && avdFreeMB < needMB) {
      const msg = t('Not enough disk space: the drive holding the Android data folder ({dir}) has only {free} GB free, and the runtime needs at least {need} GB. Move it to a drive with more space (for example D:) in Settings → System integration → Android data folder, or free up some disk space. Your apps and saved data will not be deleted.', {
        dir: avdHome, free: (avdFreeMB / 1024).toFixed(1), need: (needMB / 1024).toFixed(1),
      });
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    if (diskMB && diskMB < 300) {
      const msg = t('The drive holding the runtime folder ({dir}) has only {free} GB free, not even enough for logs and temporary files. Free up disk space, or move the runtime data folder to another drive as well.', {
        dir: loc.root, free: (diskMB / 1024).toFixed(1),
      });
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    const adbPort = await doctor.freeAdbPort(Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044);
    // Make every adb call in this process use the same server port as the emulator
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;

    // These four are independent, so run them in parallel: they used to run serially (accel check -> version ->
    // port probe -> adb server reset), wasting 3-5s before a cold boot - exactly while the user stares at the loading box.
    // The adb server from the last run may still hold stale device records (pushing the new emulator offline),
    // so the reset is still done, just not awaited on its own.
    const [accelInfo, verInfo, startPort] = await Promise.all([
      this.provisioner.emulatorAccel(),
      this.provisioner.emulatorVersion(),
      doctor.freePortPair(5554),
      this._resetAdbServer(adbPort),
    ]);
    const emuVersion = verInfo.version || '';
    this._emuVersion = emuVersion;

    // Same entry point as Settings / the diagnostic report, so what's shown is what actually runs
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    this.profile = profile;
    const variants = doctor.planVariants(profile).slice(0, maxAttempts);

    // Remember the GPU backend that crashed on launch last time and try it last.
    // Observed: on AMD Radeon 780M, `-gpu host` passes the emulator's own hardware check,
    // but the VM exits with code 1 a dozen seconds after starting (log only says "AEHD is operational"),
    // wasting 20+ seconds every time before falling back to swangle. The key includes the emulator version,
    // so a runtime upgrade gives it another chance.
    const badGpuKey = this.settings.engine.badGpu || '';
    const [badVer, badGpu] = badGpuKey.includes('|') ? badGpuKey.split('|') : ['', ''];
    if (badGpu && badVer === emuVersion) {
      const rank = (v) => (v.gpu === badGpu ? 1 : 0);
      variants.sort((a, b) => rank(a) - rank(b));
      if (variants[0] && variants[0].gpu === badGpu && variants.length > 1) {
        onLog(t('The {bad} renderer crashed on startup last time; trying {next} first', { bad: badGpu, next: variants[1].gpu }));
      }
    }

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this._logWrite(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);

    // Keep the screen spec constant for the whole boot; changing resolution per retry would keep wiping snapshots.
    // The resolution comes from doctor's profile ("quality" in Settings); in auto mode it depends on acceleration.
    const screen = (profile && profile.lcd) || doctor.lcdFor({ accelOk: accelInfo.ok });
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';

    // Clear orphans before a cold boot: while a qemu from the last run still holds the AVD lock,
    // every attempt dies immediately with FATAL "Running multiple emulators with the same AVD".
    // eslint-disable-next-line no-await-in-loop
    await this.killOrphanProcesses({ onLog }).catch(() => {});

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
      // A busy port also causes failures; probe again on every retry
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = { ...base, port, adbPort, lcd: screen };
      this.port = port;
      // Reset the exit code each round: a 0xC0000005 from the last round must not leak into this round's diagnosis
      this.lastExitCode = null;
      // Split the log per round too: the in-memory log accumulates across rounds, and round 1's crash line
      // at the tail would make round 2 (say, a port clash after switching backend) be misdiagnosed as the same crash.
      const logStart = this._log.length;
      onLog(t('Starting runtime (attempt {n}/{total}: {label})…', { n: i + 1, total: variants.length, label: plan.label }));

      // eslint-disable-next-line no-await-in-loop
      const avd = this.ensureAvd({
        ...plan,
        // _forceWipe also triggers "delete old snapshots": after a data reset the old snapshot always fails to load
        // (observed: Failed to load snapshot, then a cold boot), so clear it first and rebuild.
        wipe: plan.wipe || !!this.wipePending || !!this._forceWipe,
      });
      // Hook: the caller (main) uses this to start console-window suppression **before** the emulator launches.
      // The console window pops up tens of ms after spawn; a scan afterwards always flashes,
      // so it must be enabled first, then the process launched.
      if (this.onBeforeSpawn) {
        // eslint-disable-next-line no-await-in-loop
        try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
      }
      // eslint-disable-next-line no-await-in-loop
      const forceWipe = !!this._forceWipe;
      this._forceWipe = false;
      // _coldBoot applies to this spawn only, so later boots don't all degrade into long cold boots
      this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending || forceWipe }, { headless, onLog, logFile });
      this._coldBoot = false;

      // Bad flags / missing DLLs exit immediately
      // eslint-disable-next-line no-await-in-loop
      const dead = await this._waitSpawnSettled(2200);
      if (dead || !this.proc) {
        const d = doctor.diagnose(this._attemptLines(logStart, 60));
        this.attempts.push({ plan: plan.label, diagnosis: d.code, exitCode: this.lastExitCode });
        this.lastDiagnosis = d;
        lastError = `${d.title}: ${d.hint}`;
        // A full disk isn't fixed by "try other flags": retrying just fails again,
        // and historically the last variant had wipe, erasing user data too. Stop here and report honestly.
        if (d.code === 'DISK_FULL') {
          onLog(t('Not enough disk space. Stopped retrying (your apps and saved data are untouched).'));
          this._persistFailure({ profile, why: 'disk-full' });
          return { ok: false, error: lastError, needsSpace: true, attempts: this.attempts, exitCode: this.lastExitCode };
        }
        // Acceleration/image verdicts may come from stale cache; invalidate it so the next boot probes again
        if (['ACCEL', 'GPU_INIT', 'GPU_MODE', 'IMAGE', 'DLL', 'ACCESS_VIOLATION'].includes(d.code)) {
          try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
        }
        onLog(t('{reason}, retrying with different settings…', { reason: d.title }));
        this._noteGpuFailure(plan);
        continue;
      }

      if (!probe) {
        return { ok: true, serial: this.serial, port, accel: accelInfo, logFile, profile, attempts: this.attempts };
      }

      const started = Date.now();
      const timeout = plan.bootTimeoutMs || 240000;
      let ok = false;
      let fatal = false;
      let sawBooting = false;
      // A snapshot restore often finishes within seconds; a fixed 3s poll means ~1.5s extra on average
      // before we notice. Start at 200ms and back off to 1.2s: early boot is caught immediately,
      // and long boots don't burn CPU on polling.
      let interval = 200;
      let lastNotice = 0;
      // eslint-disable-next-line no-await-in-loop
      while (Date.now() - started < timeout) {
        if (!this.proc) { fatal = true; break; }
        let state = 'pending';
        try {
          // eslint-disable-next-line no-await-in-loop
          state = await probe({ serial: this.serial, port, adbPort });
        } catch (_) { state = 'pending'; }
        if (state === 'ok') { ok = true; break; }
        if (state === 'fatal') { fatal = true; break; }
        // Once adb can run a shell the kernel is booting; ordinary Vulkan/EGL log lines don't count as failures
        if (state === 'booting') sawBooting = true;
        // Still no connection after 45s and the log shows a clear fatal error -> switch plans early instead of waiting 4 minutes
        if (!sawBooting && Date.now() - started > 45000) {
          const d = doctor.diagnose(this._attemptLines(logStart, 80));
          if (['GPU_INIT', 'ACCEL', 'GPU_MODE', 'IMAGE', 'DLL', 'MEMORY', 'ACCESS_VIOLATION'].includes(d.code)) {
            this.lastDiagnosis = d;
            try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
            fatal = true;
            break;
          }
        }
        // One progress line every 15s: the old modulo check printed two or three duplicates with the adaptive interval
        if (Date.now() - lastNotice > 15000) {
          lastNotice = Date.now();
          onLog(t('Booting… {s}s', { s: Math.round((Date.now() - started) / 1000) }));
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(interval);
        interval = Math.min(1200, Math.round(interval * 1.6));
      }

      if (ok) {
        const bootMs = Date.now() - started;
        // It really booted this time: clear the previous failure record so later diagnostics don't dig up old news
        this._clearFailure();
        // Always save a quickboot snapshot: the emulator process may end when ApkStart exits (Electron's
        // job object kills child processes), and whether a snapshot exists decides 25s vs 7s next time.
        // The installer invalidates the snapshot after installing an app, avoiding "app gone after restart".
        this.snapshotWorthSaving = true;
        onLog(t('Runtime ready ({s}s, {label})', { s: Math.round(bootMs / 1000), label: plan.label }));
        // Booting isn't the same as usable: check the network too. Without network, pages that need it stay black,
        // and users just say "this app shows a black screen", rarely suspecting the network. Check and say so clearly.
        let network = null;
        try { network = await this.checkNetwork(); } catch (_) { /* a failed check isn't a boot failure */ }
        if (network && !network.ok) {
          onLog(t('⚠ The Android VM has no network connection: apps that need the internet will show a black screen. To fix it, reset Android data with Settings → Repair network (your app list is kept and apps are reinstalled when you open them).'));
        }
        return {
          ok: true, serial: this.serial, port, accel: accelInfo, logFile,
          profile, attempts: this.attempts, bootMs, quickBoot: true, network,
        };
      }

      const attemptLines = this._attemptLines(logStart, 80);
      const d = fatal ? (this.lastDiagnosis || doctor.diagnose(attemptLines)) : doctor.diagnose(attemptLines);
      this.attempts.push({ plan: plan.label, diagnosis: d.code, timeout: !fatal, exitCode: this.lastExitCode });
      this.lastDiagnosis = d;
      lastError = fatal ? `${d.title}: ${d.hint}` : t('Boot timed out (the first boot may be slow, or hardware acceleration is not working)');
      onLog(t('{reason}, retrying with different settings…', { reason: lastError }));
      this._noteGpuFailure(plan);
      // eslint-disable-next-line no-await-in-loop
      await this.killAttempt();
    }

    const d = this.lastDiagnosis || doctor.diagnose(this.recentLog(120));
    const report = doctor.writeReport({
      dataDir: store.DATA_DIR, profile, logLines: this.recentLog(300),
      extra: {
        attempts: this.attempts,
        diagnosis: d,
        image: choice,
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
      },
    });
    const err = new Error(t('The runtime failed to start after several attempts ({title}).\n{hint}\n\nTried: {tried}\nDiagnostic report: {file}', {
      title: d.title,
      hint: d.hint,
      tried: this.attempts.map((a) => `${a.plan} → ${a.diagnosis}`).join('; '),
      file: report.file,
    }));
    err.diagnosis = d;
    err.report = report.file;
    err.attempts = this.attempts;
    this._persistFailure({ profile, why: 'boot-failed', report: report.file });
    throw err;
  }

  running() { return !!(this.proc && !this.proc.killed); }

  /**
   * Save a quickboot snapshot (next boot restores RAM state directly, like the fast start of WSA and similar).
   *
   * Timing matters: the old code saved 6s after boot, competing for disk I/O with the app the user had just opened
   * (a snapshot writes 1-3GB), which actually felt slower. Now it saves "when idle", triggered by Runtime
   * when the last app window closes; if it hasn't happened before shutdown, it's done then.
   */
  async saveSnapshotNow(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    const ok = await this._saveViaAdb(adbPath, { timeout });
    // The emulator's save command may reply OK mid-write; confirm by file integrity,
    // and only count it once snapshot.pb is really on disk (otherwise the next load fails and wastes seconds).
    if (!ok) return false;
    return this.hasSnapshot();
  }

  /**
   * Schedule one "save snapshot when idle".
   * Scheduled once; if an app is still in the foreground when it fires, it's postponed until really idle.
   */
  scheduleSnapshotSave(adbPath, { delay = 20000, isIdle = () => true } = {}) {
    if (!adbPath) return;
    if (this._snapTimer) clearTimeout(this._snapTimer);
    const arm = (ms) => {
      this._snapTimer = setTimeout(async () => {
        this._snapTimer = null;
        if (!this.running()) return;
        if (!isIdle()) { arm(15000); return; }
        // Skip if there isn't room for the snapshot (RAM size + 1GB margin): forcing it would fill the disk
        // and make the next boot fail outright. Snapshots only affect boot speed; skipping costs no data.
        const freeMB = require('./doctor').freeDiskMB(store.DATA_DIR);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`Skipping snapshot save: ${(freeMB / 1024).toFixed(1)}GB free < ${(needMB / 1024).toFixed(1)}GB needed`);
          return;
        }
        await this.saveSnapshotNow(adbPath).catch(() => false);
        this._snapSaved = true;
      }, ms);
      if (this._snapTimer.unref) this._snapTimer.unref();
    };
    arm(delay);
  }

  cancelSnapshotSave() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
  }

  /** Graceful stop: save the quickboot snapshot on slow machines, shut down via the console, then force-kill the tree */
  async stop({ adbPath } = {}) {
    if (!this.proc) {
      // An adopted instance has no proc handle, but a machine is running on the port; don't just return true
      if (!(await this._anyEmulatorPortAlive())) return true;
    }
    this.cancelSnapshotSave();
    const serial = this.serial;
    if (adbPath && this.snapshotWorthSaving !== false) {
      // Save once more before shutdown: if the idle path didn't get to it (e.g. the user quit right after installing),
      // the next boot can still restore from the snapshot instead of cold-booting.
      // Writing 3GB of RAM takes seconds to twenty-odd seconds; allow plenty of time so it isn't killed mid-write.
      await this._saveViaAdb(adbPath, { timeout: 60000 });
    }
    if (adbPath) {
      await new Promise((resolve) => {
        execFile(adbPath, ['-s', serial, 'emu', 'kill'],
          { timeout: 10000, windowsHide: true }, () => resolve());
      });
    }
    // Let it finish "flush to disk -> exit" by itself. The old code force-killed after a fixed 6s,
    // cutting the snapshot write and leaving a shell with ram.img but no snapshot.pb.
    //
    // Don't wait on this.proc: emulator.exe is only a launcher and exits after spawning qemu,
    // so treating its exit as "shutdown done" would go straight to force-kill. Use the console port instead.
    for (let i = 0; i < 100 && (await this._consoleAlive()); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    await this.killAttempt();
    return true;
  }

  /**
   * Remember a GPU backend that "crashes on launch" and try it last next time.
   * Auto mode only: when the user picked a backend explicitly, respect it and don't change it behind their back.
   */
  _noteGpuFailure(plan) {
    try {
      const gpu = plan && plan.gpu;
      if (!gpu) return;
      // Software rendering is the fallback: already the slowest/most stable, nothing worse to fall back to
      if (/software|swiftshader|swangle/.test(gpu)) return;
      if ((this.settings.engine.gpuMode || 'auto') !== 'auto') return;
      store.saveSettings({ engine: { badGpu: `${this._emuVersion || ''}|${gpu}` } });
    } catch (_) { /* ignore */ }
  }

  /** Whether a machine is still running on this instance's console port (5554) - "is it fully shut down yet" */
  _consoleAlive() {
    const net = require('net');
    const port = this.port || 5554;
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(200, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
  }

  /** Trigger a snapshot save via adb (returns false on failure; the caller decides whether to retry) */
  _saveViaAdb(adbPath, { timeout = 45000 } = {}) {
    return new Promise((resolve) => {
      execFile(adbPath, ['-s', this.serial, 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME],
        { timeout, windowsHide: true }, (err) => resolve(!err));
    });
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }

  /**
   * Only the log lines from the current boot attempt.
   * The in-memory log accumulates across rounds (the diagnostic report wants all attempts), but a diagnosis must
   * look only at this round: otherwise round 1's `emulator exit 3221225477` makes any round-2 failure look like the same crash.
   * If this round has no lines at all (the process never started), fall back to the overall tail to give some verdict.
   */
  _attemptLines(from, max = 80) {
    const lines = this._log.slice(Math.max(0, from || 0)).map((x) => x.line);
    return lines.length ? lines.slice(-max) : this.recentLog(max);
  }

  /**
   * Read the last n lines of emulator.log (used when the in-memory buffer is empty).
   * When the user restarts ApkStart and then exports a diagnostic report, this._log is empty;
   * old reports showed only UNKNOWN - the real crash cause was all in the log file.
   */
  tailLogFile(n = 300) {
    try {
      const file = path.join(store.DATA_DIR, 'logs', 'emulator.log');
      const size = fs.statSync(file).size;
      const take = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        const lines = buf.toString('utf8').split(/\r?\n/);
        // When not reading from the start, the first line may be cut off; drop it
        if (take < size) lines.shift();
        return lines.slice(-n);
      } finally { fs.closeSync(fd); }
    } catch (_) { return []; }
  }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME };
