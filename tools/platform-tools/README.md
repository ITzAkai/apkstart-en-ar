# Portable adb

Unzip Android platform-tools into this folder (so that `adb.exe` is here) and ApkStart will prefer it:

```
tools/platform-tools/
└─ adb.exe
```

Download: https://developer.android.com/tools/releases/platform-tools

If this folder is empty, ApkStart tries, in order:

1. The adb path set manually in Settings
2. This folder
3. `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`
4. The adb bundled with common emulators (LDPlayer / MuMu / BlueStacks)
5. The system PATH
