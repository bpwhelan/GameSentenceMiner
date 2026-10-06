# Uses R2_STORAGE in memory only. Default mode validates and backs up without publishing.
param(
    [Parameter(Mandatory = $true)][string]$CandidateDirectory,
    [Parameter(Mandatory = $true)][string]$BackupDirectory,
    [switch]$Publish,
    [switch]$PurgeCache
)

$ErrorActionPreference = 'Stop'
$accountId = 'eb6f3aaa8492feed2490ff04c24c21a1'
$zoneId = 'db893888235dcd57e2e13f23786c08f2'
$publicBase = 'https://r2.gamesentenceminer.com/texthook/zip'
$remote = 'GSMR2:gamesentenceminer/texthook/zip'
$manifestName = 'texthook_manifest.json'
$archiveName = 'texthook.zip'
$utf8 = [Text.UTF8Encoding]::new($false)

function Read-Manifest([string]$File) {
    $manifest = Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
    if (!$manifest.version -or !$manifest.files -or $manifest.files.Count -eq 0) { throw 'Invalid engine manifest.' }
    if ($manifest.archive.path -cne $archiveName -or $manifest.archive.sha256 -notmatch '^[a-f0-9]{64}$') {
        throw 'Invalid ZIP archive metadata.'
    }
    $seen = @{}
    foreach ($entry in $manifest.files) {
        $relative = [string]$entry.path
        if ($relative -notmatch '^[\w.-]+(?:/[\w.-]+)*$' -or
            @($relative.Split('/') | Where-Object { $_ -eq '.' -or $_ -eq '..' -or $_.EndsWith('.') }).Count -gt 0 -or
            $relative -notmatch '^(NOTICE\.md|(?:luna_builds|textractor_builds)/.+)$' -or $seen.ContainsKey($relative.ToLowerInvariant()) -or
            $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw "Invalid manifest entry: $relative" }
        $seen[$relative.ToLowerInvariant()] = $true
    }
    return $manifest
}

function Assert-Hashes($Manifest, [string]$Directory) {
    $archivePath = Join-Path $Directory $archiveName
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Manifest.archive.sha256) {
        throw 'ZIP SHA-256 mismatch.'
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        if ($zip.Entries.Count -ne $Manifest.files.Count) { throw 'ZIP contents do not match the manifest.' }
        foreach ($entry in $Manifest.files) {
            $member = $zip.GetEntry($entry.path)
            if (!$member) { throw "Missing ZIP entry: $($entry.path)" }
            if ((($member.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'ZIP symlinks are not allowed.' }
            $stream = $member.Open()
            $hasher = [Security.Cryptography.SHA256]::Create()
            try { $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
            finally { $hasher.Dispose(); $stream.Dispose() }
            if ($actual -ne $entry.sha256) { throw "SHA-256 mismatch: $($entry.path)" }
        }
    } finally {
        $zip.Dispose()
    }
}

function Invoke-Rclone([string[]]$Arguments) {
    & rclone @Arguments --config NUL --s3-no-check-bucket --retries 2 --low-level-retries 2 --contimeout 15s --timeout 60s
    if ($LASTEXITCODE -ne 0) { throw "R2 transfer failed (rclone exit $LASTEXITCODE)." }
}

function Assert-PublicFile([string]$Relative, [string]$Hash, [string]$Directory) {
    $destination = Join-Path $Directory $Relative
    New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            # Use the exact public URL GSM downloads, without a cache-busting query.
            $response = Invoke-WebRequest -Uri "$publicBase/$Relative" -OutFile $destination -PassThru -UseBasicParsing -TimeoutSec 30
            $actualHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -eq $Hash) { return }
            [IO.File]::WriteAllText((Join-Path $Directory 'public-mismatch.json'), ([ordered]@{
                path = $Relative; expectedSha256 = $Hash; actualSha256 = $actualHash
                cacheStatus = $response.Headers['CF-Cache-Status']; cacheControl = $response.Headers['Cache-Control']
                age = $response.Headers['Age']; etag = $response.Headers['ETag']
            } | ConvertTo-Json -Depth 3), $utf8)
        } catch {
            if ($attempt -eq 3) { throw "Public download failed: $Relative" }
        }
        if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
    }
    throw "Public SHA-256 mismatch after three attempts: $Relative"
}

function Clear-PublicCache([string[]]$Paths) {
    if (!$PurgeCache) { return }
    $urls = @($Paths | ForEach-Object { "$publicBase/$_" })
    # Purge only this payload, never the whole zone or bucket.
    for ($offset = 0; $offset -lt $urls.Count; $offset += 30) {
        $last = [Math]::Min($offset + 29, $urls.Count - 1)
        $body = @{files=@($urls[$offset..$last])} | ConvertTo-Json
        try {
            $purge = Invoke-RestMethod -Method Post -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/purge_cache" -Headers @{Authorization="Bearer $token"} -ContentType 'application/json' -Body $body -TimeoutSec 25
            if (!$purge.success) { throw 'Purge was not successful.' }
        } catch { throw 'Cloudflare cache purge failed. R2_STORAGE needs Zone Cache Purge for gamesentenceminer.com, or clear the listed URLs manually and omit -PurgeCache.' }
    }
}

$candidate = (Resolve-Path -LiteralPath $CandidateDirectory).Path
$backup = [IO.Path]::GetFullPath($BackupDirectory)
if (Test-Path -LiteralPath $backup) { throw 'Use a fresh backup directory; existing rollback copies must be preserved.' }
$candidateManifestPath = Join-Path $candidate $manifestName
$manifest = Read-Manifest $candidateManifestPath
Assert-Hashes $manifest $candidate
Get-Command rclone -ErrorAction Stop | Out-Null

$token = $null
foreach ($scope in @('Process', 'User', 'Machine')) {
    $token = [Environment]::GetEnvironmentVariable('R2_STORAGE', $scope)
    if (![string]::IsNullOrWhiteSpace($token)) { break }
}
if ([string]::IsNullOrWhiteSpace($token)) { throw 'R2_STORAGE is missing from Process, User, and Machine environments.' }
$verified = $null
foreach ($verifyPath in @('user/tokens/verify', "accounts/$accountId/tokens/verify")) {
    try {
        $result = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/$verifyPath" -Headers @{Authorization="Bearer $token"} -TimeoutSec 25
        if ($result.success -and $result.result.status -eq 'active' -and $result.result.id -match '^[a-f0-9]{32}$') {
            $verified = $result.result
            break
        }
    } catch { } # Do not echo credential-bearing request diagnostics.
}
if (!$verified) { throw 'R2_STORAGE did not verify as an active Cloudflare API token.' }
$hasher = [Security.Cryptography.SHA256]::Create()
try { $secret = [BitConverter]::ToString($hasher.ComputeHash($utf8.GetBytes($token))).Replace('-', '').ToLowerInvariant() }
finally { $hasher.Dispose() }
$environment = @{
    RCLONE_CONFIG_GSMR2_TYPE = 's3'
    RCLONE_CONFIG_GSMR2_PROVIDER = 'Cloudflare'
    RCLONE_CONFIG_GSMR2_ACCESS_KEY_ID = $verified.id
    RCLONE_CONFIG_GSMR2_SECRET_ACCESS_KEY = $secret
    RCLONE_CONFIG_GSMR2_ENDPOINT = "https://$accountId.r2.cloudflarestorage.com"
    RCLONE_CONFIG_GSMR2_REGION = 'auto'
}
$oldEnvironment = @{}
foreach ($name in $environment.Keys) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process')
}

try {
    $previousDirectory = Join-Path $backup 'previous'
    New-Item -ItemType Directory -Path $previousDirectory -Force | Out-Null
    $previousManifestPath = Join-Path $previousDirectory $manifestName
    # List from the existing parent prefix so an empty zip/ directory is a valid first publication.
    $published = @(Invoke-Rclone @('lsf', 'GSMR2:gamesentenceminer/texthook', '--recursive', '--files-only', '--include', '/zip/texthook_manifest.json'))
    $previous = $null
    if ($published -contains "zip/$manifestName") {
        Invoke-Rclone @('copyto', "$remote/$manifestName", $previousManifestPath)
        $previous = Read-Manifest $previousManifestPath
        if ($previous.version -eq $manifest.version) { throw 'The manifest version is already published. Verify it instead of reusing a version for changed bytes.' }
        Invoke-Rclone @('copyto', "$remote/$archiveName", (Join-Path $previousDirectory $archiveName))
        Assert-Hashes $previous $previousDirectory
        Write-Output "Verified rollback copy of v$($previous.version) at $previousDirectory"
    } else {
        Write-Output 'First ZIP publication: no previous manifest at texthook/zip/.'
    }
    if (!$Publish) {
        Write-Output "Preflight passed for v$($manifest.version) ($($manifest.files.Count) files). No remote files changed. Use -Publish and a fresh backup directory to upload."
        return
    }

    $uploadOptions = @('--metadata', '--metadata-set', 'cache-control=public, max-age=0, must-revalidate')
    # With -PurgeCache, prove permission before changing any object bytes.
    Clear-PublicCache @($archiveName, $manifestName)
    $manifestUploadAttempted = $false
    try {
        Invoke-Rclone (@('copyto', (Join-Path $candidate $archiveName), "$remote/$archiveName", '--ignore-times') + $uploadOptions)
        $originCheck = Join-Path $backup 'origin-verification'
        Invoke-Rclone @('copyto', "$remote/$archiveName", (Join-Path $originCheck $archiveName))
        Assert-Hashes $manifest $originCheck
        Clear-PublicCache @($archiveName)
        $publicCheck = Join-Path $backup 'public-verification'
        Assert-PublicFile $archiveName $manifest.archive.sha256 $publicCheck
        # Only advertise the version after the ZIP is publicly verified.
        $manifestUploadAttempted = $true
        Invoke-Rclone (@('copyto', $candidateManifestPath, "$remote/$manifestName", '--ignore-times') + $uploadOptions)
        Clear-PublicCache @($manifestName)
        $manifestHash = (Get-FileHash -LiteralPath $candidateManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        Assert-PublicFile $manifestName $manifestHash $publicCheck
        Assert-PublicFile $archiveName $manifest.archive.sha256 $publicCheck
    } catch {
        $publishFailure = $_.Exception.Message
        if (!$previous) {
            if ($manifestUploadAttempted) {
                Invoke-Rclone @('deletefile', "$remote/$manifestName")
                Clear-PublicCache @($manifestName)
            }
            throw "First ZIP publication failed; no version is advertised. Preserve $backup before retrying. $publishFailure"
        }
        Write-Warning 'Publication failed; restoring the previous verified payload and manifest.'
        try {
            Invoke-Rclone (@('copyto', (Join-Path $previousDirectory $archiveName), "$remote/$archiveName", '--ignore-times') + $uploadOptions)
            Invoke-Rclone (@('copyto', $previousManifestPath, "$remote/$manifestName", '--ignore-times') + $uploadOptions)
            Clear-PublicCache @($archiveName, $manifestName)
            Assert-PublicFile $archiveName $previous.archive.sha256 (Join-Path $backup 'rollback-verification')
            $oldManifestHash = (Get-FileHash -LiteralPath $previousManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
            Assert-PublicFile $manifestName $oldManifestHash (Join-Path $backup 'rollback-verification')
        } catch { throw "Publication failed and rollback is unverified. Preserve $backup and inspect R2 before retrying." }
        throw "Publication failed; previous version restored and publicly verified. $publishFailure"
    }
    $report = [ordered]@{
        version = $manifest.version
        previousVersion = $previous.version
        filesVerified = $manifest.files.Count
        originFilesVerified = $manifest.files.Count
        cachePurged = [bool]$PurgeCache
        manifestUrl = "$publicBase/$manifestName"
        manifestSha256 = $manifestHash
        archiveUrl = "$publicBase/$archiveName"
        archiveSha256 = $manifest.archive.sha256
        backup = $previousDirectory
        publishedAt = [DateTime]::UtcNow.ToString('o')
    }
    [IO.File]::WriteAllText((Join-Path $backup 'publication.json'), ($report | ConvertTo-Json), $utf8)
    Write-Output "Published and publicly verified v$($manifest.version): one ZIP ($($manifest.files.Count) runtime files) and one manifest."
} finally {
    foreach ($name in $environment.Keys) { [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process') }
    $token = $null
    $secret = $null
}
