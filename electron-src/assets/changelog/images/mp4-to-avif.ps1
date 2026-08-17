$ErrorActionPreference = 'Stop'

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    throw 'ffmpeg was not found on PATH.'
}

$inputFiles = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.mp4' -File -Recurse)
if ($inputFiles.Count -eq 0) {
    Write-Host "No MP4 files found under $PSScriptRoot"
    exit 0
}

foreach ($inputFile in $inputFiles) {
    $outputPath = [System.IO.Path]::ChangeExtension($inputFile.FullName, '.avif')
    Write-Host "Converting $($inputFile.FullName) to $outputPath"

    & ffmpeg -y -hide_banner -i $inputFile.FullName -c:v libsvtav1 -crf 30 -preset 8 -an -f avif $outputPath
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
