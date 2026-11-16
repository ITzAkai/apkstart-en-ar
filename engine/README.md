# Runtime engine folder (manual placement, optional)

**Since 0.2, ApkStart is fully self-contained by default**: adb, QEMU and the system image are
downloaded and set up automatically in `%APPDATA%\apkstart\runtime\`. You don't need to prepare anything.

This folder is only for these two cases:

## 1. Placing QEMU manually (download source unreachable / you want a specific version)

```
engine/qemu/
├─ qemu-system-x86_64.exe
├─ qemu-img.exe
└─ ... (the rest of the QEMU files)
```

Official QEMU Windows builds: https://qemu.weilnetz.de/w64/
(`qemu-w64-setup-*.exe` is an NSIS installer; ApkStart installs it silently into the runtime folder
with `/S /D=`. You can also unpack the installer with 7-Zip and put the files in the location above.)

## 2. Placing adb manually

```
tools/platform-tools/
└─ adb.exe
```

Download: https://developer.android.com/tools/releases/platform-tools

## System image

- Recommended: Android-x86 9.0-r2 (x86_64), downloadable from inside the app (multiple mirrors, resumable)
- Or import any disk image with Android already installed (qcow2 / raw / vmdk) via Runtime -> Import
- After import, ApkStart boots straight from the disk; no install step needed

## Hardware acceleration

QEMU uses WHPX acceleration: Control Panel -> "Turn Windows features on or off" -> check
"Virtual Machine Platform" -> restart.
Without it, ApkStart falls back to pure software emulation (TCG), and the first boot is slower.
