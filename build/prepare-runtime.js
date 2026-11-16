'use strict';
/**
 * Turn engine/ into a runtime that can ship inside the package: build/runtime/
 *
 * The key step is compressing system.img. AOSP's system.img is a 3.1GB sparse image,
 * mostly zeros; gzipped it is only ~580MB, and it accounts for almost all of the
 * single-file release size. Plus emulator (~340MB after slimming) + Electron + platform-tools,
 * the package ends up around 1.0-1.1GB; uncompressed it would be over 1.4GB.
 * The cost is 1-2 minutes on first launch to unpack it into the user folder (once only);
 * that happens in materializeImages() in src/core/provision.js.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'engine');
const OUT = path.join(ROOT, 'build', 'runtime');
const MARK = path.join(OUT, '.prepared');
// Prebuilt /data template (formatted ext4, compressed). See the userdata.img comment below.
const SEED_USERDATA = path.join(__dirname, 'seed', 'userdata.img.gz');

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

async function gzipFile(src, dest) {
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(dest),
  );
}

/** Large images use XZ (LZMA2): ~25% smaller than gzip -6 (system.img 1.5GB -> ~1.1GB).
 *  Default is preset 9e (extreme); on 2-core CI, XZ_PRESET=6 takes a third of the time (+3% size).
 *
 *  Implementation notes (lessons learned):
 *   - Uses Python's lzma (single-threaded, stable). @napi-rs/lzma's createCompressStream can hang
 *     with 0 bytes of output in some environments (seen hanging 18 minutes), so it's only a last resort with a timeout.
 *   - [Real cause of a 3-hour CI hang] The source file must be piped into the child's stdin and closed
 *     after reading. The Python side does `shutil.copyfileobj(sys.stdin.buffer, z)`; without EOF it waits
 *     forever, writes nothing to stdout and never exits. Back then only p.stdout was connected; locally an
 *     existing .xz meant compression was skipped, so only a fresh CI folder hit it.
 *   - Plus a watchdog: if the compressor misbehaves it is killed and we fall back to gzip,
 *     so the packaging pipeline can never hang indefinitely.
 *   - No Python / compression failed -> gzip -9 (slightly larger but never hangs);
 *     materializeImages picks the decompressor by extension, so both outputs work.
 */
function findPython() {
  const { spawnSync } = require('child_process');
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const r = spawnSync(cmd, ['-c', 'import lzma;print("ok")'], {
        encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (r.status === 0 && /ok/.test(String(r.stdout))) return cmd;
    } catch (_) { /* try the next one */ }
  }
  return null;
}

async function xzFile(src, dest) {
  const preset = Math.max(0, Math.min(9, Number(process.env.XZ_PRESET || 9)));
  const extreme = preset >= 9 && process.env.XZ_NO_EXTREME !== '1';
  const pyPreset = extreme ? '9|lzma.PRESET_EXTREME' : String(preset);
  const dictSize = preset >= 9 ? (1 << 27) : preset >= 6 ? (1 << 26) : (1 << 23);
  // Default 2 hours (3GB / 2 cores / preset 6 measured ~40min); on timeout kill and fall back to gzip.
  const timeoutMs = Math.max(5000, Number(process.env.XZ_TIMEOUT_MS || 2 * 60 * 60 * 1000));
  const py = findPython();
  if (py) {
    const { spawn } = require('child_process');
    const p = spawn(py, ['-c', [
      'import lzma,sys,shutil',
      `flt=[{"id":lzma.FILTER_LZMA2,"preset":${pyPreset},"dict_size":${dictSize}}]`,
      'z=lzma.LZMAFile(sys.stdout.buffer,mode="wb",format=lzma.FORMAT_XZ,filters=flt)',
      'shutil.copyfileobj(sys.stdin.buffer,z); z.close()',
    ].join(';')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });

    // Attach listeners first so a child that exits before we await doesn't lose its close event.
    const exited = new Promise((resolve) => {
      p.on('close', resolve);
      p.on('error', () => resolve(-1));
    });
    const watchdog = setTimeout(() => {
      console.log(`  (xz compression took over ${Math.round(timeoutMs / 60000)} minutes; stopping and using gzip -9)`);
      try { p.kill(); } catch (_) { /* already exited */ }
    }, timeoutMs);

    let ok = false;
    try {
      // Key point: stdin is the compressor's input. pipeline ends p.stdin after reading src,
      // and Python only flushes the XZ trailer and exits once it sees EOF.
      const streams = [
        pipeline(fs.createReadStream(src), p.stdin),
        pipeline(p.stdout, fs.createWriteStream(dest)),
      ];
      // If either side fails (EPIPE / disk write error), kill the child right away instead of waiting for the watchdog.
      streams.forEach((s) => s.catch(() => { try { p.kill(); } catch (_) { /* noop */ } }));
      const settled = await Promise.allSettled(streams);
      const code = await exited;
      ok = code === 0 && settled.every((r) => r.status === 'fulfilled') && sizeOf(dest) > 0;
    } catch (_) {
      ok = false;
    } finally {
      clearTimeout(watchdog);
    }
    if (ok) return;
    // A partial .xz would pollute the output; delete it before falling back.
    try { fs.rmSync(dest, { force: true }); } catch (_) { /* ignore */ }
    console.log(`  (${py} compression failed; using gzip -9)`);
  } else {
    console.log('  (Python not found; using gzip -9 (slightly larger but reliable))');
  }
  // Fallback: gzip -9 (not xz; materializeImages picks the decompressor by extension)
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(dest.replace(/\.xz$/i, '.gz')),
  );
}

async function main() {
  const force = process.argv.includes('--force');
  if (fs.existsSync(MARK) && !force) {
    console.log('build/runtime is up to date (use --force to rebuild)');
    return;
  }
  if (!fs.existsSync(SRC)) {
    console.error('engine/ folder is missing; cannot prepare the runtime');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  // 1. Copy emulator / platform-tools as-is (no old build output)
  for (const dir of ['emulator', 'platform-tools']) {
    const s = path.join(SRC, dir);
    if (!fs.existsSync(s)) continue;
    console.log(`Copying ${dir}...`);
    fs.cpSync(s, path.join(OUT, dir), { recursive: true });
  }

  // 1.5 Slimming: delete files our fixed launch arguments never load (about -400MB)
  if (!process.argv.includes('--no-slim')) {
    console.log('Slimming runtime...');
    const { slim } = require('./slim-runtime');
    slim(OUT, { aggressive: !process.argv.includes('--safe-slim') });
  }

  // 2. System images: large images compressed to .xz (streamed out by materializeImages at runtime), the rest copied as-is
  const imgRoot = path.join(SRC, 'system-images');
  let compressed = 0;
  if (fs.existsSync(imgRoot)) {
    for (const api of fs.readdirSync(imgRoot)) {
      for (const tag of fs.readdirSync(path.join(imgRoot, api))) {
        for (const abi of fs.readdirSync(path.join(imgRoot, api, tag))) {
          const from = path.join(imgRoot, api, tag, abi);
          const to = path.join(OUT, 'system-images', api, tag, abi);
          fs.mkdirSync(to, { recursive: true });
          for (const f of fs.readdirSync(from)) {
            const src = path.join(from, f);
            if (!fs.statSync(src).isFile()) continue;
            // NOTICE.txt is the GMS license text (~20MB), not needed to run
            if (/^NOTICE\.txt$/i.test(f)) continue;
            // userdata.img uses the prebuilt ext4 template from the repo (seed):
            // the official sys-img copy is 1MB of zeros, so e2fsck always returns code=8 when the emulator
            // grows it, the partition stays at 1MB -> guest "invalid magic" -> /data read-only -> a fresh
            // install never boots. The template is generated once (mke2fs) and committed, so CI needs no extra tools.
            if (/^userdata\.img$/i.test(f) && fs.existsSync(SEED_USERDATA)) {
              fs.copyFileSync(SEED_USERDATA, path.join(to, 'userdata.img.gz'));
              console.log('userdata.img: using the prebuilt ext4 template (build/seed)');
              compressed += 1;
              continue;
            }
            if (/^(system|vendor|cache|userdata)\.img$/i.test(f) && sizeOf(src) > 32 * 1024 * 1024) {
              // Compress large images; the raw image isn't packaged. Skip if a reasonably sized compressed copy exists
              const xz = path.join(to, `${f}.xz`);
              const gz = path.join(to, `${f}.gz`);
              // The gzip fallback produces .gz, so accept that too, or every rebuild recompresses 3GB.
              // The threshold is >1MB rather than a compression ratio: vendor.img.gz is only ~21MB and userdata.img
              // is almost all zeros, so a large fixed threshold or a ratio check would wrongly reject them.
              const existing = [xz, gz].find((p) => sizeOf(p) > 1024 * 1024);
              if (existing) {
                console.log(`Skipping ${f} (already have ${path.extname(existing)} ${(sizeOf(existing) / 1048576).toFixed(1)} MB)`);
                compressed += 1;
                continue;
              }
              console.log(`Compressing ${f} (${(sizeOf(src) / 1073741824).toFixed(2)} GB) -> XZ 9e (slow, one time)...`);
              // eslint-disable-next-line no-await-in-loop
              await xzFile(src, xz);
              compressed += 1;
            } else {
              fs.copyFileSync(src, path.join(to, f));
            }
          }
        }
      }
    }
  }

  fs.writeFileSync(MARK, new Date().toISOString());
  const gzCount = compressed;
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else total += sizeOf(p);
    }
  };
  walk(OUT);
  console.log(`Done: build/runtime (${(total / 1073741824).toFixed(2)} GB, ${gzCount} large images compressed)`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
// Exported for regression tests (doesn't trigger main's full preparation)
module.exports = { xzFile, gzipFile, findPython };
