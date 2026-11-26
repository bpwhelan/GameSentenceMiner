!include LogicLib.nsh
!include FileFunc.nsh

!define GSM_ELECTRON_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\3de24769-8950-58da-81a5-294931fe92a6"
Var ElectronVersion
Var ElectronLaunch
Var ElectronUpdate

!macro NSIS_HOOK_PREINSTALL
  ClearErrors
  ${GetOptions} $CMDLINE "--updated" $R0
  ${IfNot} ${Errors}
    StrCpy $ElectronUpdate 1
  ${EndIf}
  ReadRegStr $ElectronVersion HKCU "${GSM_ELECTRON_KEY}" "DisplayVersion"
  ${If} $ElectronVersion == ""
    ReadRegStr $ElectronVersion HKLM "${GSM_ELECTRON_KEY}" "DisplayVersion"
    ReadRegStr $ElectronLaunch HKLM "${GSM_ELECTRON_KEY}" "DisplayIcon"
  ${Else}
    ReadRegStr $ElectronLaunch HKCU "${GSM_ELECTRON_KEY}" "DisplayIcon"
  ${EndIf}

  ; electron-builder records DisplayIcon as an executable path followed by ,0.
  StrCpy $R0 $ElectronLaunch 2 -2
  ${If} $R0 == ",0"
    StrCpy $ElectronLaunch $ElectronLaunch -2
  ${EndIf}
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $ElectronUpdate == 1
  ${OrIf} $ElectronVersion != ""
  ${AndIf} $R0 == ""
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONQUESTION|MB_SETFOREGROUND "Switch to the new GSM desktop?$\r$\n$\r$\nVersion ${VERSION} replaces the Electron desktop with Tauri. This is a major rewrite by one developer. Some features may behave differently or still have rough edges.$\r$\n$\r$\nYes backs up your GSM database and settings, installs the new GSM alongside Electron, and uses your existing data folder. Choose No to stay on Electron." IDYES gsm_handoff_accepted
    ${If} $ElectronUpdate == 1
    ${AndIf} ${FileExists} "$ElectronLaunch"
      nsis_tauri_utils::RunAsUser "$ElectronLaunch" ""
    ${EndIf}
    SetErrorLevel 1
    Abort
    gsm_handoff_accepted:
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=gsm-handoff.exe "$%GSM_HANDOFF_HELPER%"
    ; Pass paths as arguments. The helper resolves the profile without migrating it.
    nsExec::ExecToStack '"$PLUGINSDIR\gsm-handoff.exe" "$ElectronVersion" "${VERSION}" "$INSTDIR" "$ElectronLaunch"'
    Pop $R0
    Pop $R1
    SetOutPath "$INSTDIR"
    ${If} $R0 != "0"
      MessageBox MB_OK|MB_ICONSTOP "GSM could not prepare the migration. Close GSM, check the data folder and available disk space, then retry.$\r$\n$\r$\n$R1"
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${Silent}
    ClearErrors
    ${GetOptions} $CMDLINE "--force-run" $R0
    ${IfNot} ${Errors}
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
    ${EndIf}
  ${EndIf}
!macroend
