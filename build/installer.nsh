; GameSentenceMiner - Custom NSIS installer hooks
; Keeps the standard Start Menu entry alongside an elevated launcher.

!define GSM_START_MENU_DIR "$SMPROGRAMS\${PRODUCT_NAME}"
!define GSM_ADMIN_START_MENU_LINK "${GSM_START_MENU_DIR}\${SHORTCUT_NAME} (Administrator).lnk"
!define GSM_UNINSTALL_START_MENU_LINK "${GSM_START_MENU_DIR}\Uninstall ${PRODUCT_NAME}.lnk"
!define GSM_ADMIN_APP_ID "${APP_ID}.Admin"

!macro customInstall
  ; Keep all Start Menu entries grouped under GameSentenceMiner.
  CreateDirectory "${GSM_START_MENU_DIR}"

  ; Write a VBScript launcher that always elevates via UAC.
  ; VBScript's ShellExecute with "runas" verb handles UAC elevation silently
  ; without triggering AV heuristics from hidden PowerShell + ExecutionPolicy Bypass patterns.
  FileOpen $0 "$INSTDIR\Run GSM as Admin.vbs" w
  FileWrite $0 "Set fso = CreateObject($\"Scripting.FileSystemObject$\")$\r$\n"
  FileWrite $0 "dir = fso.GetParentFolderName(WScript.ScriptFullName)$\r$\n"
  FileWrite $0 "exe = dir & $\"\${APP_EXECUTABLE_FILENAME}$\"$\r$\n"
  FileWrite $0 "CreateObject($\"Shell.Application$\").ShellExecute exe, $\"$\", dir, $\"runas$\", 1$\r$\n"
  FileClose $0

  ; Create an admin Start Menu shortcut that targets the launcher.
  CreateShortCut "${GSM_ADMIN_START_MENU_LINK}" "$INSTDIR\Run GSM as Admin.vbs" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  WinShell::SetLnkAUMI "${GSM_ADMIN_START_MENU_LINK}" "${GSM_ADMIN_APP_ID}"

  ; Provide an explicit uninstall entry in the Start Menu folder.
  CreateShortCut "${GSM_UNINSTALL_START_MENU_LINK}" "$INSTDIR\${UNINSTALL_FILENAME}" "" "$INSTDIR\${UNINSTALL_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "$INSTDIR\Run GSM as Admin.vbs"
  Delete "${GSM_ADMIN_START_MENU_LINK}"
  Delete "${GSM_UNINSTALL_START_MENU_LINK}"
  RMDir "${GSM_START_MENU_DIR}"
!macroend
