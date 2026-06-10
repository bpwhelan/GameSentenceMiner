!define GSM_START_MENU_DIR "$SMPROGRAMS\${PRODUCT_NAME}"
!define GSM_ADMIN_START_MENU_LINK "${GSM_START_MENU_DIR}\${SHORTCUT_NAME} (Administrator).lnk"
!define GSM_UNINSTALL_START_MENU_LINK "${GSM_START_MENU_DIR}\Uninstall ${PRODUCT_NAME}.lnk"
!define GSM_ADMIN_APP_ID "${APP_ID}.Admin"

!macro customInstall
  CreateDirectory "${GSM_START_MENU_DIR}"

  CreateShortCut "${GSM_ADMIN_START_MENU_LINK}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  WinShell::SetLnkAUMI "${GSM_ADMIN_START_MENU_LINK}" "${GSM_ADMIN_APP_ID}"

  System::Call '"shell32::IShellLinkDataList"->GetFlags(*i .r1)'
  System::Call '"shell32::IShellLinkDataList"->SetFlags(i r1|0x2000)' 

  CreateShortCut "${GSM_UNINSTALL_START_MENU_LINK}" "$INSTDIR\${UNINSTALL_FILENAME}" "" "$INSTDIR\${UNINSTALL_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "${GSM_ADMIN_START_MENU_LINK}"
  Delete "${GSM_UNINSTALL_START_MENU_LINK}"
  RMDir "${GSM_START_MENU_DIR}"
!macroend