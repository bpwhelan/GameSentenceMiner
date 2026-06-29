# generate_texthook_manifest.ps1
#
# Run this script from the repo root after restoring the texthook binaries
# (e.g. git stash pop, or copying them back from a local build).
# It computes SHA-256 hashes for every file in electron-src/assets/texthook/
# and writes the manifest.json that you upload to S3.
#
# Usage:
#   cd C:\path\to\GameSentenceMiner
#   .\scripts\generate_texthook_manifest.ps1 [-Version "1.0.1"] [-OutFile "texthook_manifest.json"]

param(
    [string]$Version = "1.0.0",
    [string]$OutFile = "texthook_manifest.json"
)

$ErrorActionPreference = "Stop"

$texthookDir = Join-Path $PSScriptRoot "..\electron-src\assets\texthook"
$texthookDir = Resolve-Path $texthookDir

$skipExtensions = @(".lib")   # linker libs — not needed at runtime

$files = Get-ChildItem -Recurse -File $texthookDir |
    Where-Object { $skipExtensions -notcontains $_.Extension }

$entries = @()
foreach ($file in $files) {
    $rel = $file.FullName.Substring($texthookDir.Path.Length).TrimStart('\', '/')
    $rel = $rel -replace '\\', '/'   # normalise to forward slashes

    $hash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower()
    $entries += [PSCustomObject]@{
        path   = $rel
        sha256 = $hash
    }
    Write-Host "  $rel  =>  $hash"
}

$manifest = [PSCustomObject]@{
    version = $Version
    files   = $entries
}

$json = $manifest | ConvertTo-Json -Depth 4
$json | Set-Content -Encoding UTF8 $OutFile

Write-Host ""
Write-Host "Manifest written to: $OutFile"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Upload $OutFile to s3://your-bucket/texthook/manifest.json (public-read)"
Write-Host "  2. Upload each file from electron-src/assets/texthook/ to s3://your-bucket/texthook/<path>"
Write-Host "     keeping the same relative directory structure."
Write-Host "  3. Verify: curl https://r2.gamesentenceminer.com/texthook/manifest.json"
