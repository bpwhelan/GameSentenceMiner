; GameSentenceMiner – Custom NSIS installer hooks
; Creates a separate Start Menu launcher for elevated runs.

!define GSM_START_MENU_DIR "$SMPROGRAMS\${PRODUCT_NAME}"

!macro customInstall
  ; Keep all Start Menu entries grouped under GameSentenceMiner.
  CreateDirectory "${GSM_START_MENU_DIR}"

  ; Recreate the default app shortcut inside the GameSentenceMiner folder.
  ${if} ${FileExists} "$newStartMenuLink"
    StrCpy $1 "${GSM_START_MENU_DIR}\${PRODUCT_NAME}.lnk"
    Delete "$1"
    CreateShortCut "$1" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
    WinShell::SetLnkAUMI "$1" "${APP_ID}"
    Delete "$newStartMenuLink"
    StrCpy $launchLink "$1"
  ${endIf}

  ; Write a small CMD launcher that always elevates via UAC.
  FileOpen $0 "$INSTDIR\Run GSM as Admin.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "setlocal$\r$\n"
  FileWrite $0 "set $\"GSM_DIR=%~dp0$\"$\r$\n"
  FileWrite $0 "set $\"GSM_EXE=%~dp0${APP_EXECUTABLE_FILENAME}$\"$\r$\n"
  FileWrite $0 "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command $\"Start-Process -FilePath $$env:GSM_EXE -WorkingDirectory $$env:GSM_DIR -Verb RunAs$\"$\r$\n"
  FileClose $0

  ; Create an admin Start Menu shortcut that targets the launcher.
  StrCpy $0 "${GSM_START_MENU_DIR}\${PRODUCT_NAME} (Administrator).lnk"
  CreateShortCut "$0" "$INSTDIR\Run GSM as Admin.cmd" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  WinShell::SetLnkAUMI "$0" "${APP_ID}"
!macroend

!macro customUnInstall
  Delete "$INSTDIR\Run GSM as Admin.cmd"
  Delete "${GSM_START_MENU_DIR}\${PRODUCT_NAME}.lnk"
  Delete "${GSM_START_MENU_DIR}\${PRODUCT_NAME} (Administrator).lnk"
  RMDir "${GSM_START_MENU_DIR}"
!macroend
