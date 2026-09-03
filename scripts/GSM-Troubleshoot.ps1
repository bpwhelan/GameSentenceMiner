#requires -Version 5.1

[CmdletBinding()]
param(
    # These switches skip the corresponding prompt and perform the reversible action.
    [switch]$ResetOneOCR,
    [switch]$ForceOBS,
    [switch]$NoPrompt
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$appData = [Environment]::GetFolderPath("ApplicationData")
$userProfile = [Environment]::GetFolderPath("UserProfile")
$desktop = [Environment]::GetFolderPath("Desktop")
if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop)) {
    $desktop = [IO.Path]::GetTempPath().TrimEnd("\")
}

$outputDirectory = Join-Path $desktop "GSM-Troubleshoot-$stamp"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$reportPath = Join-Path $outputDirectory "run-report.txt"
New-Item -ItemType File -Path $reportPath -Force | Out-Null

function Write-Report {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet("Info", "Good", "Warn", "Error")][string]$Level = "Info"
    )

    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -LiteralPath $script:reportPath -Value $line -Encoding UTF8
    $color = switch ($Level) {
        "Good" { "Green" }
        "Warn" { "Yellow" }
        "Error" { "Red" }
        default { "Gray" }
    }
    Write-Host $line -ForegroundColor $color
}

function Ask-YesNo {
    param(
        [Parameter(Mandatory = $true)][string]$Question,
        [bool]$Default = $false
    )

    if ($script:NoPrompt) {
        return $false
    }

    $suffix = if ($Default) { "[Y/n]" } else { "[y/N]" }
    $answer = Read-Host "$Question $suffix"
    if ([string]::IsNullOrWhiteSpace($answer)) {
        return $Default
    }
    return $answer.Trim() -match "^(y|yes)$"
}

function Save-TextFile {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [AllowNull()][string]$Content
    )

    $destination = Join-Path $script:outputDirectory $RelativePath
    $parent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    if ($null -eq $Content) {
        $Content = ""
    }
    [IO.File]::WriteAllText($destination, $Content, [Text.UTF8Encoding]::new($false))
}

function Redact-Text {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) {
        return ""
    }

    $text = [string]$Value
    foreach ($privateValue in @($env:USERPROFILE, $env:USERNAME, $env:COMPUTERNAME)) {
        if (-not [string]::IsNullOrWhiteSpace($privateValue)) {
            $text = $text -replace [regex]::Escape($privateValue), "<REDACTED>"
        }
    }

    # Keep the setting name and error context, but remove likely credentials/tokens.
    $secretPattern = '(?im)(password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|broker[_-]?token)\s*([=:]\s*)("[^"]*"|''[^'']*''|[^\s,}]+)'
    $text = [regex]::Replace($text, $secretPattern, '$1$2<REDACTED>')
    return $text
}

function Get-PropertyValue {
    param(
        [AllowNull()][object]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) {
        return $property.Value
    }
    return $null
}

function Get-JsonPathValue {
    param(
        [AllowNull()][object]$Object,
        [Parameter(Mandatory = $true)][string[]]$Path
    )

    $current = $Object
    foreach ($name in $Path) {
        $current = Get-PropertyValue -Object $current -Name $name
        if ($null -eq $current) {
            return $null
        }
    }
    return $current
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        return (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop)
    }
    catch {
        Write-Report "Could not parse $Path : $($_.Exception.Message)" "Warn"
        return $null
    }
}

function Resolve-ProfileConfig {
    param([AllowNull()][object]$Config)

    if ($null -eq $Config) {
        return $null
    }

    $configs = Get-PropertyValue -Object $Config -Name "configs"
    if ($null -eq $configs) {
        return $Config
    }

    $currentName = [string](Get-PropertyValue -Object $Config -Name "current_profile")
    if (-not [string]::IsNullOrWhiteSpace($currentName)) {
        $current = Get-PropertyValue -Object $configs -Name $currentName
        if ($null -ne $current) {
            return $current
        }
    }

    $default = Get-PropertyValue -Object $configs -Name "Default"
    if ($null -ne $default) {
        return $default
    }

    foreach ($property in $configs.PSObject.Properties) {
        if ($null -ne $property.Value) {
            return $property.Value
        }
    }
    return $Config
}

function Get-GsmProcesses {
    try {
        return @(
            Get-CimInstance Win32_Process -ErrorAction Stop |
                Where-Object {
                    $name = [string]$_.Name
                    $commandLine = [string]$_.CommandLine
                    ($name -match "(?i)GameSentenceMiner|gsm_overlay") -or
                    ($commandLine -match "(?i)GameSentenceMiner|gsm_ocr|GSM_Overlay|gsm_overlay")
                } |
                Select-Object Name, ProcessId, ParentProcessId, ExecutablePath, CommandLine
        )
    }
    catch {
        Write-Report "Could not enumerate processes: $($_.Exception.Message)" "Warn"
        return @()
    }
}

function Save-ObjectJson {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [AllowNull()][object]$Object
    )

    $json = if ($null -eq $Object) { "null" } else { $Object | ConvertTo-Json -Depth 100 }
    Save-TextFile -RelativePath $RelativePath -Content (Redact-Text $json)
}

function Rename-OneOCRCache {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        Write-Report "OneOCR cache was not found at $Path" "Warn"
        return
    }

    $parent = Split-Path -Parent $Path
    $newName = "oneocr.bak-$script:stamp"
    $destination = Join-Path $parent $newName
    $suffix = 2
    while (Test-Path -LiteralPath $destination) {
        $newName = "oneocr.bak-$script:stamp-$suffix"
        $destination = Join-Path $parent $newName
        $suffix++
    }

    try {
        Rename-Item -LiteralPath $Path -NewName $newName -ErrorAction Stop
        Write-Report "Renamed OneOCR cache to $destination. This is reversible." "Good"
    }
    catch {
        Write-Report "Could not rename OneOCR cache: $($_.Exception.Message)" "Error"
    }
}

function Force-ObsCaptureBackend {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowNull()][object]$Config
    )

    if ($null -eq $Config -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Write-Report "Cannot force OBS because the active config could not be read: $Path" "Warn"
        return
    }

    $backupPath = "$Path.bak-gsm-troubleshooter-$script:stamp"
    $temporaryPath = "$Path.gsm-troubleshooter-tmp"
    try {
        Copy-Item -LiteralPath $Path -Destination $backupPath -Force -ErrorAction Stop
        $profileConfig = Resolve-ProfileConfig -Config $Config
        $advanced = Get-PropertyValue -Object $profileConfig -Name "advanced"
        if ($null -eq $advanced) {
            $advanced = [pscustomobject]@{}
            Add-Member -InputObject $profileConfig -MemberType NoteProperty -Name "advanced" -Value $advanced -Force
        }

        foreach ($settingName in @("screenshot_capture_backend_v2", "screenshot_capture_backend")) {
            $setting = $advanced.PSObject.Properties[$settingName]
            if ($null -ne $setting) {
                $setting.Value = "obs"
            }
            else {
                Add-Member -InputObject $advanced -MemberType NoteProperty -Name $settingName -Value "obs"
            }
        }

        $serialized = $Config | ConvertTo-Json -Depth 100
        [IO.File]::WriteAllText($temporaryPath, $serialized, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force -ErrorAction Stop
        Write-Report "Set screenshot capture backend to OBS. Backup: $backupPath" "Good"
    }
    catch {
        Write-Report "Could not update capture backend: $($_.Exception.Message). Backup: $backupPath" "Error"
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Test-WebSocketEndpoint {
    param([Parameter(Mandatory = $true)][string]$Uri)

    $client = New-Object System.Net.WebSockets.ClientWebSocket
    $cancellation = New-Object System.Threading.CancellationTokenSource
    $cancellation.CancelAfter(6000)
    try {
        $uriObject = [Uri]$Uri
        $originScheme = if ($uriObject.Scheme -eq "wss") { "https" } else { "http" }
        $origin = "{0}://{1}" -f $originScheme, $uriObject.Authority
        $client.Options.SetRequestHeader("Origin", $origin)
        $task = $client.ConnectAsync($uriObject, $cancellation.Token)
        if (-not $task.Wait(7000)) {
            throw "WebSocket connection timed out"
        }
        return [pscustomobject]@{
            Uri = $uri
            Result = "Connected"
            State = [string]$client.State
            Error = ""
        }
    }
    catch {
        $errorParts = @($_.Exception.Message)
        $inner = $_.Exception.InnerException
        while ($null -ne $inner) {
            if (-not [string]::IsNullOrWhiteSpace($inner.Message)) {
                $errorParts += $inner.Message
            }
            $inner = $inner.InnerException
        }
        return [pscustomobject]@{
            Uri = $uri
            Result = "Failed"
            State = [string]$client.State
            Error = ($errorParts -join " -> ")
        }
    }
    finally {
        $cancellation.Dispose()
        $client.Dispose()
    }
}

function Test-OverlayWebSocket {
    param([Parameter(Mandatory = $true)][int]$Port)

    return Test-WebSocketEndpoint -Uri "ws://127.0.0.1:$Port/ws/overlay"
}

function Get-InternalWebSocketPort {
    param([Parameter(Mandatory = $true)][string]$Directory)

    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        return $null
    }

    $logFiles = @(
        Get-ChildItem -LiteralPath $Directory -Filter "gamesentenceminer*.log" -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending
    )
    foreach ($logFile in $logFiles) {
        try {
            $content = Read-TextFileWithSharing -Path $logFile.FullName
            $match = [regex]::Match($content, "websocket ingress:\s*(\d+)")
            if ($match.Success) {
                $port = 0
                if ([int]::TryParse($match.Groups[1].Value, [ref]$port) -and $port -ge 1 -and $port -le 65535) {
                    return $port
                }
            }
        }
        catch {
            continue
        }
    }
    return $null
}

function Read-TextFileWithSharing {
    param([Parameter(Mandatory = $true)][string]$Path)

    # Some GSM loggers keep the file open. ReadWrite sharing lets us collect a
    # live log when possible; the caller will still get a clean second chance
    # after GSM is closed.
    $stream = $null
    $reader = $null
    try {
        $stream = [IO.File]::Open(
            $Path,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::ReadWrite
        )
        $reader = New-Object IO.StreamReader($stream)
        return $reader.ReadToEnd()
    }
    finally {
        if ($null -ne $reader) { $reader.Dispose() }
        elseif ($null -ne $stream) { $stream.Dispose() }
    }
}

function Collect-TextLogs {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Directory
    )

    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        return
    }

    $destinationDirectory = Join-Path $script:outputDirectory "logs\$Label"
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    $files = @(
        Get-ChildItem -LiteralPath $Directory -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -in @(".log", ".txt") } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 40
    )

    $index = 0
    foreach ($file in $files) {
        $index++
        try {
            $content = Read-TextFileWithSharing -Path $file.FullName
            $maxCharacters = 6000000
            if ($content.Length -gt $maxCharacters) {
                $content = "[Only the last 6 MB were retained by the troubleshooter.]`r`n" +
                    $content.Substring($content.Length - $maxCharacters)
            }
            $safeName = "{0:D2}-{1}" -f $index, $file.Name
            Save-TextFile -RelativePath (Join-Path "logs\$Label" $safeName) -Content (Redact-Text $content)
        }
        catch {
            Write-Report "Could not read log $($file.FullName): $($_.Exception.Message)" "Warn"
        }
    }
}

Write-Report "GSM troubleshooter started. Output: $outputDirectory" "Good"
Write-Host ""
Write-Host "Close GSM completely first (including its tray icon), then press Enter." -ForegroundColor Cyan
if (-not $NoPrompt) {
    Read-Host | Out-Null
}

$defaultGsmDirectory = Join-Path $appData "GameSentenceMiner"
$pointerPath = Join-Path $defaultGsmDirectory "data_dir.json"
$pointerObject = Read-JsonFile -Path $pointerPath
$pointerDataDirectory = [string](Get-PropertyValue -Object $pointerObject -Name "dataDir")
if ([string]::IsNullOrWhiteSpace($pointerDataDirectory)) {
    $activeGsmDirectory = $defaultGsmDirectory
}
else {
    $activeGsmDirectory = $pointerDataDirectory.Trim()
}

$registryDataDirectory = ""
try {
    $registryObject = Get-ItemProperty -Path "HKCU:\Software\GameSentenceMiner" -ErrorAction Stop
    $registryDataDirectory = [string](Get-PropertyValue -Object $registryObject -Name "DataDir")
}
catch {
    $registryDataDirectory = ""
}

$overlayDataDirectory = [string][Environment]::GetEnvironmentVariable("GSM_OVERLAY_DATA_PATH", "Process")
if ([string]::IsNullOrWhiteSpace($overlayDataDirectory)) {
    $overlayDataDirectory = Join-Path $appData "gsm_overlay"
}
$oneOcrDirectory = Join-Path $userProfile ".config\oneocr"

$pathReport = [ordered]@{
    DefaultGsmDirectory = $defaultGsmDirectory
    PointerFile = $pointerPath
    PointerDataDirectory = $pointerDataDirectory
    ActiveGsmDirectory = $activeGsmDirectory
    RegistryDataDirectory = $registryDataDirectory
    OverlayDataDirectory = $overlayDataDirectory
    OneOCRDirectory = $oneOcrDirectory
    CurrentProcessGSMDataDir = [Environment]::GetEnvironmentVariable("GSM_DATA_DIR", "Process")
}
Save-ObjectJson -RelativePath "paths.json" -Object $pathReport
Write-Report "Active GSM data directory: $activeGsmDirectory"
Write-Report "Overlay data directory: $overlayDataDirectory"
Write-Report "OneOCR directory: $oneOcrDirectory"
if ($registryDataDirectory -and $registryDataDirectory -ne $activeGsmDirectory) {
    Write-Report "Registry data directory differs from the pointer file; this is worth investigating." "Warn"
}
if (-not (Test-Path -LiteralPath $activeGsmDirectory -PathType Container)) {
    Write-Report "The active GSM data directory does not currently exist." "Warn"
}

$processesBefore = @(Get-GsmProcesses)
Save-ObjectJson -RelativePath "processes-before.json" -Object $processesBefore
if ($processesBefore.Count -gt 0) {
    Write-Report "GSM-related processes are still running. Reversible repairs will be skipped until they are closed." "Warn"
}

$configPath = Join-Path $activeGsmDirectory "config.json"
$configObject = Read-JsonFile -Path $configPath
$profileConfig = Resolve-ProfileConfig -Config $configObject
$configuredPort = 7275
$configuredPortValue = Get-JsonPathValue -Object $profileConfig -Path @("general", "single_port")
$parsedPort = 0
if ([int]::TryParse([string]$configuredPortValue, [ref]$parsedPort) -and $parsedPort -ge 1 -and $parsedPort -le 65535) {
    $configuredPort = $parsedPort
}

$configSummary = [ordered]@{
    ConfigPath = $configPath
    CurrentProfile = Get-PropertyValue -Object $configObject -Name "current_profile"
    SinglePort = $configuredPort
    CaptureBackendV2 = Get-JsonPathValue -Object $profileConfig -Path @("advanced", "screenshot_capture_backend_v2")
    CaptureBackendLegacy = Get-JsonPathValue -Object $profileConfig -Path @("advanced", "screenshot_capture_backend")
    OCR1 = Get-JsonPathValue -Object $profileConfig -Path @("overlay", "engine_v2")
    OBSHost = Get-JsonPathValue -Object $profileConfig -Path @("obs", "host")
    OBSPort = Get-JsonPathValue -Object $profileConfig -Path @("obs", "port")
    OBSPath = Redact-Text (Get-JsonPathValue -Object $profileConfig -Path @("obs", "obs_path"))
}
Save-ObjectJson -RelativePath "config-summary.json" -Object $configSummary

$environmentSummary = @(
    Get-ChildItem Env: -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "(?i)^(GSM|ELECTRON|PYTHON|OCR|OBS)" } |
        Select-Object Name, @{Name = "Value"; Expression = { Redact-Text $_.Value }}
)
Save-ObjectJson -RelativePath "environment.json" -Object $environmentSummary

$oneOcrFiles = @()
if (Test-Path -LiteralPath $oneOcrDirectory -PathType Container) {
    $oneOcrFiles = @(
        foreach ($name in @("oneocr.dll", "oneocr.onemodel", "onnxruntime.dll")) {
            $filePath = Join-Path $oneOcrDirectory $name
            if (Test-Path -LiteralPath $filePath -PathType Leaf) {
                $file = Get-Item -LiteralPath $filePath
                $hash = ""
                try { $hash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash } catch { $hash = "unavailable" }
                [ordered]@{
                    Name = $name
                    Exists = $true
                    Length = $file.Length
                    LastWriteTime = $file.LastWriteTime
                    SHA256 = $hash
                }
            }
            else {
                [ordered]@{ Name = $name; Exists = $false }
            }
        }
    )
}
else {
    $oneOcrFiles = @([ordered]@{ DirectoryExists = $false; Path = $oneOcrDirectory })
}
Save-ObjectJson -RelativePath "oneocr-files.json" -Object $oneOcrFiles

if ($processesBefore.Count -eq 0) {
    $resetOneOcrNow = $ResetOneOCR -or (Ask-YesNo -Question "Rename the OneOCR cache to a reversible backup now?" -Default $true)
    if ($resetOneOcrNow) {
        Rename-OneOCRCache -Path $oneOcrDirectory
    }

    $forceObsNow = $ForceOBS -or (Ask-YesNo -Question "Force GSM screenshot capture to OBS and back up config.json?" -Default $true)
    if ($forceObsNow) {
        Force-ObsCaptureBackend -Path $configPath -Config $configObject
    }
}
else {
    Write-Report "Close GSM and rerun the script if you want it to reset OneOCR or force OBS automatically." "Warn"
}

Write-Host ""
Write-Host "Now start GSM normally. Wait for the green indicator, press Start Auto OCR, and try one overlay/Yomitan lookup." -ForegroundColor Cyan
Write-Host "When the failure has reproduced, return here and press Enter." -ForegroundColor Cyan
if (-not $NoPrompt) {
    Read-Host | Out-Null
}

$processesAfter = @(Get-GsmProcesses)
Save-ObjectJson -RelativePath "processes-after.json" -Object $processesAfter

$internalWebSocketPort = Get-InternalWebSocketPort -Directory (Join-Path $activeGsmDirectory "logs")
if ($null -ne $internalWebSocketPort) {
    Write-Report "Detected GSM internal WebSocket ingress port: $internalWebSocketPort"
}
else {
    Write-Report "Could not determine GSM internal WebSocket ingress port from the logs." "Warn"
}

$portChecks = @()
foreach ($portInfo in @(
        [pscustomobject]@{ Name = "GSM HTTP/WebSocket"; Port = $configuredPort }
        [pscustomobject]@{ Name = "OBS WebSocket"; Port = 7274 }
        [pscustomobject]@{ Name = "GSM Rust input server"; Port = 7276 }
        if ($null -ne $internalWebSocketPort) {
            [pscustomobject]@{ Name = "GSM internal WebSocket ingress"; Port = $internalWebSocketPort }
        }
    )) {
    try {
        $tcp = Test-NetConnection -ComputerName "127.0.0.1" -Port $portInfo.Port -InformationLevel Quiet -WarningAction SilentlyContinue
        $portChecks += [ordered]@{ Name = $portInfo.Name; Port = $portInfo.Port; TcpOpen = [bool]$tcp }
    }
    catch {
        $portChecks += [ordered]@{ Name = $portInfo.Name; Port = $portInfo.Port; TcpOpen = $false; Error = $_.Exception.Message }
    }
}
Save-ObjectJson -RelativePath "port-checks.json" -Object $portChecks

try {
    $inputServerListeners = @(Get-NetTCPConnection -LocalPort 7276 -State Listen -ErrorAction Stop |
        Select-Object LocalAddress, LocalPort, OwningProcess)
    Save-ObjectJson -RelativePath "rust-input-server-listeners.json" -Object $inputServerListeners
}
catch {
    Save-TextFile -RelativePath "rust-input-server-listeners.txt" -Content "Could not query the listener on port 7276: $($_.Exception.Message)"
}

$httpResult = [ordered]@{ Uri = "http://127.0.0.1:$configuredPort/"; Result = "Not tested" }
try {
    $response = Invoke-WebRequest -Uri $httpResult.Uri -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
    $httpResult.Result = "OK"
    $httpResult.StatusCode = $response.StatusCode
    $httpResult.ContentLength = $response.RawContentLength
}
catch {
    $httpResult.Result = "Failed"
    $httpResult.Error = $_.Exception.Message
}
Save-ObjectJson -RelativePath "http-check.json" -Object $httpResult

$webSocketResult = Test-OverlayWebSocket -Port $configuredPort
Save-ObjectJson -RelativePath "overlay-websocket-check.json" -Object $webSocketResult
if ($webSocketResult.Result -eq "Connected") {
    Write-Report "Overlay WebSocket accepted a connection." "Good"
}
else {
    Write-Report "Overlay WebSocket test failed: $($webSocketResult.Error)" "Warn"
}

$inputServerWebSocketResult = Test-WebSocketEndpoint -Uri "ws://127.0.0.1:7276/"
Save-ObjectJson -RelativePath "rust-input-server-websocket-check.json" -Object $inputServerWebSocketResult
if ($inputServerWebSocketResult.Result -eq "Connected") {
    Write-Report "Rust input-server WebSocket accepted a connection on port 7276." "Good"
}
else {
    Write-Report "Rust input-server WebSocket test failed: $($inputServerWebSocketResult.Error)" "Warn"
}

if ($null -ne $internalWebSocketPort) {
    $internalWebSocketResult = Test-WebSocketEndpoint -Uri "ws://127.0.0.1:$internalWebSocketPort/ws/overlay"
    Save-ObjectJson -RelativePath "gsm-internal-overlay-websocket-check.json" -Object $internalWebSocketResult
    if ($internalWebSocketResult.Result -eq "Connected") {
        Write-Report "GSM internal overlay WebSocket accepted a connection on port $internalWebSocketPort." "Good"
    }
    else {
        Write-Report "GSM internal overlay WebSocket test failed: $($internalWebSocketResult.Error)" "Warn"
    }
}

$osSummary = [ordered]@{}
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $osSummary = [ordered]@{
        Caption = $os.Caption
        Version = $os.Version
        BuildNumber = $os.BuildNumber
        LastBootUpTime = $os.LastBootUpTime
    }
}
catch {
    $osSummary = [ordered]@{ Error = $_.Exception.Message }
}
Save-ObjectJson -RelativePath "operating-system.json" -Object $osSummary

try {
    $gpu = @(Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object Name, DriverVersion, DriverDate, VideoModeDescription)
    Save-ObjectJson -RelativePath "graphics.json" -Object $gpu
}
catch {
    Save-TextFile -RelativePath "graphics.txt" -Content "Could not query graphics information: $($_.Exception.Message)"
}

try {
    $obs = @(Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object { $_.Name -match "(?i)^obs(64)?\.exe$" } |
        Select-Object Name, ProcessId, ExecutablePath, CommandLine)
    Save-ObjectJson -RelativePath "obs-processes.json" -Object $obs
}
catch {
    Save-TextFile -RelativePath "obs-processes.txt" -Content "Could not query OBS process information: $($_.Exception.Message)"
}

if (Get-Command Get-MpThreatDetection -ErrorAction SilentlyContinue) {
    try {
        $defender = @(Get-MpThreatDetection -ErrorAction Stop | Select-Object -First 25 ThreatID, Resources, ActionSuccess, InitialDetectionTime)
        Save-ObjectJson -RelativePath "defender-threat-history.json" -Object $defender
    }
    catch {
        Save-TextFile -RelativePath "defender-threat-history.txt" -Content "Defender history was unavailable: $($_.Exception.Message)"
    }
}

Write-Host ""
Write-Host "Close GSM completely now, including the tray icon, then press Enter." -ForegroundColor Cyan
Write-Host "This unlocks the main and OCR logs so the final copies are complete." -ForegroundColor Cyan
if (-not $NoPrompt) {
    Read-Host | Out-Null
}

$logSources = [ordered]@{
    ActiveGSMLogs = Join-Path $activeGsmDirectory "logs"
    DefaultGSMLogs = Join-Path $defaultGsmDirectory "logs"
    OCRProcessLogs = Join-Path $activeGsmDirectory "temp\ocr_logs"
    ElectronLogs = Join-Path $activeGsmDirectory "electron\logs"
    OverlayLogs = Join-Path $overlayDataDirectory "logs"
}
Save-ObjectJson -RelativePath "log-sources.json" -Object $logSources
foreach ($source in $logSources.GetEnumerator()) {
    Collect-TextLogs -Label $source.Key -Directory $source.Value
}

$overlaySettingsPath = Join-Path $overlayDataDirectory "settings.json"
$overlaySettings = Read-JsonFile -Path $overlaySettingsPath
$overlaySummary = [ordered]@{
    SettingsPath = $overlaySettingsPath
    Exists = Test-Path -LiteralPath $overlaySettingsPath -PathType Leaf
    WebUrl1 = Get-PropertyValue -Object $overlaySettings -Name "weburl1"
    WebUrl2 = Get-PropertyValue -Object $overlaySettings -Name "weburl2"
    TexthookerUrl = Get-PropertyValue -Object $overlaySettings -Name "texthookerUrl"
    ManualMode = Get-PropertyValue -Object $overlaySettings -Name "manualMode"
    HideOverlayOnStartup = Get-PropertyValue -Object $overlaySettings -Name "hideOverlayOnStartup"
    HideOnStartup = Get-PropertyValue -Object $overlaySettings -Name "hideOnStartup"
    OpenSettingsOnStartup = Get-PropertyValue -Object $overlaySettings -Name "openSettingsOnStartup"
    ShowTextIndicators = Get-PropertyValue -Object $overlaySettings -Name "showTextIndicators"
    ToggleWindowHotkey = Get-PropertyValue -Object $overlaySettings -Name "toggleWindowHotkey"
    OverlaySettingsHotkey = Get-PropertyValue -Object $overlaySettings -Name "overlaySettingsHotkey"
    YomitanSettingsHotkey = Get-PropertyValue -Object $overlaySettings -Name "yomitanSettingsHotkey"
}
Save-ObjectJson -RelativePath "overlay-settings-summary.json" -Object $overlaySummary

Write-Report "Finished. Review the redacted files in $outputDirectory and send that folder as a zip if comfortable." "Good"
$archivePath = "$outputDirectory.zip"
try {
    Compress-Archive -Path $outputDirectory -DestinationPath $archivePath -Force -CompressionLevel Optimal -ErrorAction Stop
    Write-Report "Created diagnostic archive: $archivePath" "Good"
}
catch {
    Write-Report "Could not create zip archive: $($_.Exception.Message)" "Warn"
}
Write-Host ""
Write-Host "Important: the logs were redacted for usernames and likely credentials, but review them before sharing." -ForegroundColor Yellow
Write-Host "The original OneOCR folder, if renamed, and config backup are still on the machine." -ForegroundColor Yellow
Write-Host "Output folder: $outputDirectory" -ForegroundColor Cyan
if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
    Write-Host "Zip archive: $archivePath" -ForegroundColor Cyan
}

if (-not $NoPrompt) {
    Read-Host "Press Enter to close" | Out-Null
}
