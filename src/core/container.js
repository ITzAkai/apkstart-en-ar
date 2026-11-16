'use strict';
/**
 * App-level container (pure computation).
 *
 * ApkStart runs a full QEMU system VM, so unlike WSA it cannot "load only the system
 * services one app needs": the Linux kernel, zygote and system_server all come up together.
 * What users actually feel as "heavy" is not those resident services but:
 *   1. a full Android boot every time an app opens (40-142 s cold start, CPU/disk maxed);
 *   2. previously opened apps staying in the background eating memory, network and wakelocks;
 *   3. qemu competing with the desktop at Normal priority when no app is in front;
 *   4. file sync and notification polling running even when no app is open.
 *
 * This module turns the parts we can really trim into composable, testable commands:
 *   - boot the environment once; afterwards "open app" = am start + attach window (Runtime.beginApp);
 *   - when a new app opens, stop other user apps' processes and keep only what this one needs;
 *   - when the last app closes, idle Android, kill background processes, lower qemu priority;
 *   - system packages are left alone by default (stopping GMS makes apps that rely on push or
 *     sign-in keep erroring); only when the user enables "deep trim" is a small set of clearly
 *     useless background packages disabled.
 *
 * No adb / Electron dependency: pure functions, easy to regression-test.
 */

/** Never trim these: touching them causes a black screen or app crashes */
const NEVER_TRIM = [
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.inputmethod.latin',
  'com.google.android.inputmethod.latin',
  'com.android.webview',
  'com.google.android.webview',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.android.providers.settings',
  'com.android.server.telecom',
];

/** Disabled only by "deep trim": these only do background updates / wallpaper / printing */
const OPTIONAL_SYSTEM = [
  'com.android.vending',                    // Play Store (background update scans)
  'com.google.android.setupwizard',         // first-run setup wizard
  'com.android.printspooler',               // print service
  'com.android.wallpapercropper',
  'com.android.dreams.basic',               // screensaver
  'com.android.providers.calendar',
  'com.android.providers.contacts',
  'com.android.managedprovisioning',
  'com.android.statementservice',
  'com.android.backupconfirm',
];

/** Obvious system/framework packages: skipped by session trimming to avoid collateral kills */
const SYSTEM_PREFIXES = [
  'android', 'com.android.', 'com.google.android.',
  'com.qualcomm.', 'com.qti.', 'vendor.', 'com.mediatek.',
];

/** Only valid Android package names may go into shell commands (guards against a tampered list) */
const SAFE_PKG = /^[A-Za-z][A-Za-z0-9_.]+$/;

function isSystemPackage(pkg) {
  const p = String(pkg || '').trim();
  if (!p) return true;
  if (!SAFE_PKG.test(p)) return true;
  return SYSTEM_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

/**
 * Trim commands to run when an app starts.
 * @param {object} o
 * @param {string} o.pkg            package being opened
 * @param {string[]} o.installed    user app packages installed here (the store's list)
 * @param {boolean} o.deep          deep trim (disable system background packages), default false
 * @param {boolean} o.killBackground also kill cached background processes, default false
 *   (doing it at launch can hit the app that just came to the front; endApp's idle commands handle cleanup)
 * @returns {{commands:string[], stopped:string[], disabled:string[], kept:string[]}}
 */
function buildSessionCommands({
  pkg, installed = [], deep = false, killBackground = false,
} = {}) {
  const target = SAFE_PKG.test(String(pkg || '').trim()) ? String(pkg).trim() : '';
  const commands = [];
  const stopped = [];
  const disabled = [];
  const kept = [];

  for (const raw of installed) {
    const p = String(raw || '').trim();
    if (!p || p === target || isSystemPackage(p) || NEVER_TRIM.includes(p)) {
      if (p) kept.push(p);
      continue;
    }
    stopped.push(p);
    commands.push(`am force-stop ${p}`);
  }

  // Kill cached background processes (not foreground, not persistent services) so that
  // "keep only the current app" actually gives memory back, not just force-stops packages.
  if (killBackground) commands.push('am kill-all 2>/dev/null || true');

  if (deep) {
    for (const p of OPTIONAL_SYSTEM) {
      if (NEVER_TRIM.includes(p)) continue;
      disabled.push(p);
      commands.push(`pm disable-user --user 0 ${p} 2>/dev/null || true`);
    }
    // Restrict background data so store/sync don't keep waking up in the background
    commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  }

  return { commands, stopped, disabled, kept };
}

/**
 * After the last app closes, leave the container "idle without eating resources".
 * No shutdown, no AVD teardown: the next open is still instant, Windows just gets CPU/memory back.
 */
function buildIdleCommands({ deep = false } = {}) {
  const commands = [
    'am kill-all 2>/dev/null || true',
    'dumpsys deviceidle force-idle 2>/dev/null || true',
  ];
  if (deep) commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  return commands;
}

/** Undo deep trim (called when the user turns the switch off, so it is always reversible) */
function buildRestoreCommands() {
  return [
    ...OPTIONAL_SYSTEM.map((p) => `pm enable ${p} 2>/dev/null || true`),
    'settings put global restricted_background_data 0 2>/dev/null || true',
  ];
}

/**
 * Session state machine: what state the container is in after a launch/close.
 * Pure function, to test edge cases like switching windows and closing the last one.
 */
function nextSessionState(active, event, pkg) {
  const set = new Set(active || []);
  if (event === 'open') set.add(pkg);
  else if (event === 'close') set.delete(pkg);
  return {
    active: [...set],
    hasApp: set.size > 0,
    foreground: event === 'open' ? pkg : (set.size ? [...set][set.size - 1] : null),
    idle: set.size === 0,
  };
}

/** One-line summary for logs / diagnostics */
function describeSession(state, plan) {
  const n = state.active.length;
  if (!n) return 'Container idle (Android resident at lowered priority, 0 app processes)';
  return `Container active: ${n} app window(s)${plan && plan.stopped && plan.stopped.length
    ? `, stopped ${plan.stopped.length} background app(s)` : ''}`;
}

module.exports = {
  NEVER_TRIM, OPTIONAL_SYSTEM, SYSTEM_PREFIXES,
  isSystemPackage, buildSessionCommands, buildIdleCommands,
  buildRestoreCommands, nextSessionState, describeSession,
};
