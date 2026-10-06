# Generate one ZIP and its SHA-256 manifest using the shared LunaHook packager.
# Usage: .\scripts\generate_texthook_manifest.ps1 -Version "1.0.2"
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$OutFile = "texthook_manifest.json",
    [string]$SourceDirectory = (Join-Path $PSScriptRoot "../electron-src/assets/texthook")
)

$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'generate-texthook-manifest.mjs') --source $SourceDirectory --version $Version --out-file $OutFile
if ($LASTEXITCODE -ne 0) { throw 'Text-hook ZIP generation failed.' }
Write-Host 'Upload texthook.zip first, then texthook_manifest.json, to gamesentenceminer/texthook/zip/.'
Write-Host 'Use scripts/publish-lunahook-update.ps1 to publish and verify both objects.'
