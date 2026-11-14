!include LogicLib.nsh
!include FileFunc.nsh

; Remove only the registered, per-user Electron installation. Its uninstaller
; preserves GSM's data folder; this hook never deletes settings or dictionaries.
!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\3de24769-8950-58da-81a5-294931fe92a6" "InstallLocation"
  ${If} $R0 != ""
    ${If} ${FileExists} "$R0\Uninstall GameSentenceMiner.exe"
      ExecWait '"$R0\Uninstall GameSentenceMiner.exe" /S _?=$R0' $R1
      ${If} $R1 != 0
        MessageBox MB_OK|MB_ICONSTOP "The previous GSM installation could not be removed. Close GSM and try again. Your data is preserved."
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Electron's updater uses --force-run rather than Tauri's /R switch.
  ${If} ${Silent}
    ClearErrors
    ${GetOptions} $CMDLINE "--force-run" $R0
    ${IfNot} ${Errors}
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
    ${EndIf}
  ${EndIf}
!macroend
