'use strict';
/**
 * Lightweight log writing + rotation.
 *
 * app.log / emulator.log used to be append-only and grew forever: each emulator boot writes
 * tens of KB of kernel log; a dozen boots a day plus qemu's verbose output adds up to hundreds
 * of MB within months, quietly eating the disk. This rotates by size and keeps a single .1.log
 * backup; the limit comes from the "log size limit" setting.
 */
const fs = require('fs');
const path = require('path');

const counters = new Map();

function rotate(file, limitKB) {
  try {
    const st = fs.statSync(file);
    if (st.size < limitKB * 1024) return false;
    const bak = file.replace(/\.log$/i, '.1.log');
    // If the name doesn't end in .log, bak equals the file itself and delete-then-rename would
    // lose the log. Skip that case: a bigger log is better than a lost one.
    if (path.resolve(bak) === path.resolve(file)) return false;
    try { fs.rmSync(bak, { force: true }); } catch (_) { /* ignore */ }
    fs.renameSync(file, bak);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} file target log
 * @param {string} line one line (newline added automatically)
 * @param {number} [limitKB] rotate once the file exceeds this size
 */
function append(file, line, limitKB = 2048) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const n = (counters.get(file) || 0) + 1;
    counters.set(file, n);
    // Check once per process start, then every 200 lines (statSync is cheap, but not needed per line)
    if (n === 1 || n % 200 === 0) rotate(file, Math.max(256, Number(limitKB) || 2048));
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

/** Startup cleanup: rotate oversized logs right away (ignores the counter) */
function trimNow(file, limitKB = 2048) {
  return rotate(file, Math.max(256, Number(limitKB) || 2048));
}

module.exports = { append, rotate, trimNow };
