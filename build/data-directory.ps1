param(
    [ValidateSet('Inspect', 'Validate', 'Initialize')][string]$Mode = 'Inspect',
    [string]$ProfileRoot = $env:USERPROFILE,
    [string]$AppDataRoot = [Environment]::GetFolderPath('ApplicationData'),
    [string]$OutputPath,
    [string]$SelectionFile
)

$ErrorActionPreference = 'Stop'

function Resolve-GsmDirectory([object]$Value) {
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) {
        throw 'Choose an absolute data folder path.'
    }
    $candidate = $Value.Trim()
    if ($candidate -match '^~([\\/]|$)') {
        $candidate = Join-Path $ProfileRoot $candidate.Substring([Math]::Min(2, $candidate.Length))
    }
    if ($candidate -notmatch '^([A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)' -or $candidate -match '[\x00-\x1f"<>|*?]') {
        throw 'Choose an absolute data folder path without invalid filename characters.'
    }
    return [IO.Path]::GetFullPath($candidate).TrimEnd('\', '/')
}

function Get-GsmDirectoryState {
    $defaultDirectory = Join-Path $AppDataRoot 'GameSentenceMiner'
    $pointerPath = Join-Path $ProfileRoot '.config\GameSentenceMiner\data_dir.json'
    $legacyPath = Join-Path $defaultDirectory 'data_dir.json'
    foreach ($candidate in @($pointerPath, $legacyPath)) {
        if (Test-Path -LiteralPath $candidate) {
            try {
                $pointer = Get-Content -LiteralPath $candidate -Raw -Encoding UTF8 | ConvertFrom-Json
                $directory = Resolve-GsmDirectory $pointer.dataDir
            } catch {
                throw "Cannot read the saved data location in ${candidate}: $($_.Exception.Message)"
            }
            return @{ Path = $directory; Locked = $true; Pointer = $pointerPath }
        }
    }
    $hasData = (Test-Path -LiteralPath $defaultDirectory) -and
        ($null -ne (Get-ChildItem -LiteralPath $defaultDirectory -Force | Select-Object -First 1))
    return @{ Path = $defaultDirectory; Locked = $hasData; Pointer = $pointerPath }
}

function Test-GsmDirectory([string]$Directory, [string]$InstallDirectory) {
    $directoryPath = Resolve-GsmDirectory $Directory
    $installPath = Resolve-GsmDirectory $InstallDirectory
    $root = [IO.Path]::GetPathRoot($directoryPath).TrimEnd('\', '/')
    if ($directoryPath -eq $root -or $directoryPath -eq $ProfileRoot.TrimEnd('\', '/')) {
        throw 'Choose a dedicated GameSentenceMiner folder, not a drive root or your home folder.'
    }
    if ($directoryPath -eq $installPath -or
        $directoryPath.StartsWith($installPath + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $installPath.StartsWith($directoryPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The data folder and application installation folder must be separate.'
    }
    if ((Test-Path -LiteralPath $directoryPath) -and
        ($null -ne (Get-ChildItem -LiteralPath $directoryPath -Force | Select-Object -First 1))) {
        throw 'Choose an empty data folder. Existing installations can be moved from GSM Settings.'
    }
    [IO.Directory]::CreateDirectory($directoryPath) | Out-Null
    $probe = Join-Path $directoryPath ('.gsm-write-test-' + [Guid]::NewGuid().ToString('N'))
    try {
        $stream = [IO.File]::Open($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
        $stream.Dispose()
    } finally {
        if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe }
    }
    return $directoryPath
}

try {
    $state = Get-GsmDirectoryState
    if ($Mode -ne 'Inspect') {
        # NSIS passes paths as UTF-16 file contents, never interpolated into shell code.
        $selection = [IO.File]::ReadAllLines($SelectionFile, [Text.Encoding]::Unicode)
        if ($selection.Length -ne 2) { throw 'The installer data folder selection is invalid.' }
        $chosen = Resolve-GsmDirectory $selection[0]
        if ($state.Locked) {
            if ($chosen -ne $state.Path) {
                throw 'GSM already has a data location. Change it in GSM Settings after installation.'
            }
        } else {
            $chosen = Test-GsmDirectory $chosen $selection[1]
            if ($Mode -eq 'Initialize') {
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($state.Pointer)) | Out-Null
                $temporary = $state.Pointer + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
                try {
                    $json = @{ version = 2; dataDir = $chosen } | ConvertTo-Json
                    [IO.File]::WriteAllText($temporary, $json + "`n", [Text.UTF8Encoding]::new($false))
                    # Move fails if another installer/app has saved a pointer in the meantime.
                    [IO.File]::Move($temporary, $state.Pointer)
                } finally {
                    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
                }
            }
            $state.Path = $chosen
        }
    }
    if ($OutputPath) {
        $locked = [int][bool]$state.Locked
        [IO.File]::WriteAllText($OutputPath, "[DataDirectory]`r`nPath=$($state.Path)`r`nLocked=$locked`r`n", [Text.Encoding]::Unicode)
    }
    exit 0
} catch {
    $errorText = $_.Exception.Message -replace '[\r\n]+', ' '
    if ($OutputPath) {
        [IO.File]::WriteAllText($OutputPath, "[DataDirectory]`r`nError=$errorText`r`n", [Text.Encoding]::Unicode)
    }
    Write-Error $errorText -ErrorAction Continue
    exit 1
}
