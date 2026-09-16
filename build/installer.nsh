!define GSM_START_MENU_DIR "$SMPROGRAMS\${PRODUCT_NAME}"
!define GSM_ADMIN_START_MENU_LINK "${GSM_START_MENU_DIR}\${SHORTCUT_NAME} (Administrator).lnk"
!define GSM_UNINSTALL_START_MENU_LINK "${GSM_START_MENU_DIR}\Uninstall ${PRODUCT_NAME}.lnk"
!define GSM_ADMIN_APP_ID "${APP_ID}.Admin"

!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
  Var GsmDataDir
  Var GsmDataLocked
  Var GsmDataInput
  Var GsmDataBrowse
  Var GsmDataError

  !macro customInit
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=gsm-data-directory.ps1 "${BUILD_RESOURCES_DIR}\data-directory.ps1"
    SetOutPath "$INSTDIR"
    StrCpy $GsmDataDir ""
    StrCpy $GsmDataLocked "0"
  !macroend

  !macro customPageAfterChangeDir
    Page custom GsmDataPageCreate GsmDataPageLeave
  !macroend

  !macro GsmRunDataHelper MODE
    nsExec::ExecToStack /TIMEOUT=30000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\gsm-data-directory.ps1" -Mode ${MODE} -OutputPath "$PLUGINSDIR\gsm-data-state.ini" -SelectionFile "$PLUGINSDIR\gsm-data-selection.txt"'
    Pop $0
    Pop $1
    StrCpy $GsmDataError ""
    ${If} $0 != "0"
      ReadINIStr $GsmDataError "$PLUGINSDIR\gsm-data-state.ini" "DataDirectory" "Error"
      ${If} $GsmDataError == ""
        StrCpy $GsmDataError "Unable to check the GSM data folder. Windows PowerShell returned: $0. $1"
      ${EndIf}
    ${EndIf}
  !macroend

  ; Expand after electron-builder has included MUI2/common/multiUser definitions.
  !macro customHeader
  Function GsmDataPageCreate
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ; A machine-wide installer may run under another administrator's identity. Each
    ; user's data selection belongs to their own profile, so leave it to GSM Settings.
    ${If} $installMode == "all"
      Abort
    ${EndIf}
    !insertmacro GsmRunDataHelper Inspect
    ${If} $GsmDataError != ""
      MessageBox MB_OK|MB_ICONSTOP "$GsmDataError"
      Abort
    ${EndIf}
    ReadINIStr $GsmDataLocked "$PLUGINSDIR\gsm-data-state.ini" "DataDirectory" "Locked"
    ${If} $GsmDataDir == ""
    ${OrIf} $GsmDataLocked == "1"
      ReadINIStr $GsmDataDir "$PLUGINSDIR\gsm-data-state.ini" "DataDirectory" "Path"
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "GSM Data Folder" "Choose where GSM stores its settings, database, and downloaded tools."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 36u "This folder is separate from the application installation. Choose a folder with room for downloaded OCR models and tools."
    Pop $0
    ${NSD_CreateDirRequest} 0 42u 78% 14u "$GsmDataDir"
    Pop $GsmDataInput
    ${NSD_CreateBrowseButton} 80% 42u 20% 14u "Browse..."
    Pop $GsmDataBrowse
    ${NSD_OnClick} $GsmDataBrowse GsmDataBrowseClick
    ${If} $GsmDataLocked == "1"
      EnableWindow $GsmDataInput 0
      EnableWindow $GsmDataBrowse 0
      ${NSD_CreateLabel} 0 66u 100% 42u "GSM data was found. This installation will keep using the folder shown above. To move existing data safely, use Settings > Data Folder in GSM after installation."
      Pop $0
    ${Else}
      ${NSD_CreateLabel} 0 66u 100% 42u "You can move your data later from Settings > Data Folder. Uninstalling or updating the application keeps your data and this choice."
      Pop $0
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function GsmDataBrowseClick
    nsDialogs::SelectFolderDialog "Choose a GSM data folder" "$GsmDataDir"
    Pop $0
    ${If} $0 != error
      StrCpy $GsmDataDir $0
      ${NSD_SetText} $GsmDataInput "$GsmDataDir"
    ${EndIf}
  FunctionEnd

  Function GsmDataPageLeave
    ${If} $GsmDataLocked == "1"
      Return
    ${EndIf}
    ${NSD_GetText} $GsmDataInput $GsmDataDir
    Call GsmWriteDataSelection
    !insertmacro GsmRunDataHelper Validate
    ${If} $GsmDataError != ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "$GsmDataError"
      Abort
    ${EndIf}
  FunctionEnd

  Function GsmWriteDataSelection
    FileOpen $0 "$PLUGINSDIR\gsm-data-selection.txt" w
    FileWriteUTF16LE $0 "$GsmDataDir$\r$\n$INSTDIR"
    FileClose $0
  FunctionEnd
  !macroend
!endif

!macro customInstall
  ${IfNot} ${isUpdated}
  ${AndIfNot} ${Silent}
  ${AndIf} $installMode != "all"
  ${AndIf} $GsmDataDir != ""
  ${AndIf} $GsmDataLocked != "1"
    Call GsmWriteDataSelection
    !insertmacro GsmRunDataHelper Initialize
    ${If} $GsmDataError != ""
      MessageBox MB_OK|MB_ICONSTOP "The application was installed, but the data folder could not be saved.$\r$\n$\r$\n$GsmDataError"
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
  CreateDirectory "${GSM_START_MENU_DIR}"

  CreateShortCut "${GSM_ADMIN_START_MENU_LINK}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  WinShell::SetLnkAUMI "${GSM_ADMIN_START_MENU_LINK}" "${GSM_ADMIN_APP_ID}"

  ; SLDF_RUNAS_USER (0x2000) is in the second byte of the Shell Link flags at
  ; offset 0x14. The old System calls treated a COM interface as a DLL export.
  ClearErrors
  FileOpen $0 "${GSM_ADMIN_START_MENU_LINK}" a
  ${IfNot} ${Errors}
    FileSeek $0 21 SET
    FileReadByte $0 $1
    IntOp $1 $1 | 0x20
    FileSeek $0 21 SET
    FileWriteByte $0 $1
    FileClose $0
  ${EndIf}

  CreateShortCut "${GSM_UNINSTALL_START_MENU_LINK}" "$INSTDIR\${UNINSTALL_FILENAME}" "" "$INSTDIR\${UNINSTALL_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "${GSM_ADMIN_START_MENU_LINK}"
  Delete "${GSM_UNINSTALL_START_MENU_LINK}"
  RMDir "${GSM_START_MENU_DIR}"

  ; Data and the bootstrap pointer survive uninstall and upgrade. A custom folder may
  ; contain unrelated user files: never recursively delete a registry-provided path.
!macroend
