# ApkStart

Based on [ApkStart](https://github.com/RoutineMiku/apkstart) by RoutineMiku (MIT) — English/Arabic edition.

ApkStart runs Android apps on Windows as if they were regular desktop programs. Double-click an `.apk` to install it; each app gets its own desktop and Start menu shortcut and opens in its own window. Under the hood it uses the official Android Emulator with an Android 14 (Google Play, x86_64) system image, managed entirely in the background.

## Requirements

- Windows 10 or 11, 64-bit (x64)
- Virtualization enabled in the BIOS/UEFI. For hardware acceleration, turn on the Windows feature "Virtual Machine Platform" (WHPX) or use the AEHD driver. Without it, ApkStart falls back to software emulation, which is much slower.

## Run from source

Requires Node.js 20 or later.

```powershell
npm install
npm start
```

On first start, the Runtime page walks you through downloading adb, the emulator and the system image.

## Build a portable zip

```powershell
npm run pack
node build/zip.js dist/ApkStart-win64-portable ApkStart-win64-portable.zip
```

`npm run pack` produces `dist/ApkStart-win64-portable/ApkStart.exe` (no installer needed); `build/zip.js` compresses it with 7-Zip.

## What's different from the original

- English and Arabic UI, with full right-to-left layout in Arabic. The language follows Windows by default and can be changed in Settings.
- No automatic updates unless `updateRepo` is set in `package.json`; it ships empty, so update checks are off. When it is set, downloaded updates are verified against a SHA-256 checksum before they are applied.
- No third-party download mirrors and no Gitee: everything is downloaded from the official sources listed below.
- Start with Windows is off by default.

## Where it downloads from

- `dl.google.com`: adb (platform-tools), the Android Emulator, Android system images, and the AEHD driver
- SourceForge (android-x86 project): Android-x86 images
- `qemu.weilnetz.de`: QEMU for Windows

## Tests

```powershell
npm test
```

## License

[MIT](LICENSE). The original copyright notice is kept as required. Release packages contain only ApkStart's own code and the Electron runtime; Android system images, QEMU and Google components are downloaded on the user's machine from their official sources and are covered by their own licenses.

---

## نبذة بالعربية

ApkStart يشغّل تطبيقات أندرويد على ويندوز كأنها برامج سطح مكتب عادية: انقر نقرًا مزدوجًا على ملف `.apk` لتثبيته، فيحصل كل تطبيق على اختصار في سطح المكتب وقائمة ابدأ ويفتح في نافذته الخاصة. يعتمد على المحاكي الرسمي من أندرويد مع صورة نظام أندرويد 14.

هذه النسخة الإنجليزية/العربية مبنية على [ApkStart](https://github.com/RoutineMiku/apkstart) من RoutineMiku (رخصة MIT).

**المتطلبات:** ويندوز 10 أو 11 بنظام 64 بت (x64)، مع تفعيل المحاكاة الافتراضية (Virtualization) في BIOS/UEFI وميزة "Virtual Machine Platform" في ويندوز للتسريع.

**التشغيل من المصدر:** `npm install` ثم `npm start`.

**بناء نسخة محمولة:** `npm run pack` ثم ضغطها بالأمر `node build/zip.js dist/ApkStart-win64-portable ApkStart-win64-portable.zip`.

**ما الذي تغيّر عن النسخة الأصلية:**

- واجهة بالإنجليزية والعربية مع دعم كامل للكتابة من اليمين إلى اليسار.
- لا تحديث تلقائي إلا إذا ضُبط الحقل `updateRepo` في `package.json`، ويُتحقق من التحديثات المنزّلة ببصمة SHA-256.
- لا مرايا تنزيل خارجية ولا Gitee.
- التشغيل مع بدء ويندوز معطّل افتراضيًا.

**مصادر التنزيل:** `dl.google.com` (أدوات ADB والمحاكي وصور النظام)، وSourceForge (مشروع android-x86)، و`qemu.weilnetz.de` (QEMU لويندوز).
