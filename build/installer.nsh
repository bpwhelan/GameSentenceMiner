; GameSentenceMiner – Custom NSIS installer hooks
; Creates a "Run as Admin" launcher in the install directory and Start Menu.

!macro customInstall
  ; ── Write a small CMD launcher that elevates via UAC ──
  FileOpen $0 "$INSTDIR\Run GSM as Admin.cmd" w
  FileWrite $0 '@echo off$\r$\n'
  FileWrite $0 'cd /d "%~dp0"$\r$\n'
  FileWrite $0 'powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath ''%~dp0${APP_EXECUTABLE_FILENAME}'' -Verb RunAs -WorkingDirectory ''%~dp0''"$\r$\n'
  FileClose $0

  ; ── Create a Start Menu shortcut that points to the .cmd launcher ──
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME} (Admin).lnk" \
    "$INSTDIR\Run GSM as Admin.cmd" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "$INSTDIR\Run GSM as Admin.cmd"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME} (Admin).lnk"
!macroend
