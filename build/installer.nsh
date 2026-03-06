; GameSentenceMiner - Custom NSIS installer hooks
; Keeps the standard Start Menu entry alongside an elevated launcher.

!define GSM_START_MENU_DIR "$SMPROGRAMS\${PRODUCT_NAME}"
!define GSM_STANDARD_START_MENU_LINK "${GSM_START_MENU_DIR}\${SHORTCUT_NAME}.lnk"
!define GSM_LEGACY_START_MENU_LINK "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
!define GSM_ADMIN_START_MENU_LINK "${GSM_START_MENU_DIR}\${SHORTCUT_NAME} (Administrator).lnk"
!define GSM_UNINSTALL_START_MENU_LINK "${GSM_START_MENU_DIR}\Uninstall ${PRODUCT_NAME}.lnk"

!macro customInstall
  ; Keep all Start Menu entries grouped under GameSentenceMiner.
  CreateDirectory "${GSM_START_MENU_DIR}"

  ; Ensure the standard app shortcut exists inside the GameSentenceMiner folder.
  ${ifNot} ${FileExists} "${GSM_STANDARD_START_MENU_LINK}"
    CreateShortCut "${GSM_STANDARD_START_MENU_LINK}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  ${endIf}
  WinShell::SetLnkAUMI "${GSM_STANDARD_START_MENU_LINK}" "${APP_ID}"
  Delete "${GSM_LEGACY_START_MENU_LINK}"
  StrCpy $launchLink "${GSM_STANDARD_START_MENU_LINK}"

  ; Write a small CMD launcher that always elevates via UAC.
  FileOpen $0 "$INSTDIR\Run GSM as Admin.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "setlocal$\r$\n"
  FileWrite $0 "set $\"GSM_DIR=%~dp0$\"$\r$\n"
  FileWrite $0 "set $\"GSM_EXE=%~dp0${APP_EXECUTABLE_FILENAME}$\"$\r$\n"
  FileWrite $0 "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command $\"Start-Process -FilePath $$env:GSM_EXE -WorkingDirectory $$env:GSM_DIR -Verb RunAs$\"$\r$\n"
  FileClose $0

  ; Create an admin Start Menu shortcut that targets the launcher.
  CreateShortCut "${GSM_ADMIN_START_MENU_LINK}" "$INSTDIR\Run GSM as Admin.cmd" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  WinShell::SetLnkAUMI "${GSM_ADMIN_START_MENU_LINK}" "${APP_ID}"

  ; Provide an explicit uninstall entry in the Start Menu folder.
  CreateShortCut "${GSM_UNINSTALL_START_MENU_LINK}" "$INSTDIR\${UNINSTALL_FILENAME}" "" "$INSTDIR\${UNINSTALL_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "$INSTDIR\Run GSM as Admin.cmd"
  Delete "${GSM_STANDARD_START_MENU_LINK}"
  Delete "${GSM_ADMIN_START_MENU_LINK}"
  Delete "${GSM_UNINSTALL_START_MENU_LINK}"
  Delete "${GSM_LEGACY_START_MENU_LINK}"
  RMDir "${GSM_START_MENU_DIR}"
!macroend
