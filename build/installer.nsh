; ApkStart custom NSIS script
; Before uninstalling, kill runtime processes that may still be running in the background;
; otherwise they lock files in the install folder and the uninstall leaves files behind.
;
; ApkStart can leave a detached qemu running after it exits (for a fast next start),
; so the uninstaller has to clean that up itself.

; Install finish: create the desktop icon once more as a fallback.
; electron-builder's createDesktopShortcut goes through its own CreateShortcuts flow, which
; fails in some setups (desktop redirected to OneDrive, shortcut rolled back by security software),
; leaving users with nothing on the desktop. Here NSIS's native CreateShortcut writes it again:
; $DESKTOP uses SHGetFolderPath, so it follows a redirected desktop. It's idempotent;
; running after electron-builder's step just overwrites the same .lnk.
!macro customInstall
  DetailPrint "Creating desktop shortcut..."
  CreateShortcut "$DESKTOP\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkStart - Run Android apps directly on your PC"
  CreateDirectory "$SMPROGRAMS\ApkStart"
  CreateShortcut "$SMPROGRAMS\ApkStart\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkStart - Run Android apps directly on your PC"
!macroend

!macro customUnInstall
  ; Remove the shortcuts we created ourselves first (nothing should be left behind)
  Delete "$DESKTOP\ApkStart.lnk"
  Delete "$SMPROGRAMS\ApkStart\ApkStart.lnk"
  RMDir "$SMPROGRAMS\ApkStart"

  DetailPrint "Stopping leftover ApkStart processes..."
  ; /F force, /T include child processes. taskkill returns 128 if the process isn't running; ignore it.
  nsExec::Exec 'taskkill.exe /F /T /IM ApkStart.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-x86_64.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-i386.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator-check.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM adb.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM netsimd.exe'
  ; Give processes a moment to exit and release file handles
  Sleep 1500
!macroend
