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
$manifestName = 'texthook_manifest_v2.json'
$utf8 = [Text.UTF8Encoding]::new($false)

function Assert-Release($manifest) {
    if (!$manifest.version -or !$manifest.files -or $manifest.files.Count -eq 0) { throw 'Invalid engine manifest.' }
    if ($manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or
        $manifest.archive.path -cne "versions/$($manifest.version)/texthook.zip" -or $manifest.archive.sha256 -notmatch '^[a-f0-9]{64}$') {
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
}

function Read-Catalog([string]$File) {
    if (!(Test-Path -LiteralPath $File)) { throw 'A v2 catalog is required. Legacy manifests and ZIP endpoints must not be overwritten.' }
    $catalog = Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
    if ($catalog.schemaVersion -ne 2 -or !$catalog.releases -or !$catalog.recommendedVersion) { throw 'Invalid v2 catalog.' }
    $seen = @{}
    foreach ($release in $catalog.releases) {
        Assert-Release $release
        if ($seen.ContainsKey($release.version)) { throw 'Duplicate catalog version.' }
        $seen[$release.version] = $true
    }
    if (!$seen.ContainsKey($catalog.recommendedVersion)) { throw 'Recommended version is missing.' }
    return $catalog
}

function Assert-Hashes($Manifest, [string]$Directory) {
    $archivePath = Join-Path $Directory $Manifest.archive.path
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
$catalog = Read-Catalog $candidateManifestPath
foreach ($release in $catalog.releases) {
    if (Test-Path -LiteralPath (Join-Path $candidate $release.archive.path)) { Assert-Hashes $release $candidate }
}
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
    $published = @(Invoke-Rclone @('lsf', 'GSMR2:gamesentenceminer/texthook', '--recursive', '--files-only', '--include', '/zip/**'))
    $previous = $null
    $previousHash = $null
    if ($published -contains "zip/$manifestName") {
        Invoke-Rclone @('copyto', "$remote/$manifestName", $previousManifestPath)
        $previous = Read-Catalog $previousManifestPath
        $previousHash = (Get-FileHash -LiteralPath $previousManifestPath).Hash
        foreach ($release in $previous.releases) {
            $replacement = @($catalog.releases | Where-Object { $_.version -ceq $release.version })
            if ($replacement.Count -ne 1 -or
                ($replacement[0] | ConvertTo-Json -Depth 20 -Compress) -cne ($release | ConvertTo-Json -Depth 20 -Compress)) {
                throw "Existing version $($release.version) must be retained unchanged."
            }
            $destination = Join-Path $previousDirectory $release.archive.path
            New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
            Invoke-Rclone @('copyto', "$remote/$($release.archive.path)", $destination)
            Assert-Hashes $release $previousDirectory
        }
        Write-Output "Backed up and verified $($previous.releases.Count) existing catalog versions."
    }
    # A failed earlier upload may have left an unreferenced ZIP. Reuse it only
    # when every byte matches; never overwrite a path with different contents.
    $existingArchives = @{}
    foreach ($release in $catalog.releases) {
        $relative = $release.archive.path
        if ($published -contains "zip/$relative") {
            $check = Join-Path $backup 'existing-archives'
            $destination = Join-Path $check $relative
            New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
            Invoke-Rclone @('copyto', "$remote/$relative", $destination)
            Assert-Hashes $release $check
            $existingArchives[$relative] = $true
        } elseif (!(Test-Path -LiteralPath (Join-Path $candidate $relative))) {
            throw "Missing candidate archive: $relative"
        }
    }
    if (!$Publish) {
        Write-Output "V2 preflight passed: $($catalog.releases.Count) versions, recommended $($catalog.recommendedVersion). No remote files changed."
        return
    }
    $catalogOptions = @('--metadata', '--metadata-set', 'cache-control=public, max-age=0, must-revalidate')
    $archiveOptions = @('--immutable', '--metadata', '--metadata-set', 'cache-control=public, max-age=31536000, immutable')
    $paths = @($catalog.releases | ForEach-Object { $_.archive.path }) + @($manifestName)
    Clear-PublicCache $paths
    $manifestUploadAttempted = $false
    try {
        foreach ($release in $catalog.releases) {
            $relative = $release.archive.path
            if (!$existingArchives.ContainsKey($relative)) {
                Invoke-Rclone (@('copyto', (Join-Path $candidate $relative), "$remote/$relative") + $archiveOptions)
            }
            $originCheck = Join-Path $backup 'origin-verification'
            $destination = Join-Path $originCheck $relative
            New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
            Invoke-Rclone @('copyto', "$remote/$relative", $destination)
            Assert-Hashes $release $originCheck
            Clear-PublicCache @($relative)
            Assert-PublicFile $relative $release.archive.sha256 (Join-Path $backup 'public-verification')
        }
        # Detect another publisher before replacing the catalog; retained ZIPs
        # make an older in-flight catalog safe throughout publication.
        $currentObjects = @(Invoke-Rclone @('lsf', 'GSMR2:gamesentenceminer/texthook', '--recursive', '--files-only', '--include', '/zip/**'))
        if ($currentObjects -contains "zip/$manifestName") {
            $currentPath = Join-Path $backup 'catalog-before-commit.json'
            Invoke-Rclone @('copyto', "$remote/$manifestName", $currentPath)
            if (!$previousHash -or (Get-FileHash -LiteralPath $currentPath).Hash -ne $previousHash) {
                throw 'The catalog changed during publication. Run again with a fresh backup and catalog.'
            }
        } elseif ($previous) { throw 'The catalog disappeared during publication.' }
        # Advertise releases only after every archive is publicly verified.
        $manifestUploadAttempted = $true
        Invoke-Rclone (@('copyto', $candidateManifestPath, "$remote/$manifestName", '--ignore-times') + $catalogOptions)
        Clear-PublicCache @($manifestName)
        $manifestHash = (Get-FileHash -LiteralPath $candidateManifestPath).Hash.ToLowerInvariant()
        Assert-PublicFile $manifestName $manifestHash (Join-Path $backup 'public-verification')
    } catch {
        $publishFailure = $_.Exception.Message
        if ($manifestUploadAttempted) {
            try {
                if ($previous) {
                    Invoke-Rclone (@('copyto', $previousManifestPath, "$remote/$manifestName", '--ignore-times') + $catalogOptions)
                    Clear-PublicCache @($manifestName)
                    Assert-PublicFile $manifestName $previousHash.ToLowerInvariant() (Join-Path $backup 'rollback-verification')
                } else {
                    Invoke-Rclone @('deletefile', "$remote/$manifestName")
                    Clear-PublicCache @($manifestName)
                }
            } catch { throw "Publication failed and catalog rollback is unverified. Preserve $backup and inspect R2." }
        }
        throw "V2 publication failed; the previous catalog is preserved. Immutable archives are retained. $publishFailure"
    }
    $report = [ordered]@{
        schemaVersion = 2
        recommendedVersion = $catalog.recommendedVersion
        versions = @($catalog.releases | ForEach-Object { $_.version })
        filesVerified = ($catalog.releases | ForEach-Object { $_.files.Count } | Measure-Object -Sum).Sum
        cachePurged = [bool]$PurgeCache
        manifestUrl = "$publicBase/$manifestName"
        manifestSha256 = $manifestHash
        archives = @($catalog.releases | ForEach-Object { @{url="$publicBase/$($_.archive.path)"; sha256=$_.archive.sha256} })
        backup = $previousDirectory
        publishedAt = [DateTime]::UtcNow.ToString('o')
    }
    [IO.File]::WriteAllText((Join-Path $backup 'publication.json'), ($report | ConvertTo-Json -Depth 8), $utf8)
    Write-Output "Published and publicly verified v2 catalog: $($catalog.releases.Count) versions; recommended $($catalog.recommendedVersion). Legacy objects were not changed."
} finally {
    foreach ($name in $environment.Keys) { [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process') }
    $token = $null
    $secret = $null
}
