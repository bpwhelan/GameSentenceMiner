# Exercise publication and rollback against local files; no network or real credentials.
$ErrorActionPreference = 'Stop'
$zipTestRoot = Join-Path ([IO.Path]::GetTempPath()) ('gsm-zip-publisher-' + [Guid]::NewGuid().ToString('N'))
$global:zipTestRemote = Join-Path $zipTestRoot 'remote'
$global:zipTestWrites = [Collections.Generic.List[string]]::new()
$global:zipTestFailManifest = $false
$zipTestOldToken = $env:R2_STORAGE

function Assert-ZipTest([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}

function New-ZipTestCandidate([string]$Version) {
    $directory = Join-Path $zipTestRoot $Version
    New-Item -ItemType Directory -Path $directory | Out-Null
    $bytes = [Text.Encoding]::UTF8.GetBytes("NOTICE for $Version")
    $archive = [IO.Compression.ZipFile]::Open((Join-Path $directory 'texthook.zip'), [IO.Compression.ZipArchiveMode]::Create)
    try {
        $stream = $archive.CreateEntry('NOTICE.md').Open()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    } finally { $archive.Dispose() }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $manifest = @{
        version = $Version
        archive = @{path='texthook.zip'; sha256=(Get-FileHash (Join-Path $directory 'texthook.zip')).Hash.ToLowerInvariant()}
        files = @(@{path='NOTICE.md'; sha256=$hash})
    }
    [IO.File]::WriteAllText((Join-Path $directory 'texthook_manifest.json'), ($manifest | ConvertTo-Json -Depth 4))
    return $directory
}

function Resolve-ZipTestObject([string]$Location) {
    if (!$Location.StartsWith('GSMR2:')) { return $Location }
    $prefix = 'GSMR2:gamesentenceminer/texthook/zip/'
    Assert-ZipTest ($Location.StartsWith($prefix)) "Unexpected remote: $Location"
    $name = $Location.Substring($prefix.Length)
    Assert-ZipTest ($name -in @('texthook.zip', 'texthook_manifest.json')) "Unexpected object: $name"
    return Join-Path $global:zipTestRemote $name
}

function rclone {
    $transferArgs = @($args)
    $global:LASTEXITCODE = 0
    switch ($transferArgs[0]) {
        'lsf' {
            if (Test-Path (Join-Path $global:zipTestRemote 'texthook_manifest.json')) { 'zip/texthook_manifest.json' }
        }
        'copyto' {
            $source = Resolve-ZipTestObject $transferArgs[1]
            $destination = Resolve-ZipTestObject $transferArgs[2]
            New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination -Force
            if ($transferArgs[2].StartsWith('GSMR2:')) {
                $global:zipTestWrites.Add([IO.Path]::GetFileName($destination))
                if ($global:zipTestFailManifest -and $destination.EndsWith('texthook_manifest.json')) {
                    $global:zipTestFailManifest = $false
                    $global:LASTEXITCODE = 1
                }
            }
        }
        'deletefile' { Remove-Item -LiteralPath (Resolve-ZipTestObject $transferArgs[1]) }
        default { throw "Unexpected rclone operation: $($transferArgs[0])" }
    }
}

function Invoke-RestMethod {
    return @{success=$true; result=@{id=('a' * 32); status='active'}}
}

function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$PassThru, [switch]$UseBasicParsing, $TimeoutSec)
    Assert-ZipTest ($Uri.StartsWith('https://r2.gamesentenceminer.com/texthook/zip/')) "Unexpected public URL: $Uri"
    Copy-Item -LiteralPath (Join-Path $global:zipTestRemote ([IO.Path]::GetFileName($Uri))) -Destination $OutFile -Force
    return @{Headers=@{'CF-Cache-Status'='DYNAMIC'}}
}

try {
    $env:R2_STORAGE = 'test-token-never-sent-to-a-server'
    New-Item -ItemType Directory -Path $global:zipTestRemote -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipTestV1 = New-ZipTestCandidate '1.0.1'
    $zipTestV2 = New-ZipTestCandidate '1.0.2'
    $zipTestV3 = New-ZipTestCandidate '1.0.3'
    $zipTestPublisher = Join-Path $PSScriptRoot 'publish-lunahook-update.ps1'

    & $zipTestPublisher -CandidateDirectory $zipTestV1 -BackupDirectory (Join-Path $zipTestRoot 'preflight')
    Assert-ZipTest ($global:zipTestWrites.Count -eq 0) 'Preflight changed remote files.'
    & $zipTestPublisher -CandidateDirectory $zipTestV1 -BackupDirectory (Join-Path $zipTestRoot 'initial') -Publish -PurgeCache
    Assert-ZipTest (($global:zipTestWrites -join ',') -eq 'texthook.zip,texthook_manifest.json') 'Initial publication did not upload ZIP then manifest.'
    Assert-ZipTest (@(Get-ChildItem $global:zipTestRemote -File).Count -eq 2) 'Publication must contain exactly two objects.'

    & $zipTestPublisher -CandidateDirectory $zipTestV2 -BackupDirectory (Join-Path $zipTestRoot 'update') -Publish -PurgeCache
    $zipTestPrevious = Get-Content (Join-Path $zipTestRoot 'update/previous/texthook_manifest.json') -Raw | ConvertFrom-Json
    Assert-ZipTest ($zipTestPrevious.version -eq '1.0.1') 'Previous version was not backed up.'

    $global:zipTestFailManifest = $true
    $zipTestError = ''
    try { & $zipTestPublisher -CandidateDirectory $zipTestV3 -BackupDirectory (Join-Path $zipTestRoot 'rollback') -Publish -PurgeCache }
    catch { $zipTestError = $_.Exception.Message }
    Assert-ZipTest ($zipTestError -like '*previous version restored and publicly verified*') "Rollback failed: $zipTestError"
    Assert-ZipTest ((Get-FileHash (Join-Path $global:zipTestRemote 'texthook.zip')).Hash -eq (Get-FileHash (Join-Path $zipTestV2 'texthook.zip')).Hash) 'Rollback did not restore ZIP bytes.'
    Assert-ZipTest ((Get-FileHash (Join-Path $global:zipTestRemote 'texthook_manifest.json')).Hash -eq (Get-FileHash (Join-Path $zipTestV2 'texthook_manifest.json')).Hash) 'Rollback did not restore the manifest.'

    $zipTestWriteCount = $global:zipTestWrites.Count
    $zipTestError = ''
    try { & $zipTestPublisher -CandidateDirectory $zipTestV2 -BackupDirectory (Join-Path $zipTestRoot 'repeat') -Publish }
    catch { $zipTestError = $_.Exception.Message }
    Assert-ZipTest ($zipTestError -like '*already published*' -and $global:zipTestWrites.Count -eq $zipTestWriteCount) 'Reused version was not rejected before upload.'

    $global:zipTestRemote = Join-Path $zipTestRoot 'empty-remote'
    New-Item -ItemType Directory -Path $global:zipTestRemote | Out-Null
    $global:zipTestFailManifest = $true
    $zipTestError = ''
    try { & $zipTestPublisher -CandidateDirectory $zipTestV3 -BackupDirectory (Join-Path $zipTestRoot 'first-failure') -Publish -PurgeCache }
    catch { $zipTestError = $_.Exception.Message }
    Assert-ZipTest ($zipTestError -like '*First ZIP publication failed*') 'Initial publication failure was not reported.'
    Assert-ZipTest (!(Test-Path (Join-Path $global:zipTestRemote 'texthook_manifest.json'))) 'Failed initial publication advertised a version.'
    Write-Output 'Publisher tests passed: preflight, first publication, update, rollback, duplicate version, first-publication failure.'
} finally {
    $env:R2_STORAGE = $zipTestOldToken
    $resolved = [IO.Path]::GetFullPath($zipTestRoot)
    if ([IO.Path]::GetDirectoryName($resolved) -ne [IO.Path]::GetTempPath().TrimEnd('\', '/') -or ![IO.Path]::GetFileName($resolved).StartsWith('gsm-zip-publisher-')) {
        throw 'Refusing to remove an unexpected test directory.'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
