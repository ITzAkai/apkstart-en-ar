'use strict';
/**
 * Regression tests for zero-config auto-tuning and container-style slimming (plain Node, no emulator)
 * Run: node test/auto-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `apkstart-auto-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed += 1; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed += 1; results.push(`  ✗ ${name}\n    ${e.stack || e.message}`); });
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const doctor = require('../src/core/doctor');
const layers = require('../src/core/layers');
const pointer = require('../src/core/pointer');
const { AdbClient, friendlyInstallError, friendlyLaunchError } = require('../src/core/adb');

(async () => {
  console.log('\n[doctor.js auto parameters]');

  await test('GPU backend follows the emulator version (new: host first + software fallback; old: swiftshader_indirect)', () => {
    // New versions (37.x / 36.4.9+): host is the most responsive and degrades to software/swangle on failure
    assert(doctor.gpuCandidates('37.3.8.0')[0] === 'host', '37.x should prefer host');
    assert(doctor.gpuCandidates('36.4.9.0')[0] === 'host');
    assert(doctor.gpuCandidates('37.3.8.0').includes('software'), 'new versions must have a software fallback');
    // swiftshader_indirect fails GL init on 37.x and must never be a candidate
    assert(!doctor.gpuCandidates('37.3.8.0').includes('swiftshader_indirect'));
    // Old versions still use swiftshader_indirect
    assert(doctor.gpuCandidates('35.1.4.0')[0] === 'host');
    assert(doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
  });

  await test('low-memory machines scale down automatically (no fixed 4 GB / 4 cores)', () => {
    const host = { totalMB: 4096, freeMB: 2600, cores: 2, home: 'C:\\Users\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: false }, emulatorVersion: '37.3.8.0', diskMB: 20000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB === 2048, `memory should be 2048, got ${p.memoryMB}`);
    assert(p.cores === 2, `cores should be 2, got ${p.cores}`);
    assert(p.accel === 'off', 'without hardware acceleration it should fall back to software emulation');
    assert(p.bootTimeoutMs > 240000, 'software emulation needs a longer boot timeout');
    assert(p.gpu === 'host', `first renderer should be host (planVariants degrades on failure), got ${p.gpu}`);
    // With accel off the last-resort plan must use software rendering: TCG has no GPU
    const lastResort = doctor.planVariants(p).find((v) => v.lastResort);
    assert(lastResort && /software|swiftshader/.test(lastResort.gpu), 'the last-resort plan must use software rendering');
    // Data partition defaults to 4/6/8 GB by free disk space (no fixed 16G) and settings can override it
    assert(p.dataMB >= 4096 && p.dataMB <= 8192, `data partition should be 4-8 GB, got ${p.dataMB}`);
    const big = doctor.chooseProfile({
      host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000,
      settings: { engine: { dataPartitionGB: 24 } }, overrides: {},
    });
    assert(big.dataMB === 24 * 1024, 'the data partition size from settings must apply');
  });

  await test('high-memory machines do not take unlimited memory', () => {
    const host = { totalMB: 65536, freeMB: 50000, cores: 32, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB <= 3072 && p.cores <= 4, `high-end machines should be capped too: ${p.memoryMB}MB / ${p.cores} cores`);
    assert(p.accel === 'auto');
  });

  await test('retry matrix: best to most conservative, with software emulation and cold-boot fallbacks', () => {
    const p = doctor.chooseProfile({
      host: doctor.hostInfo(), accel: { ok: true }, emulatorVersion: '37.3.8.0',
      diskMB: 50000, port: 5554, adbPort: 5044,
    });
    const v = doctor.planVariants(p);
    assert(v.length >= 3 && v.length <= 4, `should be 3-4 retries, got ${v.length}`);
    assert(v.some((x) => x.accel === 'off'), 'missing software emulation fallback');
    // The last variant only skips the snapshot and uses minimum memory; -wipe-data is never allowed:
    // with a full disk every variant fails, and a wipe would erase the user's installed apps (it happened).
    assert(v[v.length - 1].snapshot === false, 'the last variant must skip loading the snapshot');
    assert(v[v.length - 1].wipe === false, 'no automatic retry may wipe user data');
    assert(v[v.length - 1].memoryMB <= 2048, 'the last variant should drop to minimum memory');
    // cores/dataMB are part of the key: on low free RAM the last resort differs from the software plan only there
    const keys = v.map((x) => `${x.gpu}|${x.accel}|${x.wipe}|${x.memoryMB}|${x.cores}|${x.dataMB}|${x.snapshot !== false}`);
    assert(new Set(keys).size === keys.length, 'retry plans should not repeat');
  });

  await test('moving the image to another drive is not a new image: a changed sysdir must not wipe user data', () => {
    const c = 'C:/Users/x/AppData/Roaming/apkstart/system-images/android-34/google_apis_playstore/x86_64/';
    const d = 'D:/ApkStartRuntime/system-images/android-34/google_apis_playstore/x86_64/';
    assert(doctor.imageIdentity(c) === doctor.imageIdentity(d), 'the same image set must have the same path identity');
    const key = (p) => doctor.snapshotKey({ emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' }, p);
    assert(key(c) === key(d), 'the snapshot should survive a drive move (or the user waits for a cold boot for nothing)');
    const other = 'D:/rt/system-images/android-34/google_apis/x86_64/';
    assert(doctor.imageIdentity(other) !== doctor.imageIdentity(d), 'a really different image must be detected');
  });

  await test('snapshot fingerprint ignores GPU/accel/memory retries (so a retry never clears installed apps)', () => {
    const a = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const b = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const c = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img2');
    assert(a === b && a !== c);
  });

  await test('log diagnosis recognizes GPU / acceleration / non-ASCII path / lock file problems', () => {
    assert(doctor.diagnose(['Failed to initialize GL emulation']).code === 'GPU_INIT');
    assert(doctor.diagnose(['ERROR: x86_64 emulation currently requires hardware acceleration!']).code === 'ACCEL');
    assert(doctor.diagnose(['Cannot allocate memory for guest RAM']).code === 'MEMORY');
    assert(doctor.diagnose(['panic: AVD apkstart is already running']).code === 'AVD_LOCK');
    assert(doctor.diagnose(['non-ASCII path is not supported']).code === 'NON_ASCII');
    assert(doctor.diagnose(['random line']).code === 'UNKNOWN');
  });

  await test('log diagnosis: emulator exiting with 0xC0000005 means a renderer backend crash', () => {
    // Seen in issue #20/#25: exit 3221225477 right after printing Userspace boot properties
    assert(doctor.diagnose(['emulator exit 3221225477']).code === 'ACCESS_VIOLATION');
    assert(doctor.diagnose(['... 0xC0000005 ...']).code === 'ACCESS_VIOLATION');
    // Crash logs usually include renderer init lines too: the crash must win over GPU_INIT
    const mixed = ['Graphics backend: gfxstream', 'emulator exit 3221225477'];
    assert(doctor.diagnose(mixed).code === 'ACCESS_VIOLATION', 'a crash should win over ordinary renderer lines');
  });

  await test('free port probe returns an even port pair', async () => {
    const p = await doctor.freePortPair(5560);
    assert(p % 2 === 0 && p >= 5560, `bad port: ${p}`);
  });

  await test('auto parameters shown in Settings match the ones used (37.x no longer shows deprecated backends)', () => {
    const common = { accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000, port: 5562, adbPort: 5044 };
    const p = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: true, gpuMode: 'auto', memoryMB: 0, cores: 0 } } });
    const text = doctor.describeProfile(p);
    assert(p.gpu === 'host', `should be host (degrades on failure), got ${p.gpu}`);
    assert(p.accelOk === true && text.includes('hardware acceleration'), text);
    assert(!text.includes('swiftshader_indirect'), text);
    assert(text.includes('port 5562'), text);

    // Old engines still use the old backend; advanced values the user entered still apply
    const old = doctor.autoProfile({ ...common, emulatorVersion: '35.1.4.0', settings: {} });
    assert(old.gpu === 'host' && doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
    const manual = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: false, memoryMB: 6144, cores: 6, gpuMode: 'swiftshader' } } });
    assert(manual.memoryMB === 6144 && manual.cores === 6 && manual.gpu === 'swiftshader', JSON.stringify(manual));
    const zero = doctor.overridesFromSettings({ autoMemory: false, memoryMB: 0, cores: 0, gpuMode: 'auto' });
    assert(zero.memoryMB === 0 && zero.cores === 0 && zero.gpuMode === '', JSON.stringify(zero));
  });

  console.log('\n[layers.js container-style slimming]');

  await test('lists reclaimable items: non-x86_64 QEMU, old images, old AVDs, lock files, old snapshots', () => {
    const root = path.join(TMP, 'runtime-layers');
    const mk = (p, size) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const b = Buffer.alloc(size || 16, 65);
      fs.writeFileSync(p, b);
    };
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'), 1024);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'kernel-ranchu'), 16);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'NOTICE.txt'), 2048);
    mk(path.join(root, 'system-images', 'android-30', 'default', 'x86_64', 'system.img'), 512);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-aarch64.exe'), 128);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe'), 128);
    mk(path.join(root, 'avd', 'apkstart.avd', 'config.ini'), 32);
    mk(path.join(root, 'avd', 'apkstart.avd', 'snapshots', 'default_boot', 'ram.img'), 256);
    mk(path.join(root, 'avd', 'apkstart.avd', 'multiInstance.lock'), 8);
    mk(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img'), 512);

    const a = layers.analyze(root);
    const paths = a.candidates.map((c) => c.path.replace(/\\/g, '/'));
    assert(paths.some((p) => p.endsWith('qemu-system-aarch64.exe')), 'should list non-x86_64 QEMU');
    assert(!paths.some((p) => p.endsWith('qemu-system-x86_64.exe')), 'must not delete x86_64 QEMU');
    assert(paths.some((p) => p.includes('android-30')), 'should list the old API 30 image');
    assert(paths.some((p) => p.endsWith('.lock')), 'should list lock files');
    assert(paths.some((p) => p.includes('snapshots')), 'should list old snapshots');
    assert(paths.some((p) => p.includes('apkstart-arm.avd')), 'should list inactive AVDs');
    assert(!paths.some((p) => p.endsWith('apkstart.avd/config.ini')), 'must not delete the active AVD config');

    const dry = layers.prune(root, { apply: false });
    assert(dry.removed.length === 0 && dry.saved === 0, 'a dry run must not delete anything');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img')));

    const done = layers.prune(root, { apply: true });
    assert(done.saved > 0 && done.removed.length >= 5, 'a real prune should free space');
    assert(!fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd')), 'inactive AVD should be removed');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart.avd', 'config.ini')), 'the active AVD must be kept');
    assert(fs.existsSync(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe')), 'x86_64 QEMU must be kept');
  });

  console.log('\n[adb.js readable install/launch errors]');

  await test('old-targetSdk apps failing on Android 14 get clear guidance', () => {
    const s = friendlyInstallError('Failure [INSTALL_FAILED_DEPRECATED_SDK_VERSION: app must target at least 23]');
    assert(s.includes('Android 14') && s.includes('automatically'), s);
  });

  await test('an ARM translation layer crash gives an actionable conclusion', () => {
    const s = friendlyLaunchError('F DEBUG: DoBadTrampoline libndk_translation SIGABRT', 'com.phoenix.read');
    assert(s.includes('ARM translation layer') && s.includes('compatibility image'), s);
  });

  console.log('\n[sharer no longer shuffles files back and forth (what filled the disk)]');

  await test('the same file is not pulled back from the device every round', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared');
    fs.mkdirSync(localDir, { recursive: true });
    const file = path.join(localDir, 'a.txt');
    fs.writeFileSync(file, 'hello');

    const calls = { push: 0, pull: 0 };
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => { calls.push += 1; },
      pull: async (_r, dst) => { calls.pull += 1; fs.writeFileSync(dst, 'hello'); },
      listRemoteStat: async () => [{ rel: 'a.txt', size: 5, mtime: Date.now() - 60000 }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    sh.localDirOverride = localDir;
    // Real path/state file logic, but the folders point at temp dirs
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state.json');

    await sh.sync();          // round 1: new local file -> push
    const firstPull = calls.pull;
    await sh.sync();          // round 2
    await sh.sync();          // round 3
    await sh.sync();          // round 4
    assert(calls.push === 1, `should push once, got ${calls.push}`);
    assert(firstPull === 0, `a file just pushed must not be pulled right back, pulled ${firstPull} times`);
    assert(calls.pull === firstPull, `later rounds must not keep pulling, total ${calls.pull}`);
  });

  await test('huge files are not pulled back to the PC (the local folder is not a drain for the device cache)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared2');
    fs.mkdirSync(localDir, { recursive: true });
    let pulled = 0;
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => {},
      pull: async () => { pulled += 1; },
      listRemoteStat: async () => [{ rel: 'big.mp4', size: 600 * 1024 * 1024, mtime: Date.now() }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state2.json');
    await sh.sync();
    assert(pulled === 0, 'files over 512 MB must not be pulled back');
  });

  console.log('\n[adb/sharer file sharing]');

  await test('ls -l parsing handles Android formats with group / date', async () => {
    const { AdbClient } = require('../src/core/adb');
    const fake = Object.create(AdbClient.prototype);
    fake.shell = async () => '-rw-rw---- 1 u0_a188 media_rw 12 2026-11-12 18:52 hello.txt\r\n'
      + 'drwxrwx--- 2 u0_a188 media_rw 4096 2026-11-12 18:52 sub\r\n'
      + '-rw-rw---- 1 u0_a188 7 Nov 12 18:52 no-group.txt\r\n';
    const rows = await fake.listRemote('/sdcard/x');
    assert(rows.length === 3, `should parse 3 rows, got ${rows.length}`);
    assert(rows[0].name === 'hello.txt' && rows[0].size === 12, JSON.stringify(rows[0]));
    assert(rows[1].isDir && rows[1].name === 'sub', JSON.stringify(rows[1]));
    assert(rows[2].name === 'no-group.txt' && rows[2].size === 7, JSON.stringify(rows[2]));
  });

  await test('the remote file list comes from one find+stat call (no ls date parsing)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const sh = Object.create(Sharer.prototype);
    const fake = {
      shell: async () => '12|1794480758|./a.txt\n8|1794480759|./sub/b.txt\n',
      listRemote: async () => [],
    };
    const rows = await sh.listRemoteRecursive(fake, '/sdcard/x');
    assert(rows.length === 2, `should return 2 files, got ${rows.length}`);
    assert(rows[1].rel === 'sub/b.txt' && rows[1].mtime > 1e12, JSON.stringify(rows[1]));
  });

  console.log('\n[zip.js streaming extraction of large packages]');

  await test('ZipFile and ZipArchive parse the same archive identically (deflate and streaming pipeTo)', async () => {
    const zlib = require('zlib');
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello apkstart'), method: 0 },
      { name: 'dir/b.bin', data: Buffer.alloc(200000, 7), method: 8 },
    ];
    const locals = [];
    const centrals = [];
    let off = 0;
    for (const it of entries) {
      const raw = it.method === 8 ? zlib.deflateRawSync(it.data) : it.data;
      const name = Buffer.from(it.name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(it.method, 8);
      lh.writeUInt32LE(raw.length, 18);
      lh.writeUInt32LE(it.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, raw);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(it.method, 10);
      ch.writeUInt32LE(raw.length, 20);
      ch.writeUInt32LE(it.data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(off, 42);
      centrals.push(ch, name);
      off += lh.length + name.length + raw.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    const buf = Buffer.concat([...locals, cd, eocd]);
    const zipPath = path.join(TMP, 'parity.zip');
    fs.writeFileSync(zipPath, buf);

    const mem = new ZipArchive(buf);
    const file = new ZipFile(zipPath);
    try {
      assert(mem.names().join('|') === file.names().join('|'), 'entry names should match');
      assert(mem.read('a.txt').equals(file.read('a.txt')), 'stored entry content should match');
      assert(mem.read('dir/b.bin').equals(file.read('dir/b.bin')), 'deflate entry content should match');
      const out = path.join(TMP, 'b.bin');
      await file.pipeTo('dir/b.bin', fs.createWriteStream(out));
      assert(fs.readFileSync(out).equals(entries[1].data), 'pipeTo streaming output should be complete');
    } finally {
      file.close();
    }
  });

  await test('Zip64: when EOCD holds 0xffff/0xffffffff placeholders, count and offset come from the Zip64 EOCD', async () => {
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const name = Buffer.from('hello.txt');
    const data = Buffer.from('hello zip64 apkstart');
    // Local header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(45, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const cenStart = lh.length + name.length + data.length;
    // Central directory entry: three fields set to 0xffffffff, real values in the Zip64 extra (id=0x0001)
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
    extra.writeBigUInt64LE(0n, 20);
    const ch = Buffer.alloc(46 + name.length + extra.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(45, 6);
    ch.writeUInt32LE(0xffffffff, 20);
    ch.writeUInt32LE(0xffffffff, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(0xffffffff, 42);
    name.copy(ch, 46);
    extra.copy(ch, 46 + name.length);
    // Zip64 EOCD + locator + classic EOCD (all placeholders)
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(1n, 24);
    z64.writeBigUInt64LE(1n, 32);
    z64.writeBigUInt64LE(BigInt(ch.length), 40);
    z64.writeBigUInt64LE(BigInt(cenStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cenStart + ch.length), 8);
    loc.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    const buf = Buffer.concat([lh, name, data, ch, z64, loc, eocd]);

    const mem = new ZipArchive(buf);
    assert(mem.has('hello.txt'), 'ZipArchive should recognize the Zip64 entry');
    assert(String(mem.read('hello.txt')) === 'hello zip64 apkstart', 'ZipArchive content should be correct');
    assert(mem.entries.get('hello.txt').uncompSize === data.length, 'ZipArchive uncompressed size should come from the extra');

    const zipPath = path.join(TMP, 'zip64.zip');
    fs.writeFileSync(zipPath, buf);
    const file = new ZipFile(zipPath);
    try {
      assert(file.has('hello.txt'), 'ZipFile should recognize the Zip64 entry');
      assert(String(file.read('hello.txt')) === 'hello zip64 apkstart', 'ZipFile content should be correct');
      assert(file.entries.get('hello.txt').localOffset === 0, 'ZipFile local header offset should come from the extra');
    } finally {
      file.close();
    }
  });

  console.log('\n[emulator.js zero-config AVD]');

  await test('AVD uses a small data partition + quick boot + a modern GPU mode', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096, accel: 'auto' });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.ramSize=2048$/m.test(cfg));
    assert(/^disk\.dataPartition\.size=4096M$/m.test(cfg), 'data partition should not be 16G');
    assert(/^hw\.gpu\.mode=software$/m.test(cfg));
    assert(!/^fastboot\.forceColdBoot=yes$/m.test(cfg), 'should no longer force a cold boot');
    assert(!/^fastboot\.forceFastBoot=/m.test(cfg), 'snapshots are controlled by -snapshot on the command line, so an old default_boot is never loaded');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg));
    assert(fs.existsSync(path.join(r.avdDir, 'snapshot.key')), 'should write the snapshot fingerprint');
  });

  await test('launch args carry auto memory/cores/snapshot and no deprecated GPU mode', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // Without a snapshot (fresh AVD / just invalidated) never pass -snapshot:
    // qemu waits forever for a memory state that doesn't exist; the process lives but never boots.
    const fresh = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-gpu software/.test(fresh));
    assert(!/swiftshader_indirect/.test(fresh));
    assert(/-memory 2048/.test(fresh) && /-cores 2/.test(fresh));
    if (!emu.hasSnapshot()) {
      // Without a snapshot only *loading* is disabled, not saving: -no-snapshot also turns off
      // the save on exit, so the first cold boot never produces a snapshot and every launch is a full boot.
      assert(/-no-snapshot-load/.test(fresh), 'without a snapshot use -no-snapshot-load (skip loading only)');
      assert(!/ -no-snapshot( |$)/.test(fresh), 'without a snapshot do not use -no-snapshot (it disables the save on exit)');
    }
    // Quickboot only when a snapshot really exists, and it must look like a *complete* one:
    // an interrupted save leaves a shell with a few-dozen-byte snapshot.pb, which must count as no snapshot,
    // or the emulator tries to load it, fails, falls back to a cold boot and wastes seconds.
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots');
    const created = !fs.existsSync(snapDir);
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });

    // A shell (12-byte pb, no ram.img) must count as no snapshot
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(12));
    assert(!emu.hasSnapshot(), 'an incomplete snapshot must not count as usable');
    const broken = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-no-snapshot-load/.test(broken), 'a shell snapshot must fall back to a cold boot (skip loading)');

    // Complete snapshot: pb has content + ram.img has data (hasSnapshot cleans up the shell from the previous step)
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'ram.img'), Buffer.alloc(2 * 1024 * 1024));
    const withSnap = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(withSnap), 'with a snapshot it should use the quickboot snapshot');
    assert(!/-no-snapshot-load/.test(withSnap), 'with a complete snapshot loading must not be skipped');
    if (created) fs.rmSync(snapDir, { recursive: true, force: true });

    const cold = emu.buildArgs({ wipe: true }).join(' ');
    assert(/-wipe-data/.test(cold), 'wipe must pass -wipe-data');
    // On a data reset: don't load the old snapshot (data won't match) but **allow saving** a new one.
    // "Repair network" relies on this: after a reset the first boot has network -> save a snapshot -> restore next time.
    // The old code passed -no-snapshot here, which also turned off saving, so the repaired network couldn't be saved.
    assert(/ -no-snapshot-load( |$)/.test(cold), 'wipe must not load the old snapshot');
    assert(!/ -no-snapshot( |$)/.test(cold), 'wipe must still allow saving a new snapshot (repair network depends on it)');
  });

  // PowerShell 5.1 reads BOM-less UTF-8 as ANSI. Any non-ASCII text in the window agent script then gets
  // mangled and can merge a C# comment with the next line of code, so Add-Type fails to compile --
  // seen as "window agent failed to start / app window not embedded". Hit once; pinned by this test.
  await test('the window agent script must have a UTF-8 BOM (or non-ASCII text breaks Add-Type)', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const buf = fs.readFileSync(file);
    assert(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'agent.ps1 is missing the UTF-8 BOM');
  });

  // The emulator window must be a *child* of the Chromium render layer, not a sibling child of the host.
  // As a sibling, Electron keeps raising the web layer to the top: black covers the Android screen and the
  // mouse is swallowed (black borders / not filled / clicks ignored / can't tap Agree). The embedded window
  // must not get a window region either: it breaks hit testing and shows black borders after a resize.
  await test('the embedded window must sit under the web layer and must not get a window region', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const src = fs.readFileSync(file, 'utf8');
    assert(/SetParent\(emu, parent\)/.test(src), 'embed must parent to the window FindChromeRender found');
    assert(/FindChromeRender\(host\)/.test(src), 'must look up the Chromium render child window');
    assert(!/CreateRectRgn\(0, clipTop/.test(src), 'must not set a clip region on the embedded window');
    assert(/SetWindowRgn\(emu, IntPtr\.Zero/.test(src), 'embed must clear regions left by old versions');
  });

  // Rotation must change the *physical panel size* and restart, not just the runtime wm size / density:
  //   - wm size: the physical LCD is still portrait -> picture lies 90 degrees, fills a strip in the top-left, taps land wrong;
  //   - wm density: framebuffer size unchanged -> picture doesn't fill, big blank area on the right when maximized.
  await test('landscape must use the physical panel size (lcdFor landscape), never a runtime wm size rotation', () => {
    const doctor = require('../src/core/doctor');
    const p = doctor.lcdFor({ accelOk: true, landscape: false });
    const l = doctor.lcdFor({ accelOk: true, landscape: true });
    assert(p.w === 720 && p.h === 1280, `portrait should be 720x1280, got ${p.w}x${p.h}`);
    assert(l.w === 1280 && l.h === 720, `landscape should be 1280x720, got ${l.w}x${l.h}`);

    const adb = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'adb.js'), 'utf8');
    const i = adb.indexOf('async setOrientation(');
    const j = adb.indexOf('async resetDisplayOverrides(');
    const body = adb.slice(i, j);
    assert(!/wm size \d/.test(body), 'setOrientation must not set a wm size override');
    assert(/wm density 190/.test(body), 'density is kept only as the degraded path');
  });

  await test('game mode must use high priority and no global mouse hook', () => {
    const ps = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'priority.ps1'), 'utf8');
    assert(/game\s*=\s*'High'/.test(ps), 'the game level must raise qemu to High');
    const aw = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/opts\.enabled && !game/.test(aw), 'game mode must not install the WH_MOUSE_LL global hook');
  });

  await test('foreground app priority must not be below normal (responsive taps / smooth video)', () => {
    const engJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
    // balanced/performance with an app in front must be normal: below starves qemu,
    // seen as dropped video frames and taps that respond late (the main cause of "taps feel laggy").
    const begin = engJs.slice(engJs.indexOf('async beginApp'));
    assert(/mode === 'game' \? 'game' : 'normal'/.test(begin),
      'beginApp foreground priority should map game->game, everything else->normal');
    assert(!/performance.*\? 'normal' : 'below'/.test(begin),
      'balanced must no longer drop to below');
    // setPriority must run on every beginApp, not just the first (switching back must raise it again)
    assert(begin.split('setPriority(level)').length >= 2 || /if \(first\)[\s\S]{0,200}cancelSnapshotSave[\s\S]{0,300}setPriority\(level\)/.test(begin),
      'setPriority must run on every beginApp, not just the first');
  });

  await test('resource saver mode lowers the memory cap (less runtime usage)', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
    assert(/rmode === 'save'[\s\S]{0,120}2048/.test(doc),
      'save mode must cap memoryMB at 2048 (saves about 1 GB RAM + 1 GB of snapshot disk)');
    assert(/!overrides\.memoryMB/.test(doc), 'save-mode memory capping must yield to a manual value');
  });

  await test('a failed download must delete leftovers (or the same package is downloaded forever)', () => {
    const dl = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'download.js'), 'utf8');
    assert(/function discardPartial/.test(dl), 'needs discardPartial');
    assert(/chunks\.json/.test(dl), 'discardPartial must delete the chunk sidecar too');
    // Failure paths of download / downloadParallel / downloadMulti must all call it
    const calls = (dl.match(/discardPartial\(/g) || []).length;
    assert(calls >= 6, `too few cleanup points (only ${calls}); some path still leaves a partial file`);
    // Outermost safety net: openStream rejecting outright (refused / DNS / timeout) must clean up too
    assert(/catch \(e\) \{[\s\S]{0,200}discardPartial\(dest\)[\s\S]{0,80}throw e;[\s\S]{0,40}\}[\s\S]{0,10}\}/.test(dl),
      'download must catch openStream rejecting at the outermost level');
  });

  await test('old-version cleanup: finds ApkStart folders anywhere and never touches the running version', () => {
    const os = require('os');
    const leftovers = require('../src/core/leftovers');
    const np = (p) => { try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); } };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-left-'));
    try {
      const mk = (name) => {
        const d = path.join(root, name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'ApkStart.exe'), 'fake-exe');
        return d;
      };
      const old1 = mk('ApkStart-v0.3.9-win64-portable');
      const old2 = mk('ApkStart-win64-portable.prev-2026-01-01T00-00-00-000Z');
      const curDir = mk('ApkStart-v0.5.0-win64-portable');
      const r = leftovers.scan({ installDir: curDir, dataDir: root, avdHome: '' });
      const found = r.items.filter((i) => i.kind === 'dir').map((i) => np(i.path));
      assert(found.includes(np(old1)), 'plain old-version folder not found');
      assert(found.includes(np(old2)), '.prev packaging backup leftover not found');
      assert(!found.includes(np(curDir)), 'the running version was treated as an old version (dangerous)');
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('auto setup needs a failure cooldown (so it does not re-download on every start)', () => {
    const mainJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert(/deployFailedAt/.test(mainJs), 'must record when setup last failed');
    assert(/COOLDOWN_MS|cooldown/.test(mainJs), 'needs a cooldown window');
    assert(/force/.test(mainJs.slice(mainJs.indexOf('async function autoDeploy'))),
      'manual one-click setup must be able to bypass the cooldown and retry at once');
  });

  await test('ram.bin written by newer emulators counts as a complete snapshot (or a fresh 3 GB save is deleted as a shell)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots', 'apkstart');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'ram.bin'), Buffer.alloc(2 * 1024 * 1024));
    assert(emu.hasSnapshot(), 'ram.bin should count as a complete snapshot');
    const args = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(args), 'with a snapshot it should quickboot');
    assert(!/-no-snapshot-load/.test(args), 'with a complete snapshot loading must not be skipped');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
  });

  await test('userdata seed image: 4K blocks + ENCRYPT + consistent accounting', () => {
    const { buildEmptyExt4 } = require('../src/core/userdata');
    const sb = 1024;
    const img = buildEmptyExt4({ sizeMB: 64, encrypt: false });
    assert(img.readUInt16LE(sb + 0x38) === 0xEF53, 'superblock magic must be 0xEF53');
    // dm-default-key (Android 13 /data metadata encryption) uses a 4096-byte logical block;
    // a smaller fs block makes mount() return EINVAL -- the real reason /data wouldn't mount.
    assert(img.readUInt32LE(sb + 0x18) === 2, 's_log_block_size must be 2 (4096 bytes)');
    assert(img.readUInt32LE(sb + 0x1C) === 2, 's_log_cluster_size must equal the block size');
    // Without ext_attr, setxattr returns EOPNOTSUPP and SELinux labels can't be written;
    // netd / media / tombstoned all exit 1 and boot hangs on the animation.
    assert((img.readUInt32LE(sb + 0x5C) & 0x8) !== 0, 'must have ext_attr');
    const total = img.readUInt32LE(sb + 0x04);
    const free = img.readUInt32LE(sb + 0x0C);
    const inodes = img.readUInt32LE(sb + 0x00);
    const freeInodes = img.readUInt32LE(sb + 0x10);
    assert(free > 0 && free < total, 'free block count must be within (0, total)');
    assert(freeInodes === inodes - 10, 'free inodes must exclude reserved inodes 1-10 (e2fsck checks this)');
    const withEnc = buildEmptyExt4({ sizeMB: 64 });
    assert((withEnc.readUInt32LE(sb + 0x60) & 0x10000) !== 0, 'ENCRYPT must be on by default (FBE needs it)');
    assert((img.readUInt32LE(sb + 0x60) & 0x10000) === 0, 'encrypt:false must clear that bit');
  });

  console.log('\n[display / shortcuts / zero-touch]');
  await test('window mode must really open a window (or the app runs but is invisible)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const win = emu.buildArgs({ headless: false, gpu: 'software', lcd: { w: 720, h: 1280, dpi: 320 } }).join(' ');
    assert(!/-no-window/.test(win), 'window mode must not use -no-window');
    // No more -no-skin: it overrides -skin and the panel size falls back to the old config.ini value,
    // seen as "switched to landscape in Settings but still portrait" / "picture fills only a strip in the top-left".
    assert(!/\s-no-skin(\s|$)/.test(win), 'window mode must not pass -no-skin (it overrides -skin)');
    assert(/-skin \d+x\d+/.test(win), 'window mode must set the panel size explicitly with -skin');
    const headless = emu.buildArgs({ headless: true }).join(' ');
    assert(/-no-window/.test(headless));
  });

  await test('audio: on by default (no -no-audio), -no-audio only when turned off', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // Override the settings getter: on by default means no -no-audio
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: true } }) });
    const on = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(!/-no-audio/.test(on), 'audio=true must not pass -no-audio');
    // Only when turned off should -no-audio be passed
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: false } }) });
    const off = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(/-no-audio/.test(off), 'audio=false must pass -no-audio');
  });

  await test('old settings are migrated: headless and "exit after launch" no longer apply', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { headless: true }, hideAfterLaunch: true });
    const s = store.getSettings();
    assert(s.engine.headless === false, 'headless must be migrated to false');
    assert(s.hideAfterLaunch === false, 'hideAfterLaunch must be false');
    assert(s.autoStart === false && s.autoDeploy === true, 'start with Windows is off and one-click setup is on by default');
    assert(s.language === 'auto', 'the UI language follows Windows by default');
    assert(s.createStartMenuShortcut === true, 'the Start menu shortcut is on by default');
  });

  await test('display fit: window and fullscreen share the portrait resolution, window keeps 9:16 and can stretch', () => {
    const d = require('../src/core/display');
    const area = { x: 0, y: 0, w: 1920, h: 1080 };
    // Fullscreen doesn't change the Android resolution (the emulator window aspect is locked to the LCD); it only maximizes
    assert(JSON.stringify(d.sizeFor('fullscreen', '900x1600', area)) === JSON.stringify({ w: 900, h: 1600 }));
    assert(JSON.stringify(d.sizeFor('window', '720x1280', area)) === JSON.stringify({ w: 720, h: 1280 }));
    assert(d.sizeFor('window', 'not-a-size', area).h > d.sizeFor('window', 'not-a-size', area).w);
    const b = d.defaultBounds(area);
    assert(b.h > b.w && b.h <= area.h && b.x >= 0 && b.y >= 0, JSON.stringify(b));
    // Fullscreen: full height, width from the portrait ratio, centered (aspect locked to the emulator LCD)
    const f = d.fullscreenBounds('900x1600', area);
    assert(f.h === area.h, JSON.stringify(f));
    assert(Math.abs(f.w - Math.round(f.h * 900 / 1600)) <= 1, JSON.stringify(f));
    assert(f.x > 0 && f.x + f.w <= area.w, JSON.stringify(f));
    assert(d.densityFor(1080, 1920, 0) > 300);
    assert(d.densityFor(720, 1280, 240) === 240);
  });

  await test('adb display commands use wm size / wm density', async () => {
    const { AdbClient } = require('../src/core/adb');
    const cmds = [];
    const fake = { shell: async (c) => { cmds.push(c); return ''; } };
    await AdbClient.prototype.setDisplaySize.call(fake, 1920, 1080, 420);
    assert(cmds.includes('wm size 1920x1080'), cmds.join('|'));
    assert(cmds.includes('wm density 420'), cmds.join('|'));
    await AdbClient.prototype.resetDisplaySize.call(fake);
    assert(cmds.includes('wm size reset') && cmds.includes('wm density reset'));
  });

  await test('PNG-in-ICO and the WebP icon fallback both produce a usable ICO', async () => {
    const { pngBytesToIco, iconToIco } = require('../src/core/shortcut');
    const { drawAppIcon } = require('../src/core/png');
    const png = drawAppIcon(64);
    const ico = pngBytesToIco(png);
    assert(ico && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 1, 'ICO header should declare 1 image');
    assert(ico.readUInt32LE(14) === png.length, 'embedded PNG length should match');
    assert(ico.slice(22).equals(png), 'ICO data should be the original PNG');
    assert(pngBytesToIco(Buffer.from('not a png')) === null);
    // WebP (nativeImage can't decode it) -> without a decode callback, fall back to the brand placeholder ICO
    const webp = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP'), Buffer.alloc(32)]);
    const fallback = await iconToIco(webp);
    assert(fallback && fallback.length > 22, 'WebP should get an icon too');
    const decoded = await iconToIco(webp, { decode: async () => png });
    assert(decoded && decoded.slice(22).equals(png), 'with decode it should use the real icon');
  });

  await test('the window control script exists and is pure ASCII (no mangled non-ASCII paths/titles)', () => {
    const w = require('../src/core/windowctl');
    assert(fs.existsSync(w.SCRIPT), 'missing windowctl.ps1');
    const b = fs.readFileSync(w.SCRIPT);
    assert(!b.some((x) => x > 127), 'the ps1 must be pure ASCII; non-ASCII text is passed in via UTF-8 JSON');
    assert(typeof w.present === 'function' && typeof w.getBounds === 'function');
  });

  await test('xzFile feeds the source into stdin and produces an image the runtime can unpack (CI hang regression)', async () => {
    const { xzFile } = require('../build/prepare-runtime');
    const zlib = require('zlib');
    const crypto = require('crypto');
    const dir = path.join(TMP, 'xz-regression');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'sample.img');
    const payload = Buffer.concat([
      Buffer.from('APKSTART-XZ-REGRESSION'),
      crypto.randomBytes(256 * 1024),
      Buffer.alloc(1024 * 1024),
    ]);
    fs.writeFileSync(src, payload);
    const dest = path.join(dir, 'sample.img.xz');

    const saved = { XZ_PRESET: process.env.XZ_PRESET, XZ_TIMEOUT_MS: process.env.XZ_TIMEOUT_MS };
    process.env.XZ_PRESET = '1';           // small sample: fastest preset, don't slow the suite down
    process.env.XZ_TIMEOUT_MS = '15000';  // a real hang is killed within 15 s so CI doesn't stall
    let timer;
    try {
      await Promise.race([
        xzFile(src, dest),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('xzFile did not return within 25 s (stdin never got EOF?)')), 25000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    const have = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    const out = have(dest) > 0 ? dest : dest.replace(/\.xz$/, '.gz');
    assert(have(out) > 0, 'compressed output must not be 0 bytes');
    let back;
    if (/\.xz$/i.test(out)) {
      // Don't depend on the @napi-rs/lzma native binding: the CI Node 20 job can't load it
      // because of a known npm optional-dependencies bug (Node 22 is fine).
      // Read it back with the same python lzma the compressor used and check the XZ magic;
      // runtime unpack compatibility is covered end to end by the real installer.
      assert(fs.readFileSync(out).subarray(0, 6).equals(
        Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
      ), 'must be a valid XZ container');
      const { findPython } = require('../build/prepare-runtime');
      const py = findPython();
      assert(py, 'produced XZ but no python found to verify it');
      const backPath = path.join(dir, 'sample.img.back');
      require('child_process').execFileSync(py, ['-c',
        'import lzma,sys;open(sys.argv[1],"wb").write(lzma.open(sys.argv[2],"rb").read())',
        backPath, out], { stdio: 'ignore' });
      back = fs.readFileSync(backPath);
    } else {
      back = zlib.gunzipSync(fs.readFileSync(out));
    }
    assert(back.equals(payload), 'unpacked content must match the source image byte for byte');
  });

  console.log('\n[container.js app-level container]');

  const container = require('../src/core/container');

  await test('system/framework packages are never trimmed; only user apps join session cleanup', () => {
    for (const p of ['android', 'com.android.systemui', 'com.google.android.gms', 'com.foo.bar.baz']) {
      const sys = container.isSystemPackage(p);
      if (p.startsWith('com.foo')) assert(!sys, `${p} should be a user app`);
      else assert(sys, `${p} should be a system package`);
    }
    assert(container.isSystemPackage(''), 'an empty package name counts as system, so no invalid command is built');
  });

  await test('launching an app stops only other installed apps and never touches system packages by default', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.phoenix.read', 'com.other.app', 'com.android.vending', 'com.google.android.gms', 'com.third.game'],
    });
    assert(r.stopped.length === 2, `should stop 2 other user apps, got ${r.stopped.join(',')}`);
    assert(r.stopped.includes('com.other.app') && r.stopped.includes('com.third.game'));
    assert(!r.commands.some((c) => c.includes('pm disable')), 'must not disable system packages by default');
    assert(!r.commands.some((c) => c.includes('kill-all')), 'launch must not clear background apps, or it may hit the app just brought to front');
    assert(!r.commands.some((c) => /force-stop (android|com\.android|com\.google\.android)/.test(c)), 'must not force-stop the system framework');
  });

  await test('package name whitelist: a tainted list cannot build an injected command', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.evil;rm -rf /', 'com.ok.app', '$(whoami)', 'com.foo-bar'],
    });
    assert(r.stopped.length === 1 && r.stopped[0] === 'com.ok.app', `should stop only valid package names, got ${r.stopped.join(',')}`);
    assert(!r.commands.some((c) => c.includes('rm -rf') || c.includes('$(')), 'no injected fragments allowed');
  });

  await test('deep trim can disable background packages, restores fully and leaves required components alone', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read', installed: [], deep: true,
    });
    assert(r.disabled.length > 0, 'deep trim should have packages to disable');
    assert(r.commands.some((c) => c.includes('pm disable-user --user 0 com.android.vending')));
    for (const p of container.NEVER_TRIM) {
      assert(!r.disabled.includes(p), `${p} must never be disabled`);
    }
    const back = container.buildRestoreCommands();
    for (const p of container.OPTIONAL_SYSTEM) {
      assert(back.some((c) => c.includes(`pm enable ${p}`)), `${p} must be restorable`);
    }
  });

  await test('container parking: clear background + Android idle; state machine handles multiple windows / last close', () => {
    const idle = container.buildIdleCommands();
    assert(idle.some((c) => c.includes('am kill-all')), 'parking should clear cached background processes');
    assert(idle.some((c) => c.includes('deviceidle force-idle')), 'parking should put Android into idle');
    let s = container.nextSessionState([], 'open', 'a');
    assert(s.hasApp && !s.idle && s.foreground === 'a');
    s = container.nextSessionState(s.active, 'open', 'b');
    assert(s.active.length === 2 && s.foreground === 'b');
    s = container.nextSessionState(s.active, 'close', 'a');
    assert(s.active.length === 1 && s.hasApp && !s.idle);
    s = container.nextSessionState(s.active, 'close', 'b');
    assert(s.idle && !s.hasApp && s.active.length === 0, 'the container should park after the last window closes');
  });

  await test('doctor lite container: caps vCPUs, manual settings win', () => {
    const host = { totalMB: 32768, freeMB: 20000, cores: 16, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const lite = doctor.liteProfile({ host, engine: {} });
    // The old logic was floor(cores/4) clamped to 2-3 -- an 8-core machine got 2 vCPUs and video apps stuttered.
    // Now balanced mode gets half the physical cores, capped at 4; resource saver is fixed at 2.
    assert(lite && lite.cores === 4, `a 16-core machine in balanced mode should get 4 cores, got ${lite && lite.cores}`);
    const save = doctor.liteProfile({ host, engine: { resourceMode: 'save' } });
    assert(save.cores === 2, `resource saver should be fixed at 2 cores, got ${save.cores}`);
    assert(doctor.liteProfile({ host, engine: { liteMode: false } }) === null, 'explicitly off should return null');
    const low = doctor.liteProfile({ host: { ...host, cores: 2 }, engine: {} });
    assert(low.cores === 2, 'a 2-core machine keeps at least 2 cores');

    const auto = doctor.autoProfile({
      settings: { engine: { autoMemory: true, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000,
    });
    assert(auto.lite === true && auto.cores <= 4, JSON.stringify({ lite: auto.lite, cores: auto.cores }));
    const manual = doctor.autoProfile({
      settings: { engine: { autoMemory: false, cores: 6, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000,
    });
    assert(manual.cores === 6, 'cores set by the user must win over lite mode');
    assert(/lite container/.test(doctor.describeProfile(auto)), 'the diagnostic summary should mention the lite container');
  });

  await test('global mouse hook is off by default and the window agent no longer blocks its message pump for long', () => {
    const root = path.join(__dirname, '..');
    const agentPs1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const agentJs = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    assert(/mouseSideButtons:\s*false/.test(storeJs), 'the side-button hook must be off in the default settings');
    assert(!/winAgent\.hook\(true\)/.test(mainJs), 'the main process must not install the global hook unconditionally');
    assert(!/agent\.hook\(true\)/.test(appwinJs), 'app windows must not install the global hook unconditionally');
    assert(!/sharer\.start\(8000\)/.test(mainJs), 'file sync must not run permanently by default');
    assert(/setHook/.test(agentJs) && /hooked/.test(agentJs), 'the hook switch must be idempotent and closable');
    assert(/new Thread\(HookThreadProc\)/.test(agentPs1), 'the hook must be installed on a dedicated message thread');
    assert(/GetMessage\(out MSG/.test(agentPs1), 'the hook thread must run a message loop');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(agentPs1), 'the main loop must not block for 4 seconds');
    assert(/Poll\(50,\s*SelectMode\.SelectRead\)/.test(agentPs1), 'the main loop should poll briefly to keep the message pump responsive');
    assert(/now - _embedAt < 8000/.test(agentPs1), 'window scanning must be time-limited, not EnumWindows every 2 s forever');
    assert(/setLiteMode/.test(uiHtml) && /setDeepTrim/.test(uiHtml), 'Settings must expose the lite container options');
  });

  await test('WinAgent.setHook(false) does not start the PowerShell agent in the default state', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    a.hooked = false;
    const r = await a.setHook(false);
    assert(r && r.hooked === false, 'turning off should return hooked=false');
    assert(a.ready === null, 'when off by default it must not start a resident agent process for this');
  });

  console.log('\n[mouse button mapping]');

  await test('defaults and old-config migration: right-click = Back + smooth wheel on, side buttons off', () => {
    const store = require('../src/core/store');
    const d = pointer.pointerOptions(store.getSettings());
    assert(d.rightBack === true, 'right-click Back is on by default');
    assert(d.wheel === 'smooth', 'wheel is smooth by default');
    assert(d.side === false, 'side buttons are off by default');
    assert(d.enabled === true, 'right-click mapping alone needs the hook');
    // An old settings.json without the new keys must give the same result
    assert(pointer.pointerOptions({ engine: { liteMode: true } }).rightBack === true);
    const off = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'off', mouseSideButtons: false } });
    assert(off.enabled === false, 'with everything off no hook should be installed');
    const native = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'native', mouseSideButtons: false } });
    assert(native.enabled === false, 'the native wheel needs no hook');
  });

  await test('hookOptions normalizes the config; when off every sub-switch is zeroed', () => {
    const on = pointer.hookOptions({ enabled: true, rightBack: true, wheel: true, side: false });
    assert(on.rightBack && on.wheel && !on.side);
    const off = pointer.hookOptions({ enabled: false, rightBack: true, wheel: true, side: true });
    assert(!off.rightBack && !off.wheel && !off.side, 'enabled=false must not intercept any event');
    assert(pointer.hookOptions(true).side === true, 'supports the old boolean form (side buttons)');
    assert(pointer.hookOptions(false).enabled === false);
  });

  await test('wheel direction: scroll down = finger swipes up, scroll up = finger swipes down, coordinates stay in bounds', () => {
    const down = pointer.wheelToSwipe({ dy: -120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(down && down.y1 > down.y2, 'scrolling down should move content up (finger swipes up)');
    const up = pointer.wheelToSwipe({ dy: 120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(up && up.y1 < up.y2, 'scrolling up should move content down (finger swipes down)');
    assert(pointer.wheelToSwipe({ dx: 0, dy: 0 }) === null, 'zero movement produces no command');
    for (const s of [down, up]) {
      assert([s.x1, s.x2].every((v) => v >= 1 && v <= 899), 'x out of bounds');
      assert([s.y1, s.y2].every((v) => v >= 1 && v <= 1599), 'y out of bounds');
      assert(s.duration >= 100 && s.duration <= 240, 'swipe duration should be capped');
    }
    const big = pointer.wheelToSwipe({ dy: -12000, nx: 0, ny: 0, width: 900, height: 1600 });
    assert(big.y1 - big.y2 <= Math.round(1600 * 0.78), 'fast scrolling must not stretch the gesture without limit');
    const horiz = pointer.wheelToSwipe({ dx: 120, dy: 0, width: 900, height: 1600 });
    assert(horiz && horiz.x1 > horiz.x2 && horiz.y1 === horiz.y2, 'a horizontal wheel should produce a horizontal swipe');
  });

  await test('input command whitelist: only internally built commands pass, injection is blocked', async () => {
    assert(pointer.isInputCommand('input keyevent 4'));
    assert(pointer.isInputCommand(pointer.swipeToCommand(pointer.wheelToSwipe({ dy: -120 }))));
    assert(!pointer.isInputCommand('input keyevent 4; rm -rf /sdcard'));
    assert(!pointer.isInputCommand('input swipe 1 2 3 4 100 && reboot'));
    assert(!pointer.isInputCommand('sh -c anything'));
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    let blocked = false;
    try { await c.input('input keyevent 4; rm -rf /'); } catch (e) { blocked = /Invalid input command/.test(e.message); }
    assert(blocked, 'an invalid command must be blocked before adb is started');
    assert(c._input === null, 'a blocked command must not create a resident session');
  });

  await test('Back key prefers the resident input channel and falls back to a one-off adb only on failure', async () => {
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used = [];
    c.input = async (cmd) => { used.push(cmd); };
    c.shell = async () => { used.push('shell'); };
    await c.keyBack();
    assert(used[0] === 'input keyevent 4' && !used.includes('shell'), 'the normal path must not spawn adb');
    const c2 = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used2 = [];
    c2.input = async () => { throw new Error('offline'); };
    c2.shell = async (cmd) => { used2.push(cmd); return ''; };
    await c2.keyForward();
    assert(used2[0] === 'input keyevent 125', 'a failed resident channel must fall back, not drop the click');
  });

  await test('WheelRouter merges continuous scrolling into one swipe command', async () => {
    const cmds = [];
    const r = new pointer.WheelRouter({
      inject: async (cmd) => { cmds.push(cmd); },
      getSize: () => ({ width: 900, height: 1600 }),
      flushMs: 10,
    });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.4 });
    await r.flush();
    assert(cmds.length === 1, `3 wheel notches should merge into 1 command, got ${cmds.length}`);
    assert(pointer.isInputCommand(cmds[0]), 'must produce a valid input swipe');
    const m = /^input swipe (\d+) (\d+) (\d+) (\d+)/.exec(cmds[0]);
    assert(m && Number(m[2]) > Number(m[4]), 'after merging it is still a scroll-down direction');
    r.dispose();
    r.push({ dy: -120 });
    await r.flush();
    assert(cmds.length === 1, 'nothing may be injected after dispose');
  });

  await test('agent script: right-click/wheel interception, wheel merging, foreground scoping and a dedicated thread', () => {
    const ps1 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    assert(/WM_RBUTTONDOWN/.test(ps1) && /WM_MOUSEWHEEL/.test(ps1), 'must handle right-click and the wheel');
    assert(/WM_MOUSEHWHEEL/.test(ps1), 'the horizontal wheel must be supported too');
    assert(/PushWheel\(/.test(ps1) && /FlushWheel\(false\)/.test(ps1), 'wheel events must be merged before reporting');
    assert(/GetAncestor\(fg, 2\)/.test(ps1), 'scope must be limited to the foreground root window');
    assert(/new Thread\(HookThreadProc\)/.test(ps1) && /GetMessage\(out MSG/.test(ps1), 'the hook must run on a dedicated message thread');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(ps1), 'the main loop must not block for long');
    assert(/_optRight == 0/.test(ps1) && /_optWheel == 0/.test(ps1), 'unconfigured mappings must not intercept events');
    const appwinJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/pointerConfig/.test(appwinJs) && /refreshPointer/.test(appwinJs), 'settings changes must sync to the hook right away');
    const uiHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
    assert(/setMouseRightBack/.test(uiHtml) && /setMouseWheelMode/.test(uiHtml), 'Settings must expose the button mapping switches');
  });

  await test('WinAgent.setHook sends the button mapping along and does not start the agent when off', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    a.call = async (obj) => { sent.push(obj); return { ok: true, hooked: true }; };
    const on = await a.setHook(true, { rightBack: true, wheel: true, side: false });
    assert(on.hooked === true && sent.length === 1, 'turning on should send exactly one command');
    assert(sent[0].right === 1 && sent[0].wheel === 1 && sent[0].side === 0, 'the config must be sent with the hook command');
    await a.setHook(false);
    assert(sent[1].on === 0 && a.hooked === false, 'turning off should remove the hook');
    const b = new WinAgent();
    const r = await b.setHook(false);
    assert(r.hooked === false && b.ready === null, 'when off by default PowerShell must not be started');
  });

  console.log('\n[updater.js online updates]');
  // Updates are off in this build (package.json "updateRepo" is ""). Tests that need an enabled
  // updater point it at a fake repo; updateRepo() reads the cached package.json object.
  const withUpdateRepo = async (repo, fn) => {
    const pkg = require('../package.json');
    const saved = pkg.updateRepo;
    pkg.updateRepo = repo;
    try { return await fn(); } finally { pkg.updateRepo = saved; }
  };
  await test('version compare goes segment by segment as numbers; v prefix / many segments work', () => {
    const { cmpVer } = require('../src/core/updater');
    assert(cmpVer('v0.3.2', '0.3.1') === 1, '0.3.2 should be greater than 0.3.1');
    assert(cmpVer('0.3.1', 'v0.3.1') === 0, 'the v prefix does not affect equality');
    assert(cmpVer('0.10.0', '0.9.9') === 1, 'must compare as numbers, not strings');
    assert(cmpVer('1.0.0', '1.0.1') === -1, '1.0.0 is less than 1.0.1');
  });

  await test('install shape decides the asset: installer = Setup.exe, portable = portable.zip', () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-setup');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'ApkStart.exe');
    fs.writeFileSync(exe, 'x');
    const portable = new Updater({ currentVersion: '0.1.0', exePath: exe, isPackaged: true, dataDir: TMP });
    assert(portable.flavor === 'portable', 'no uninstaller means portable');
    fs.writeFileSync(path.join(dir, 'Uninstall ApkStart.exe'), 'x');
    assert(portable.flavor === 'setup', 'an uninstaller means installer');
    // Asset picking is pure; just check the fallback naming rules here
    assert(/Setup\.exe$/i.test('ApkStart-0.3.2-Setup.exe'), 'installer asset name matches');
    assert(/portable.*\.zip$/i.test('ApkStart-v0.3.2-win64-portable.zip'), 'portable asset name matches');
  });

  await test('the portable build never takes the runtime pack (ApkStart-runtime-*.zip) as an update', () => withUpdateRepo('o/r', async () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-asset');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'ApkStart.exe');
    fs.writeFileSync(exe, 'x');
    const sha256 = 'ab'.repeat(32);
    const mk = (assets) => ({
      version: '0.5.0', tag: 'v0.5.0', name: 'ApkStart v0.5.0', notes: '', htmlUrl: '',
      publishedAt: '', sources: [], unreachable: [], assets,
    });
    const u = new Updater({ currentVersion: '0.3.4', exePath: exe, isPackaged: true, dataDir: dir });
    // Both assets present -> must pick the portable package
    u.sources = { latest: async () => mk([
      { name: 'ApkStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', size: 0, sha256 },
      { name: 'ApkStart-v0.5.0-win64-portable.zip', url: 'https://x/p.zip', size: 0, sha256 },
    ]) };
    let info = await u.check({ force: true });
    assert(info.asset && /portable/.test(info.asset.name), `should pick the portable package, got ${info.asset && info.asset.name}`);

    // Only the runtime pack (portable package not uploaded) -> no auto-update rather than 1.5 GB of runtime as the app
    u.sources = { latest: async () => mk([
      { name: 'ApkStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', size: 0, sha256 },
    ]) };
    info = await u.check({ force: true });
    assert(!info.asset, 'with only a runtime pack no update asset should be picked');
    assert(info.canAutoApply === false, 'no usable asset means no auto-update');
  }));

  await test('mirrors: candidates are the URL plus the user-set prefix, GitHub URLs only', () => {
    const { Sources, withMirror } = require('../src/core/sources');
    const url = 'https://github.com/o/r/releases/download/v1/a.zip';
    const plain = new Sources(() => ({ runtime: {} }));
    assert(JSON.stringify(plain.candidates(url)) === JSON.stringify([url]), 'no prefix set = direct URL only (no built-in mirrors)');

    const custom = new Sources(() => ({ runtime: { mirrorPrefix: 'https://my.mirror/' } }));
    const c2 = custom.candidates(url);
    assert(c2.length === 2 && c2[0] === url && c2[1] === `https://my.mirror/${url}`, `the custom prefix should apply, got ${JSON.stringify(c2)}`);
    assert(withMirror(url, 'https://x') === `https://x/${url}`, 'a missing trailing slash on the prefix is added');

    // Mirrors only proxy GitHub: other hosts never get the prefix
    assert(custom.candidates('https://example.com/a.zip').length === 1, 'non-GitHub assets must not get a mirror prefix');
  });

  await test('Sources: speed results sort by speed; if all fail the original order is kept', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    // Inject the speed cache directly so the test needs no internet
    s._rankCache.set('https://slow/', { at: Date.now(), ok: true, speed: 1000 });
    s._rankCache.set('https://fast/', { at: Date.now(), ok: true, speed: 9000 });
    s._rankCache.set('https://dead/', { at: Date.now(), ok: false, speed: 0 });
    const ranked = await s.rank(['https://slow/', 'https://dead/', 'https://fast/']);
    assert(ranked[0] === 'https://fast/', `the fastest should be first, got ${ranked[0]}`);
    assert(ranked[2] === 'https://dead/', 'failed URLs go last but are kept (one more chance)');
    s.reset();
    assert(s._rankCache.size === 0, 'reset must clear the speed cache (re-measure after a source or network change)');
  });

  await test('Sources: auto-attached source archives (v1.2.3.zip) are never taken as installers', async () => {
    const { Sources } = require('../src/core/sources');
    const s2 = new Sources(() => ({ runtime: {} }));
    s2.fetchReleases = async () => [
      {
        source: 'github',
        name: 'GitHub',
        web: 'g',
        rel: {
          tag_name: 'v0.3.2',
          assets: [
            { name: 'v0.3.2.zip', size: 999, browser_download_url: 'gh://src' },
            { name: 'v0.3.2.tar.gz', size: 999, browser_download_url: 'gh://src2' },
            { name: 'ApkStart-v0.3.2-win64-portable.zip', size: 10, browser_download_url: 'gh://ok' },
          ],
        },
      },
    ];
    const m = await s2.latest();
    assert(m.assets.length === 1 && m.assets[0].url === 'gh://ok',
      `only ApkStart* assets should be kept, got ${JSON.stringify(m.assets.map((a) => a.name))}`);
  });

  await test('updater: off without updateRepo; the SHA-256 digest reaches updater.asset and no digest = no auto-install', async () => {
    const { Updater } = require('../src/core/updater');
    const u = new Updater({
      currentVersion: '0.0.1', exePath: path.join(TMP, 'A.exe'), isPackaged: true, dataDir: TMP,
      settings: () => ({}),
    });
    u.sources.latest = async () => { throw new Error('must not touch the network'); };
    const off = await withUpdateRepo('', () => u.check({ force: true }));
    assert(off.disabled === true && off.hasUpdate === false && off.canAutoApply === false, JSON.stringify(off));
    assert(off.message === 'Updates are turned off in this build.', off.message);

    await withUpdateRepo('o/r', async () => {
      const asset = { name: 'ApkStart-v9.9.9-win64-portable.zip', size: 10, url: 'https://x/p.zip', sha256: 'ab'.repeat(32) };
      const release = (a) => async () => ({ version: '9.9.9', tag: 'v9.9.9', assets: [a], sources: [], unreachable: [] });
      u.sources.latest = release(asset);
      let info = await u.check({ force: true });
      assert(info.asset && info.asset.sha256 === asset.sha256, 'the sha256 must be kept on the asset');
      assert(info.hasUpdate === true && info.canAutoApply === true, 'a newer, verifiable asset can be auto-installed');
      u.sources.latest = release({ ...asset, sha256: '' });
      info = await u.check({ force: true });
      assert(!info.asset && info.canAutoApply === false, 'an asset without a digest must not be auto-installed');
      let err = null;
      try { await u.prepare({ version: '9.9.9', asset: { ...asset, sha256: '' } }); } catch (e) { err = e; }
      assert(err && /SHA-256/.test(err.message), `prepare must refuse an unverifiable package, got ${err && err.message}`);
    });
  });

  await test('window agent: scope joins folders with semicolons and drops empty items (the only input for window ownership)', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    // Don't start a real agent process: only check the protocol content sent to it
    a.call = async (obj) => { sent.push(obj); return { ok: true, n: 1 }; };
    const r = await a.scope(['C:////runtime', '', null, 'D:////repo////engine']);
    assert(sent.length === 1 && sent[0].cmd === 'scope', `should send exactly one scope, got ${JSON.stringify(sent)}`);
    assert(sent[0].dirs === 'C:////runtime;D:////repo////engine', `empty items should be dropped, got ${sent[0].dirs}`);
    assert(r.ok === true, 'a successful scope should return ok');
    // An empty array must not throw either: it means "suppress nothing"; the caller decides whether to warn
    const empty = await a.scope([]);
    assert(sent[1].dirs === '' && empty.ok === true, 'an empty scope must still be sent (the agent then leaves every window alone)');
  });

  await test('multi-source parallel download: when sources differ in size, follow the fastest (never just the biggest)', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const small = Buffer.alloc(3 * MB);   // the first source (list is already sorted by speed)
    const big = Buffer.alloc(5 * MB);
    for (let i = 0; i < small.length; i += 1) small[i] = i % 251;
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) % 251;
    const serve = (data) => (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    const mk = (data) => new Promise((resolve) => {
      const srv = http.createServer(serve(data));
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk(small);
    const s2 = await mk(big);
    const out = path.join(TMP, 'mixed-size.bin');
    try {
      // List order = rank() speed order: the first is the fastest source
      await downloadMulti([`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`], out, { connections: 4 });
      const got = fs.readFileSync(out);
      assert(got.length === small.length && Buffer.compare(got, small) === 0,
        `should download the fastest source's copy (${small.length} bytes), got ${got.length} bytes`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('multi-source parallel download: chunks from different sources join into identical bytes', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 251;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    // Wait for the listening callback explicitly: attaching a listener after listen() can miss the event and hang the test
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [
      `http://127.0.0.1:${s1.address().port}/f`,
      `http://127.0.0.1:${s2.address().port}/f`,
    ];
    const out = path.join(TMP, 'multi.bin');
    try {
      const r = await downloadMulti(urls, out, { connections: 6, minChunk: 512 * 1024 });
      const got = fs.readFileSync(out);
      assert(Buffer.compare(got, data) === 0, 'the joined file must match the source exactly');
      assert(r.sources === 2 && r.parallel >= 2, `should use 2 sources at once, got ${JSON.stringify(r)}`);
      assert(got.length === data.length, 'sizes must match');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('multi-source parallel download: a retry after failure fetches only missing chunks (not the whole 1.4 GB)', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 3 * MB;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i += 1) data[i] = i % 251;
    let ranged = 0;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      if (b > a) ranged += 1;          // count only real data chunks (the 0-0 probe doesn't count)
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    };
    // Needs two URLs: with one, downloadMulti hands off to single-source chunking (which has its own resume)
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`];
    const out = path.join(TMP, 'multi-resume.bin');
    try {
      // Set up "first two chunks done, last one missing" (chunking: 3 connections x 1 MB)
      const per = Math.ceil(total / 3);
      const fd = fs.openSync(out, 'w');
      fs.ftruncateSync(fd, total);
      fs.writeSync(fd, data, 0, per * 2, 0);
      fs.closeSync(fd);
      fs.writeFileSync(`${out}.chunks.json`, JSON.stringify({ total, n: 3, done: [0, per] }));

      const r = await downloadMulti(urls, out, { connections: 3, minChunk: MB });
      assert(r.resumed === true, 'should detect this as a resume');
      assert(ranged === 1, `should fetch only 1 chunk, requested ${ranged}`);
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'the resumed file must match the source exactly');
      assert(!fs.existsSync(`${out}.chunks.json`), 'the sidecar file should be removed when done');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('downloader: a connection that sends no bytes must time out and switch sources, not hang', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(4 * 1024 * 1024, 9);
    // Headers arrive, then silence: the classic "TCP connects but is blocked/throttled" state
    const stall = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      // Send 1 KB, then nothing more
      res.write(data.slice(a, a + 1024));
    });
    const good = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(stall);
    const s2 = await listen(good);
    const out = path.join(TMP, 'stall.bin');
    const t0 = Date.now();
    try {
      const r = await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 4, minChunk: 1024 * 1024, idleMs: 400, retries: 2 },
      );
      const cost = Date.now() - t0;
      assert(fs.statSync(out).size === data.length, 'the download must complete');
      assert(cost < 15000, `must not hang on a stalled connection, took ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('downloader: a source crawling at tens of KB/s gets replaced instead of stalling at the last few %', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 2 * MB;
    const data = Buffer.alloc(total, 5);
    // Slow source: 4 KB every 100 ms (about 40 KB/s)
    const slow = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      let pos = a;
      const pump = () => {
        if (pos > b) { res.end(); return; }
        const chunk = data.slice(pos, Math.min(b + 1, pos + 4096));
        pos += chunk.length;
        res.write(chunk);
        setTimeout(pump, 100);
      };
      pump();
    });
    const fast = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(slow);
    const s2 = await listen(fast);
    const out = path.join(TMP, 'slowrot.bin');
    const t0 = Date.now();
    try {
      await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 2, minChunk: 512 * 1024, idleMs: 3000, slowAfterMs: 400, slowBps: 200 * 1024 },
      );
      const cost = Date.now() - t0;
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'content must be correct after switching sources');
      // Staying on the slow source would take 2 MB / 40 KB/s, about 50 s; the switch must finish within seconds
      assert(cost < 15000, `should switch sources when slow, took ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('multi-source parallel download: with only one working URL, fall back to single-source chunking', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(2 * 1024 * 1024, 7);
    const srv = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/f`;
    // Use a port that was just released and surely has no listener as the dead source: connections are refused at once instead of timing out
    const probe = http.createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const out = path.join(TMP, 'multi1.bin');
    try {
      // The second URL points at a dead port on purpose: it must be ignored, not fail the whole download
      const r = await downloadMulti([url, `http://127.0.0.1:${deadPort}/nope`], out, { connections: 4 });
      assert(fs.statSync(out).size === data.length, 'a single source must complete too');
      assert(!r.multi || r.sources === 1, 'with only one usable source it must not be marked multi-source');
    } finally {
      srv.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Sources: release results are cached for 10 minutes; force re-checks', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let calls = 0;
    s.fetchReleases = async () => {
      calls += 1;
      return [{ source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } }];
    };
    await s.latest();
    await s.latest();
    assert(calls === 1, `no repeat request within the cache period, got ${calls}`);
    await s.latest({ force: true });
    assert(calls === 2, 'force must bypass the cache');
    s.reset();
    await s.latest();
    assert(calls === 3, 'after reset it should request again');
  });

  await test('Sources: a 403 rate limit trips the breaker so the source is skipped for a while', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', error: 'api.github.com 403 (rate-limited)' },
    ];
    let err = null;
    try { await s.latest({ force: true }); } catch (e) { err = e; }
    assert(err, 'every source failing with nothing cached should throw');
    const reason = s.blockedReason('github');
    assert(!!reason, 'a 403 must trip the breaker');
    assert(/Skipped for now/.test(reason), `the skip reason should be readable, got: ${reason}`);
    // While blocked, the real fetchReleases returns the reason without touching the network
    const skipped = await withUpdateRepo('o/r', () => Sources.prototype.fetchReleases.call(s));
    assert(skipped.length === 1 && skipped[0].error === reason, JSON.stringify(skipped));
    s.reset();
    assert(s.blockedReason('github') === null, 'reset should clear the breaker');
  });

  await test('Sources: when every source is unreachable, fall back to the last result (marked stale, no error)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.2.3', assets: [] } },
    ];
    const first = await s.latest();
    assert(first.tag === 'v1.2.3' && !first.stale, 'the first call should be normal');
    s._relTtl = 0;   // expire the cache
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', error: 'timed out' },
    ];
    const second = await s.latest();
    assert(second.tag === 'v1.2.3' && second.stale === true, 'should fall back to the old result and mark it stale');
  });

  await test('system image location: a fresh install lands in the runtime dir (CI runtime assembly relies on it)', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'sysroot-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      const root = path.join(tmp, 'rt');
      store.saveSettings({ runtime: { dir: root } });
      const p = new Provisioner(path.join(__dirname, '..'));

      // 1) Fresh install: neither the runtime dir nor the user data dir has system-images -> runtime dir
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'),
        `a fresh install should land in the runtime dir, got ${p.paths().sysImgRoot}`);

      // 2) The runtime dir already has one (unpacked from the full pack) -> prefer it
      fs2.mkdirSync(path.join(root, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'), 'an existing runtime dir copy should win');

      // 3) Only the user data dir has one (old layout) -> use it
      fs2.rmSync(path.join(root, 'system-images'), { recursive: true, force: true });
      fs2.mkdirSync(path.join(store.DATA_DIR, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(store.DATA_DIR, 'system-images'),
        `the old layout should fall back to the user data dir, got ${p.paths().sysImgRoot}`);
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log('\n[resource policy / disk allocation / log limits]');

  await test('one resource policy switch maps to vCPU / priority / resolution', () => {
    const store = require('../src/core/store');
    let s = store.saveSettings({ engine: { resourceMode: 'smooth' } });
    assert(s.engine.liteMode === false, 'smooth mode should not limit cores');
    assert(s.engine.priorityMode === 'game', 'smooth mode should use the low-latency game priority (FPS/video first)');
    assert(s.engine.renderSize === '720x1280', `resolution should be 720p, got ${s.engine.renderSize}`);
    s = store.saveSettings({ engine: { resourceMode: 'save' } });
    assert(s.engine.liteMode === true && s.engine.renderSize === '540x960', 'resource saver should be 540p + lite container');
    s = store.saveSettings({ engine: { resourceMode: 'balanced' } });
    assert(s.engine.renderSize === 'auto', 'balanced mode leaves the resolution to auto');
  });

  await test('data partition size is configurable and the default is no longer a fixed number', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { dataPartitionGB: 12 } });
    const p = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(p.dataMB === 12 * 1024, `should be 12 GB, got ${p.dataMB}MB`);
    store.saveSettings({ engine: { dataPartitionGB: 0 } });
    const auto = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(auto.dataMB === 6144, `with plenty of disk the auto size should be 6 GB, got ${auto.dataMB}`);
  });

  await test('snapshot fingerprint excludes the data partition size (growing it must not invalidate the snapshot, let alone wipe data)', () => {
    const base = { emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' };
    const a = doctor.snapshotKey({ ...base, dataMB: 4096 }, 'img');
    const b = doctor.snapshotKey({ ...base, dataMB: 24576 }, 'img');
    assert(a === b, 'changing only the size must not change the fingerprint');
    const c = doctor.snapshotKey({ ...base, dataMB: 4096, emulatorVersion: '36.0.0' }, 'img');
    assert(a !== c, 'a different engine version should change the fingerprint');
  });

  await test('logs over the limit rotate automatically, keeping one backup', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'rot.log');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === true, 'should rotate');
    assert(!fs.existsSync(f) && fs.existsSync(path.join(TMP, 'rot.1.log')), 'should become .1.log');
  });

  await test('a log file name not ending in .log: better not to rotate than to delete the log', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'plain.txt');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === false, 'must skip rotation when the backup name equals the source');
    assert(fs.existsSync(f), 'the log file must not be deleted');
  });

  await test('launch failure records are saved, so a diagnostic report exported after a restart shows the real cause', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu.lastExitCode = 3221225477;
    emu.lastDiagnosis = doctor.diagnose(['emulator exit 3221225477']);
    emu.attempts = [{ plan: 'host / hardware acceleration', diagnosis: 'ACCESS_VIOLATION', exitCode: 3221225477 }];
    emu._persistFailure({ why: 'test' });
    const back = emu.lastFailure();
    assert(back && back.exitCode === 3221225477, 'the exit code should be saved');
    assert(back.diagnosis && back.diagnosis.code === 'ACCESS_VIOLATION', 'the diagnosis should be saved');
    assert(back.attempts.length === 1, 'the attempts should be saved');
    emu._clearFailure();
    assert(emu.lastFailure() === null, 'a successful launch should clear the failure record');
  });

  await test('.xapk split packages: splits are streamed out, base is parsed, the temp dir is cleaned on failure', async () => {
    const crypto = require('crypto');
    const { parseBundle } = require('../src/core/installer');
    const { buildApkBytes, buildStoredZip } = require('./lib/make-apk');
    const apk = buildApkBytes();

    // Success: two splits in the package (base + config); meta comes from the parsable one
    const okPath = path.join(TMP, 'ok.xapk');
    fs.writeFileSync(okPath, buildStoredZip([
      { name: 'base.apk', data: apk },
      { name: 'split_config.arm64_v8a.apk', data: apk },
      { name: 'manifest.json', data: Buffer.from('{}') },
    ]));
    const b = await parseBundle(okPath);
    try {
      assert(b.files.length === 2, `should extract 2 splits, got ${b.files.length}`);
      assert(b.files.every((f) => fs.existsSync(f)), 'splits should be written to disk');
      assert(b.meta.package === 'com.example.test', `package ${b.meta.package}`);
    } finally {
      b.cleanup();
    }

    // Failure: no APK split in the package -> a clear error, and no temp dir left on the user's machine
    const badPath = path.join(TMP, 'bad.xapk');
    fs.writeFileSync(badPath, buildStoredZip([{ name: 'readme.txt', data: Buffer.from('nope') }]));
    let err = null;
    try { await parseBundle(badPath); } catch (e) { err = e; }
    assert(err && /No APK splits found/.test(err.message), `should report no splits, got ${err && err.message}`);
    const dir = path.join(os.tmpdir(), 'apkstart-bundle',
      crypto.createHash('sha1').update(badPath).digest('hex').slice(0, 12));
    assert(!fs.existsSync(dir), 'the temp dir should be cleaned up on failure');
  });

  await test('materializeImages: expands .img.gz, skips already expanded, reports bad images without leaving partial files', async () => {
    const zlib = require('zlib');
    const store = require('../src/core/store');
    const { Provisioner } = require('../src/core/provision');
    const before = store.getSettings().runtime.dir;
    const rt = path.join(TMP, 'rt-materialize');
    const imgDir = path.join(rt, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, 'kernel-ranchu'), 'kernel');
    // 40 MB of the same byte: gzips to tens of KB but expands past 32 MB, enough to test the "already expanded" check
    fs.writeFileSync(path.join(imgDir, 'system.img.gz'), zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 7)));
    store.saveSettings({ runtime: { dir: rt } });
    const prov = new Provisioner(path.join(__dirname, '..'));
    try {
      const n = await prov.materializeImages();
      assert(n === 1, `should expand 1 image, got ${n}`);
      const img = path.join(imgDir, 'system.img');
      assert(fs.statSync(img).size === 40 * 1024 * 1024, 'expanded size should be correct');
      assert(fs.existsSync(path.join(imgDir, 'kernel-ranchu')), 'uncompressed components should be in place too');
      assert(!fs.existsSync(`${img}.part`), 'success must not leave a .part file');

      const again = await prov.materializeImages();
      assert(again === 0, `should skip when already expanded, expanded ${again}`);

      // Bad image: must throw MATERIALIZE_FAILED and remove the .part (or next time it counts as done)
      fs.rmSync(img, { force: true });
      fs.writeFileSync(path.join(imgDir, 'system.img.gz'), Buffer.from('not a gzip at all'));
      let err = null;
      try { await prov.materializeImages(); } catch (e) { err = e; }
      assert(err && err.code === 'MATERIALIZE_FAILED', `a bad image should fail, got ${err && err.message}`);
      assert(!fs.existsSync(`${img}.part`), 'failure must not leave a .part file');
    } finally {
      store.saveSettings({ runtime: { dir: before } });
    }
  });

  await test('after changing the download source / pack URL the provisioner URL cache must be cleared (no restart needed)', () => {
    const { Provisioner } = require('../src/core/provision');
    const p = new Provisioner(path.join(__dirname, '..'));
    // Simulate the cache after resolving the pack URL / engine URLs once
    p._cache.pack = { url: 'https://old.example/runtime.zip', tag: 'v1' };
    p._cache.emulatorUrl = 'https://old.example/emulator.zip';
    p._cache.sysimgUrl = 'https://old.example/sysimg.zip';
    p.invalidateEnvCache();
    assert(!p._cache.pack, 'the pack URL cache should be cleared');
    assert(!p._cache.emulatorUrl && !p._cache.sysimgUrl, 'the engine/image URL caches should be cleared');
  });

  await test('each launch attempt is diagnosed from its own log lines (a previous crash must not taint the next)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu._log = [
      { t: 1, line: 'Graphics backend: gfxstream' },
      { t: 2, line: 'emulator exit 3221225477' },        // attempt 1: 0xC0000005
      { t: 3, line: '--- attempt 2 ---' },
      { t: 4, line: 'Address already in use' },          // attempt 2: port in use
    ];
    assert(doctor.diagnose(emu._attemptLines(0, 80)).code === 'ACCESS_VIOLATION', 'attempt 1 should be a crash');
    assert(doctor.diagnose(emu._attemptLines(2, 80)).code === 'PORT_BUSY', 'attempt 2 should be port in use');
    // An attempt with no log lines falls back to the overall tail instead of UNKNOWN
    const fallback = emu._attemptLines(emu._log.length, 80);
    assert(fallback.length === emu._log.length, `an empty attempt should fall back to the whole log, got ${fallback.length} lines`);
  });

  await test('launch component: a full component must not get the package name prepended again (or the icon only shows the Android home screen)', () => {
    const { componentArg, parseResolvedActivity } = require('../src/core/adb');
    // Full component (what apps.json stores after a v0.3.4 install) -> used as is
    assert(componentArg('com.phoenix.read', 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity')
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'a full component should be returned as is');
    // Old data: bare class name / class name starting with a dot -> prepend the package
    assert(componentArg('com.a.b', 'MainActivity') === 'com.a.b/MainActivity');
    assert(componentArg('com.a.b', '.MainActivity') === 'com.a.b/.MainActivity');
    assert(componentArg('com.a.b', '') === '', 'an empty activity should return empty (implicit intent)');
    // resolve-activity output often ends with blank / priority lines: the component must still be found
    const out = 'priority=0\ncom.phoenix.read/com.dragon.read.pages.splash.SplashActivity\n\n';
    assert(parseResolvedActivity('com.phoenix.read', out)
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'should skip blank lines and take the last component line');
    assert(parseResolvedActivity('com.other', out) === '', 'another package name must not be used');
  });

  console.log(results.join('\n'));
  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
