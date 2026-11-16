'use strict';
/**
 * Install / launch / uninstall orchestration.
 * Chains "parse APK -> install into the runtime -> save local metadata -> create desktop shortcut" into one pipeline.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { parseApk } = require('./apk');
const { ZipFile } = require('./zip');
const { iconToIco, writeShortcut, removeShortcut, safeFileName } = require('./shortcut');
const { t } = require('../i18n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The APK only has ARM native libraries (very common) */
function isArmOnly(meta) {
  return !!(meta && meta.abis && meta.abis.length && !meta.abis.some((a) => /x86/i.test(a)));
}

/**
 * Split packages (.apks / .xapk): extract the APK splits into a pure-ASCII temp folder.
 * Uses the file-based ZIP reader + streaming writes: split packages are often 2 GB+ and
 * reading them into memory fails.
 * Returns { meta, files, cleanup }; meta comes from the base APK that has the AndroidManifest.
 */
async function parseBundle(filePath) {
  const zip = new ZipFile(filePath);
  const dir = path.join(os.tmpdir(), 'apkstart-bundle', crypto.createHash('sha1')
    .update(filePath).digest('hex').slice(0, 12));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
  try {
    const apkNames = zip.names().filter((n) => /\.apk$/i.test(n));
    if (!apkNames.length) throw new Error(t('No APK splits found in this package (it may not be an .apks/.xapk file)'));
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < apkNames.length; i++) {
      const target = path.join(dir, `split-${i}.apk`);
      // A single split can be hundreds of MB: stream it, no Buffer
      // eslint-disable-next-line no-await-in-loop
      await zip.pipeTo(apkNames[i], fs.createWriteStream(target));
      files.push(target);
    }
    let meta = null;
    for (const f of files) {
      try { meta = parseApk(f); break; } catch (_) { /* this split has no manifest */ }
    }
    if (!meta) throw new Error(t('Could not parse the base APK of the split package'));
    return { meta, files, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    zip.close();
  }
}

function accentOf(pkg) {
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 52%)`;
}

class Installer {
  constructor(runtime, ctx) {
    this.runtime = runtime;
    this.ctx = ctx; // { launcherTarget, launcherArgs, cwd, isDev, desktopDir }
  }

  shortcutTarget() {
    const { launcherTarget, launcherArgs } = this.ctx;
    return { target: launcherTarget, baseArgs: launcherArgs || '' };
  }

  iconFile(pkg) { return store.iconPath(pkg); }

  icoFile(pkg) { return path.join(store.ICON_DIR, `${pkg}.ico`); }

  shortcutPath(app) {
    const s = store.getSettings();
    const dir = s.shortcutDir && s.shortcutDir.trim() ? s.shortcutDir : this.ctx.desktopDir;
    return path.join(dir, `${safeFileName(app.label)}.lnk`);
  }

  /**
   * One on the desktop, one in the Start menu.
   * Windows Search indexes .lnk files under "Start Menu \ Programs", so a desktop-only shortcut
   * can't be found by search; on machines whose desktop is redirected by OneDrive the Start
   * menu copy also keeps the entry point.
   */
  shortcutPaths(app) {
    const out = [this.shortcutPath(app)];
    if (this.ctx.startMenuDir && store.getSettings().createStartMenuShortcut !== false) {
      // Dedicated subfolder: still indexed by Windows Search, and never overwrites a third-party
      // shortcut with the same name (seen in practice: another desktop helper had taken an app's name)
      out.push(path.join(this.ctx.startMenuDir, 'ApkStart', `${safeFileName(app.label)}.lnk`));
    }
    return [...new Set(out)];
  }

  /** The compatibility image is downloaded on demand for the first ARM app, once, as a shared read-only base layer */
  async ensureCompatImage(onProgress) {
    const prov = this.runtime.provisioner;
    if (prov.playImageInfo().ok) return true;
    onProgress({ stage: 'runtime', message: t('First ARM app: downloading the compatibility image (about 1.5 GB, one time only)…') });
    await prov.installPlayImage((p) => onProgress({ stage: 'runtime', message: p.message, percent: p.percent }));
    if (!prov.playImageInfo().ok) throw new Error(t('Compatibility image download failed. Check your network and try again.'));
    return true;
  }

  /** Switching images requires a runtime restart; afterwards installed apps are reinstalled from the local APK backups */
  async switchToCompat(onProgress) {
    const apps = store.getApps();
    store.saveSettings({ runtime: { compatImage: true } });
    onProgress({ stage: 'runtime', message: t('Switching to the compatibility image and restarting the runtime…') });
    try { await this.runtime.stop(); } catch (_) { /* ignore */ }
    // Wait for the old device to leave the adb list so ensure() doesn't reuse it
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ds = await this.runtime.client().devices().catch(() => []);
      if (!ds.some((d) => /^emulator-\d+$/.test(d.serial))) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
    if (!rt.ok) {
      const err = new Error(rt.error || t('Runtime unavailable after switching to the compatibility image'));
      err.needsSetup = rt.needsSetup || 'provision';
      throw err;
    }
    for (const app of apps) {
      if (!app.apkPath || !fs.existsSync(app.apkPath)) continue;
      try {
        if (app.bundle) {
          // eslint-disable-next-line no-await-in-loop
          const b = await parseBundle(app.apkPath);
          // eslint-disable-next-line no-await-in-loop
          await rt.client.installMultiple(b.files);
          b.cleanup();
        } else {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.install(app.apkPath);
        }
        onProgress({ stage: 'runtime', message: t('Restoring installed app {name}…', { name: app.label }) });
      } catch (_) { /* one app failing to restore doesn't block the rest */ }
    }
    return rt;
  }

  async install(filePath, onProgress = () => {}) {
    onProgress({ stage: 'parse', message: t('Parsing APK…') });
    let meta;
    let bundle = null;
    if (/\.(apks|xapk)$/i.test(filePath)) {
      bundle = await parseBundle(filePath);
      meta = bundle.meta;
    } else {
      meta = parseApk(filePath);
    }
    onProgress({
      stage: 'parse-done',
      message: t('Found {label} ({package})', { label: meta.label, package: meta.package }),
      meta: { label: meta.label, package: meta.package, versionName: meta.versionName },
    });

    try {
      // Zero config: ARM-only apps automatically get the image with the ARM translation layer, no switch needed
      if (isArmOnly(meta) && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const switched = await this.switchToCompat(onProgress);
        return this.finishInstall(switched, meta, filePath, bundle, onProgress);
      }

      onProgress({ stage: 'runtime', message: t('Preparing the Android runtime…') });
      const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
      if (!rt.ok) {
        const err = new Error(rt.error || t('Runtime unavailable'));
        err.needsSetup = rt.needsSetup || 'provision';
        throw err;
      }
      return await this.finishInstall(rt, meta, filePath, bundle, onProgress);
    } finally {
      if (bundle) bundle.cleanup();
    }
  }

  /** Install the app + save metadata + shortcut; one automatic repair retry on failure */
  async finishInstall(rt, meta, filePath, bundle, onProgress) {
    const client = rt.client;
    const existing = store.getApp(meta.package);
    // After installing, the disk state in the old quickboot snapshot is stale; keeping it makes
    // "the installed app disappear after a restart"
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
    onProgress({ stage: 'install', message: existing ? t('Updating app…') : t('Installing app…') });
    try {
      if (bundle) await client.installMultiple(bundle.files);
      else await client.install(filePath);
    } catch (e) {
      // Still an ABI mismatch here: the runtime is on the AOSP image, switch to the compatibility image and install again
      if (e.code === 'NO_MATCHING_ABIS' && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const rt2 = await this.switchToCompat(onProgress);
        onProgress({ stage: 'install', message: t('Switched to the compatibility image, reinstalling…') });
        if (bundle) await rt2.client.installMultiple(bundle.files);
        else await rt2.client.install(filePath);
      } else {
        throw e;
      }
    }
    this.runtime.touch();

    // Save the icon. Many APK icons are WebP, which nativeImage can't decode, so the renderer
    // decodes them with a branded placeholder as fallback; the .lnk always gets an icon
    // (icoPath used to stay null). iconFallback records "real icon couldn't be decoded,
    // placeholder used" - surfaced as a soft warning, otherwise the user sees a generic icon
    // on the desktop and thinks ApkStart got it wrong.
    let iconPath = null;
    let icoPath = null;
    let iconFallback = '';
    if (meta.iconPng) {
      try {
        iconPath = store.iconPath(meta.package);
        fs.writeFileSync(iconPath, meta.iconPng);
      } catch (_) { /* ignore */ }
      try {
        const ico = await iconToIco(meta.iconPng, {
          decode: this.ctx.decodeIcon,
          onFallback: (why) => { iconFallback = why; },
        });
        if (ico) {
          icoPath = this.icoFile(meta.package);
          fs.writeFileSync(icoPath, ico);
        }
      } catch (_) { /* icon failure doesn't affect the install */ }
    }

    // Back up the APK for later reinstall / recovery
    let apkCopy = null;
    try {
      apkCopy = store.apkPath(meta.package, meta.versionCode.toString(36));
      fs.copyFileSync(filePath, apkCopy);
    } catch (_) { /* ignore */ }

    // The system-resolved entry wins: the "main Activity" parsed from the APK is often not the
    // real LAUNCHER entry, and launching it skips the app's init screen and crashes.
    let launchActivity = meta.launchActivity;
    try {
      client.clearLauncherCache?.(meta.package);
      const resolved = await client.resolveLauncher(meta.package);
      if (resolved) launchActivity = resolved;
    } catch (_) { /* keep the APK-parsed result */ }

    const app = {
      package: meta.package,
      label: meta.label,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      activity: launchActivity,
      abis: meta.abis,
      minSdk: meta.minSdk,
      sizeBytes: meta.sizeBytes,
      iconPath,
      icoPath,
      apkPath: apkCopy,
      bundle: !!bundle,
      accent: existing ? existing.accent : accentOf(meta.package),
      installedAt: existing ? existing.installedAt : Date.now(),
      updatedAt: Date.now(),
      launchCount: existing ? existing.launchCount || 0 : 0,
      lastLaunchAt: existing ? existing.lastLaunchAt || 0 : 0,
      shortcutPath: existing ? existing.shortcutPath || null : null,
      bounds: existing ? existing.bounds || null : null,
      pinned: existing ? !!existing.pinned : false,
    };

    store.upsertApp(app);

    const settings = store.getSettings();
    if (settings.createShortcutOnInstall) {
      onProgress({ stage: 'shortcut', message: t('Creating desktop shortcut…') });
      try {
        app.shortcutPath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: app.shortcutPath });
      } catch (e) {
        onProgress({ stage: 'shortcut-warn', message: t('Could not create shortcut: {error}', { error: e.message }) });
      }
    }

    // Compatibility warnings
    const warnings = [];
    if (meta.minSdk && meta.minSdk > 34) {
      warnings.push(t('This app requires Android API level {sdk}+, newer than the current runtime, and may not work properly.', { sdk: meta.minSdk }));
    }
    if (iconFallback === 'placeholder') {
      warnings.push(t('The app icon could not be read (possibly an unusual adaptive icon format), so the shortcut uses a placeholder icon for now.'));
    } else if (iconFallback === 'webp-decode-failed') {
      warnings.push(t('The app icon (WebP) could not be decoded, so the shortcut uses a placeholder icon for now.'));
    }
    client.batteryOptimizeOff(meta.package).catch(() => {});
    // Installing invalidated the old snapshot; schedule a new one so the "new app installed"
    // state is saved when idle, otherwise the next boot is a 20+ second cold boot.
    try { this.runtime.scheduleSnapshotSave?.(12000); } catch (_) { /* ignore */ }

    onProgress({ stage: 'done', message: t('{label} installed', { label: app.label }), app });
    return { app, warnings, engine: rt.engine };
  }

  createShortcut(app) {
    const { target, baseArgs } = this.shortcutTarget();
    const args = `${baseArgs ? baseArgs + ' ' : ''}--launch "${app.package}"`.trim();
    const ico = app.icoPath && fs.existsSync(app.icoPath) ? app.icoPath : undefined;
    const paths = this.shortcutPaths(app);

    const write = (shortcutPath) => writeShortcut({
      shortcutPath,
      target,
      args,
      iconIcoPath: ico,
      description: t('{label} — runs with ApkStart', { label: app.label }),
      cwd: this.ctx.cwd,
      // One AUMID per app: the taskbar groups by app instead of piling everything under ApkStart
      appUserModelId: `RoutineMiku.ApkStart.${app.package}`.slice(0, 128),
    });

    let first = null;
    let startMenuPath = null;
    const errors = [];
    paths.forEach((p, i) => {
      try {
        write(p);
        if (!first) first = p;
        if (i === 1) startMenuPath = p;
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
      }
    });

    // All primary paths failed (custom shortcut folder not writable / blocked by security software):
    // try the desktop once more - users can only find the app if there is an icon.
    if (!first) {
      const fallback = path.join(this.ctx.desktopDir, `${safeFileName(app.label)}.lnk`);
      try {
        write(fallback);
        first = fallback;
      } catch (e) {
        errors.push(`${fallback}: ${e.message}`);
      }
    }
    if (!first) throw new Error(errors.join('; ') || t('Failed to create shortcut'));
    // Save the Start menu path too so uninstall removes both
    if (startMenuPath || first) {
      store.upsertApp({ package: app.package, startMenuPath });
    }
    return first;
  }

  /** Fill in missing shortcuts and icons: old versions only created the desktop one, and WebP icons failed to convert back then */
  async ensureShortcuts() {
    const made = [];
    // If the user turned off "create on install" and the app has no shortcut at all, don't add one,
    // otherwise the switch can't stop shortcuts being recreated at startup.
    const auto = store.getSettings().createShortcutOnInstall !== false;
    for (const app of store.getApps()) {
      if (!auto && !app.shortcutPath && !app.startMenuPath) continue;
      let dirty = false;
      if ((!app.icoPath || !fs.existsSync(app.icoPath)) && app.iconPath && fs.existsSync(app.iconPath)) {
        try {
          const ico = await iconToIco(fs.readFileSync(app.iconPath), { decode: this.ctx.decodeIcon });
          if (ico) {
            const p = this.icoFile(app.package);
            fs.writeFileSync(p, ico);
            store.upsertApp({ package: app.package, icoPath: p });
            app.icoPath = p;
            dirty = true;
          }
        } catch (_) { /* icon repair failure doesn't affect the shortcut */ }
      }
      const missing = this.shortcutPaths(app).filter((p) => !fs.existsSync(p));
      if (!missing.length && !dirty) continue;
      try {
        // When the icon was just repaired, rebuild the .lnk even if it exists so it gets the real app icon
        const madePath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: madePath });
        made.push(app.label);
      } catch (_) { /* one failure doesn't block startup */ }
    }
    return made;
  }

  async uninstall(pkg, { removeShortcut: rm = true } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure();
    if (rt.ok) await rt.client.uninstall(pkg).catch(() => {});
    if (app && rm) {
      removeShortcut(app.shortcutPath);
      removeShortcut(app.startMenuPath);
    }
    if (app) {
      try { if (app.iconPath && fs.existsSync(app.iconPath)) fs.unlinkSync(app.iconPath); } catch (_) {}
      try { if (app.icoPath && fs.existsSync(app.icoPath)) fs.unlinkSync(app.icoPath); } catch (_) {}
      try { if (app.apkPath && fs.existsSync(app.apkPath)) fs.unlinkSync(app.apkPath); } catch (_) {}
    }
    store.removeApp(pkg);
    return true;
  }

  async launch(pkg, { onLog = () => {}, beforeStart = null, onMark = () => {} } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure({ onLog });
    onMark('ensure done');
    if (!rt.ok) {
      const err = new Error(rt.error || t('Runtime unavailable'));
      err.needsSetup = rt.needsSetup;
      throw err;
    }
    // Change the resolution before launching, so a wm size config change doesn't recreate the fresh Activity
    if (beforeStart) await beforeStart(rt).catch((e) => onLog(t('Skipped display adjustment: {error}', { error: e.message })));
    // Clear wm size / density overrides and auto-rotate settings that old versions may have
    // left in /data. They persist, and without clearing them every launch shows a picture
    // rotated 90 degrees with black borders and taps that don't line up.
    await rt.client.resetDisplayOverrides(!!(store.getSettings().display || {}).landscape).catch(() => {});
    // Check the network before launching: say clearly when there is none, otherwise the user
    // just sees "this app is a black screen" and never suspects the VM has no network (online
    // pages without data render as a black area). Wi-Fi often associates tens of seconds after
    // sys.boot_completed, and apps that fetch their home page immediately render black without
    // it. So wait for the network first - but **only wait, never restart**.
    // This used to call ensureNetwork(), which on a slow network would "stop the VM -> cold
    // boot", making the adb device vanish mid-install so the app never opened. The launch path
    // must never do anything that destructive; if the network isn't ready, launch anyway.
    if (rt.engine === 'emulator' || rt.engine === 'builtin') {
      const net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 20000 }).catch(() => null);
      if (net && net.ok) {
        onLog(t('VM network ready ({ip})', { ip: net.ip || '' }));
      } else {
        onLog(t('VM network is not ready yet; starting the app anyway (online pages may load a bit later)'));
      }
    }
    const settings = store.getSettings();
    const start = () => rt.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
      freeform: settings.freeform,
      bounds: app ? app.bounds : null,
    });
    // The app may not be installed in the current runtime yet (image rebuilt / data cleared /
    // first time), and launching would fail with "Invalid packageName". Install it from the
    // local cache first so "open app" always works without a manual reinstall.
    if (app && app.apkPath && fs.existsSync(app.apkPath)) {
      const pkgs = await rt.client.shell(`pm list packages ${pkg}`, { timeout: 8000 }).catch(() => '');
      if (!new RegExp(`package:${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(pkgs)) {
        onLog(t('App is not installed yet, installing automatically…'));
        await rt.client.install(app.apkPath).catch((e) => onLog(t('Automatic install failed: {error}', { error: e.message })));
      }
    }
    // Watch for 25 s and require the process to stay alive for a few seconds in a row.
    // "Not up yet" and "was up, then gone" must be told apart. The old code failed as soon as
    // pidof was empty, so large apps with a slow first start were force-stopped mid-load and
    // restarted three times ("I click and wait a minute").
    const staysAlive = async () => {
      const t0 = Date.now();
      let aliveSince = 0;
      let seen = false;
      while (Date.now() - t0 < 25000) {
        // Check before sleeping: in a resident container a warm start often shows the process
        // within a second, and sleeping first would slow the fastest path by a second.
        // eslint-disable-next-line no-await-in-loop
        const pid = await rt.client.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
        if (!String(pid).trim()) {
          if (seen) return false; // was up, then vanished = really crashed
        } else {
          seen = true;
          if (!aliveSince) aliveSince = Date.now();
          if (Date.now() - aliveSince >= 4000) return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
      }
      return seen; // only a process never seen counts as failure
    };
    try {
      // Make sure runtime permissions are granted first: -g from install may be lost after a
      // data clear, and a missing permission leaves the app behind a system prompt ("nothing happens").
      await rt.client.grantRuntimePermissions(pkg).catch(() => {});
      onMark('permissions granted');
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        if (attempt > 1) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.forceStop(pkg).catch(() => {});
          // A permission dialog on top makes the app look like it won't open; grant, then dismiss it
          // eslint-disable-next-line no-await-in-loop
          await rt.client.grantRuntimePermissions(pkg).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await rt.client.dismissPermissionDialog().catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await sleep(600 * attempt);
        }
        let started = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await start();
        } catch (e) {
          // Only a clear crash log goes to the outer handler (may switch images); without evidence it's probably just slow, retry
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
          started = false;
        }
        onMark(`am start #${attempt} ${started ? 'ok' : 'fail'}`);
        // Lock the orientation right after the Activity starts. App startup itself triggers config
        // changes (Activity recreation), which can reset the user-rotation set before launch back
        // to 0 - and at 0 the picture on a landscape panel lies on its side.
        if (started) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.setOrientation(!!(store.getSettings().display || {}).landscape).catch(() => {});
        }
        // eslint-disable-next-line no-await-in-loop
        ok = started ? await staysAlive() : false;
        onMark(`alive #${attempt} ${ok}`);
        if (!ok && attempt < 3) onLog(t('The app exited after launch (attempt {n}), retrying automatically…', { n: attempt }));
      }
      if (!ok) {
        // Last resort: an abnormal exit can leave half-initialized data that crashes every time.
        // Clearing the app data once and relaunching has the best success rate (the user doesn't
        // have to clear the cache in settings).
        onLog(t('The app keeps exiting; resetting its data and retrying…'));
        await rt.client.shell(`pm clear ${pkg}`, { timeout: 20000 }).catch(() => '');
        await sleep(800);
        // pm clear also removes runtime permissions; grant again or it gets stuck on the system prompt
        await rt.client.grantRuntimePermissions(pkg).catch(() => {});
        await start().catch((e) => {
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
        });
        ok = await staysAlive();
        if (!ok) await rt.client.dismissPermissionDialog().catch(() => {});
      }
      if (!ok) {
        const err = new Error(t('The app exits right after launch. Automatic retries and an app data reset did not help.'));
        err.code = 'APP_UNSTABLE';
        throw err;
      }
    } catch (e) {
      if (e.code === 'APP_CRASHED' && !this.runtime.provisioner.playImageInfo().ok) {
        // Crash came from the ARM translation layer: switch images, reinstall the backup APK, launch again
        onLog(t('ARM translation layer crash detected, switching to the compatibility image…'));
        await this.ensureCompatImage(onLog ? (m) => onLog(m.message || '') : () => {});
        const rt2 = await this.switchToCompat((m) => onLog(m.message || ''));
        if (app && app.apkPath && fs.existsSync(app.apkPath)) {
          try { await rt2.client.install(app.apkPath); } catch (_) { /* keep the original package */ }
        }
        await rt2.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
          freeform: settings.freeform,
          bounds: app ? app.bounds : null,
        });
      } else {
        throw e;
      }
    }
    this.runtime.touch();
    if (app) {
      store.upsertApp({
        package: app.package,
        launchCount: (app.launchCount || 0) + 1,
        lastLaunchAt: Date.now(),
      });
    }
    return { ok: true, engine: rt.engine };
  }
}

module.exports = { Installer, accentOf, parseBundle };
