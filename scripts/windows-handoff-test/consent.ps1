param([ValidateSet('Yes','No','OK')][string]$Choice)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable runner required' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MigrationDialog {
    [DllImport("user32.dll")]
    public static extern IntPtr GetDlgItem(IntPtr dialog, int id);
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
$scope = [System.Windows.Automation.TreeScope]
$type = [System.Windows.Automation.AutomationElement]
$all = [System.Windows.Automation.Condition]::TrueCondition
$message = if ($Choice -eq 'OK') {'GSM could not prepare the migration.*'} else {'Switch to the new GSM desktop?*'}
$deadline = [DateTime]::UtcNow.AddMinutes(4)
do {
    foreach ($window in $type::RootElement.FindAll($scope::Children, $all)) {
        if ($window.Current.ClassName -ne '#32770') { continue }
        $controls = $window.FindAll($scope::Descendants, $all)
        if (!($controls | Where-Object { $_.Current.Name -like $message })) { continue }
        $dialog = [IntPtr]$window.Current.NativeWindowHandle
        $id = @{Yes=6; No=7; OK=1}[$Choice]
        $button = [MigrationDialog]::GetDlgItem($dialog, $id)
        if ($button -ne [IntPtr]::Zero -and [MigrationDialog]::PostMessage($dialog, 0x111, $id, $button)) {
            Write-Output "Selected $Choice in the migration prompt"
            exit 0
        }
    }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
throw 'The migration consent dialog never appeared.'
