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
Write-Host 'This is local package metadata, not a public update manifest.'
Write-Host 'Use scripts/prepare-texthook-catalog.mjs to add the package to a v2 catalog, then scripts/publish-lunahook-update.ps1.'
Write-Host 'Do not overwrite the legacy texthook.zip or texthook_manifest.json endpoints.'
