# Isolated R2/public-HTTP simulation. No network or real credentials are used.
$ErrorActionPreference = 'Stop'
$zipTestRoot = Join-Path ([IO.Path]::GetTempPath()) ('gsm-zip-publisher-' + [Guid]::NewGuid().ToString('N'))
$global:zipTestRemote = Join-Path $zipTestRoot 'remote'
$global:zipTestWrites = [Collections.Generic.List[string]]::new()
$global:zipTestFailManifest = $false
$zipTestOldToken = $env:R2_STORAGE
$publisher = Join-Path $PSScriptRoot 'publish-lunahook-update.ps1'
function Assert-ZipTest([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function New-ZipTestRelease([string]$Version) {
    $directory = Join-Path $zipTestRoot "packages/$Version"
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $bytes = [Text.Encoding]::UTF8.GetBytes("NOTICE for $Version")
    $archive = [IO.Compression.ZipFile]::Open((Join-Path $directory 'texthook.zip'), [IO.Compression.ZipArchiveMode]::Create)
    try {
        $stream = $archive.CreateEntry('NOTICE.md').Open()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    } finally { $archive.Dispose() }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    return @{ version=$Version; archive=@{path="versions/$Version/texthook.zip"; sha256=(Get-FileHash (Join-Path $directory 'texthook.zip')).Hash.ToLowerInvariant()}; files=@(@{path='NOTICE.md'; sha256=$hash}) }
}
function New-ZipTestCandidate([string]$Name, [object[]]$Releases, [string]$Recommended) {
    $directory = Join-Path $zipTestRoot $Name
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    foreach ($release in $Releases) {
        $destination = Join-Path $directory $release.archive.path
        New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $zipTestRoot "packages/$($release.version)/texthook.zip") -Destination $destination
    }
    @{schemaVersion=2; recommendedVersion=$Recommended; releases=@($Releases)} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $directory 'texthook_manifest_v2.json') -Encoding utf8NoBOM
    return $directory
}
function Resolve-ZipTestObject([string]$Location) {
    if (!$Location.StartsWith('GSMR2:')) { return $Location }
    $prefix = 'GSMR2:gamesentenceminer/texthook/zip/'
    Assert-ZipTest ($Location.StartsWith($prefix)) "Unexpected remote: $Location"
    $relative = $Location.Substring($prefix.Length)
    Assert-ZipTest ($relative -eq 'texthook_manifest_v2.json' -or $relative -match '^versions/\d+\.\d+\.\d+/texthook.zip$') "Attempt to touch legacy/unexpected object: $relative"
    return Join-Path $global:zipTestRemote $relative
}
function rclone {
    $transferArgs = @($args)
    $global:LASTEXITCODE = 0
    switch ($transferArgs[0]) {
        'lsf' {
            if (Test-Path -LiteralPath $global:zipTestRemote) {
                Get-ChildItem -LiteralPath $global:zipTestRemote -Recurse -File | ForEach-Object {
                    'zip/' + [IO.Path]::GetRelativePath($global:zipTestRemote, $_.FullName).Replace('\', '/')
                }
            }
        }
        'copyto' {
            $source = Resolve-ZipTestObject $transferArgs[1]
            $destination = Resolve-ZipTestObject $transferArgs[2]
            New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination -Force
            if ($transferArgs[2].StartsWith('GSMR2:')) {
                $global:zipTestWrites.Add([IO.Path]::GetRelativePath($global:zipTestRemote, $destination).Replace('\', '/'))
                if ($global:zipTestFailManifest -and $destination.EndsWith('texthook_manifest_v2.json')) {
                    $global:zipTestFailManifest = $false
                    $global:LASTEXITCODE = 1
                }
            }
        }
        'deletefile' { Remove-Item -LiteralPath (Resolve-ZipTestObject $transferArgs[1]) }
        default { throw "Unexpected operation: $($transferArgs[0])" }
    }
}
function Invoke-RestMethod { return @{success=$true; result=@{id=('a' * 32); status='active'}} }
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$PassThru, [switch]$UseBasicParsing, $TimeoutSec)
    $prefix = 'https://r2.gamesentenceminer.com/texthook/zip/'
    Assert-ZipTest ($Uri.StartsWith($prefix)) "Unexpected URL: $Uri"
    $relative = $Uri.Substring($prefix.Length)
    Copy-Item -LiteralPath (Join-Path $global:zipTestRemote $relative) -Destination $OutFile -Force
    return @{Headers=@{'CF-Cache-Status'='DYNAMIC'}}
}
function Expect-ZipTestFailure([scriptblock]$Action, [string]$Pattern) {
    $failure = $null
    try { & $Action } catch { $failure = $_.Exception.Message }
    Assert-ZipTest ($failure -match $Pattern) "Expected '$Pattern'; got '$failure'."
}
try {
    $env:R2_STORAGE = 'test-token-never-sent-to-a-server'
    New-Item -ItemType Directory -Path $global:zipTestRemote -Force | Out-Null
    'legacy stable archive' | Set-Content (Join-Path $global:zipTestRemote 'texthook.zip')
    'legacy stable manifest' | Set-Content (Join-Path $global:zipTestRemote 'texthook_manifest.json')
    $stable = New-ZipTestRelease '1.0.3'
    $latest = New-ZipTestRelease '1.0.4'
    $initial = New-ZipTestCandidate 'initial' @($stable) '1.0.3'
    $update = New-ZipTestCandidate 'update' @($stable, $latest) '1.0.3'
    & $publisher -CandidateDirectory $initial -BackupDirectory (Join-Path $zipTestRoot 'preflight')
    Assert-ZipTest ($global:zipTestWrites.Count -eq 0) 'Preflight changed remote bytes.'
    & $publisher -CandidateDirectory $initial -BackupDirectory (Join-Path $zipTestRoot 'first') -Publish -PurgeCache
    Assert-ZipTest (($global:zipTestWrites -join ',') -eq 'versions/1.0.3/texthook.zip,texthook_manifest_v2.json') 'Initial publication ordering is wrong.'
    $global:zipTestWrites.Clear()
    & $publisher -CandidateDirectory $update -BackupDirectory (Join-Path $zipTestRoot 'second') -Publish -PurgeCache
    Assert-ZipTest (($global:zipTestWrites -join ',') -eq 'versions/1.0.4/texthook.zip,texthook_manifest_v2.json') 'Existing archives were overwritten or catalog was published early.'
    $publishedHash = (Get-FileHash (Join-Path $global:zipTestRemote 'texthook_manifest_v2.json')).Hash
    $publishedCatalog = Get-Content (Join-Path $global:zipTestRemote 'texthook_manifest_v2.json') -Raw | ConvertFrom-Json
    Assert-ZipTest ($publishedCatalog.recommendedVersion -eq '1.0.3' -and $publishedCatalog.releases.Count -eq 2) 'Recommendation/retention failed.'
    Expect-ZipTestFailure { & $publisher -CandidateDirectory $initial -BackupDirectory (Join-Path $zipTestRoot 'remove-old') -Publish } 'retained unchanged'
    $global:zipTestFailManifest = $true
    Expect-ZipTestFailure { & $publisher -CandidateDirectory $update -BackupDirectory (Join-Path $zipTestRoot 'rollback') -Publish -PurgeCache } 'previous catalog is preserved'
    Assert-ZipTest ((Get-FileHash (Join-Path $global:zipTestRemote 'texthook_manifest_v2.json')).Hash -eq $publishedHash) 'Catalog rollback failed.'
    $legacy = Join-Path $zipTestRoot 'legacy'
    New-Item -ItemType Directory -Path $legacy | Out-Null
    @{version='1.0.4'} | ConvertTo-Json | Set-Content (Join-Path $legacy 'texthook_manifest.json')
    Expect-ZipTestFailure { & $publisher -CandidateDirectory $legacy -BackupDirectory (Join-Path $zipTestRoot 'legacy-attempt') -Publish } 'v2 catalog is required'
    Assert-ZipTest ((Get-Content (Join-Path $global:zipTestRemote 'texthook.zip')).Trim() -eq 'legacy stable archive') 'Legacy ZIP changed.'
    Assert-ZipTest ((Get-Content (Join-Path $global:zipTestRemote 'texthook_manifest.json')).Trim() -eq 'legacy stable manifest') 'Legacy manifest changed.'
    $global:zipTestRemote = Join-Path $zipTestRoot 'failed-first-remote'
    $global:zipTestFailManifest = $true
    Expect-ZipTestFailure { & $publisher -CandidateDirectory $initial -BackupDirectory (Join-Path $zipTestRoot 'failed-first') -Publish -PurgeCache } 'previous catalog is preserved'
    Assert-ZipTest (!(Test-Path (Join-Path $global:zipTestRemote 'texthook_manifest_v2.json'))) 'Failed first publication advertised a catalog.'
    # Even an unreferenced archive must never be overwritten with different bytes.
    'different bytes' | Set-Content (Join-Path $global:zipTestRemote 'versions/1.0.3/texthook.zip')
    Expect-ZipTestFailure { & $publisher -CandidateDirectory $initial -BackupDirectory (Join-Path $zipTestRoot 'immutable-conflict') -Publish } 'SHA-256 mismatch'
    Write-Output 'PASS: v2 preflight, multiple versions, immutable archives, catalog-last publishing, retention, rollback, and legacy protection.'
} finally {
    $env:R2_STORAGE = $zipTestOldToken
    $resolvedTestRoot = [IO.Path]::GetFullPath($zipTestRoot)
    if ([IO.Path]::GetDirectoryName($resolvedTestRoot) -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or
        ![IO.Path]::GetFileName($resolvedTestRoot).StartsWith('gsm-zip-publisher-')) { throw 'Unexpected test cleanup path.' }
    if (Test-Path -LiteralPath $resolvedTestRoot) { Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force }
}
