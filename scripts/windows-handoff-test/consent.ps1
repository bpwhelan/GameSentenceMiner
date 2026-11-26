param([ValidateSet('Yes','No')][string]$Choice)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable runner required' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$scope = [System.Windows.Automation.TreeScope]
$type = [System.Windows.Automation.AutomationElement]
$all = [System.Windows.Automation.Condition]::TrueCondition
$deadline = [DateTime]::UtcNow.AddMinutes(4)
do {
    foreach ($window in $type::RootElement.FindAll($scope::Children, $all)) {
        if ($window.Current.ClassName -ne '#32770') { continue }
        $controls = $window.FindAll($scope::Descendants, $all)
        if (!($controls | Where-Object { $_.Current.Name -like 'Switch to the new GSM desktop?*' })) { continue }
        $button = $controls | Where-Object { $_.Current.AutomationId -eq $(if ($Choice -eq 'Yes') {'6'} else {'7'}) } | Select-Object -First 1
        if ($button) {
            $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            Write-Output "Selected $Choice in the migration prompt"
            exit 0
        }
    }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
throw 'The migration consent dialog never appeared.'
