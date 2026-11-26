param([string]$InstallerPath, [string]$TargetVersion = '2026.11.1-preview.1')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This test installs software into a disposable Windows runner profile.'
}
$fixture = Join-Path $env:RUNNER_TEMP 'gsm-handoff'
New-Item -ItemType Directory $fixture | Out-Null
$tools = Join-Path $fixture 'tools'
npm install --prefix $tools --no-audit --no-fund playwright-core@1.55.0
$repo = 'bpwhelan/GameSentenceMiner'
$electronSetup = 'GameSentenceMiner-Setup-2026.10.2.exe'
$desktopZip = "GameSentenceMiner-$targetVersion-win-unpacked.zip"
gh release download v2026.10.2 -R $repo -p $electronSetup -D $fixture
function Assert-Digest($file, $expected) {
    if ((Get-FileHash -LiteralPath $file).Hash -ne $expected) { throw "Unexpected SHA-256 for $file" }
}
Assert-Digest (Join-Path $fixture $electronSetup) 'fe93e7f6cb84f6f6494aea9adb78ef468c6315075ac3af9d06279b1adc10760b'
$installed = Start-Process -FilePath (Join-Path $fixture $electronSetup) -ArgumentList '/S','/currentuser' -Wait -PassThru -WindowStyle Hidden
if ($installed.ExitCode -ne 0) { throw "Electron installation failed ($($installed.ExitCode))" }
$electron = Join-Path $env:LOCALAPPDATA 'Programs/gamesentenceminer/GameSentenceMiner.exe'
# These are the hashes of the executable and application archive in the source installation.
Assert-Digest $electron '9fd7e042e1f1a0118a00b74637cd8c93c6c113dca3c7b576c8a7f36e559a6b1e'
Assert-Digest (Join-Path (Split-Path $electron) 'resources/app.asar') 'b6479e79051380e3724f920a1029a4f31bc2a0b228efba9bc43f4359a6b1928c'
"GSM_E2E_VERSION=$targetVersion" >> $env:GITHUB_ENV
"GSM_E2E_ELECTRON=$electron" >> $env:GITHUB_ENV
if ($InstallerPath) {
    "GSM_E2E_INSTALLER=$((Get-Item -LiteralPath $InstallerPath).FullName)" >> $env:GITHUB_ENV
    return
}
npm install --prefix $tools --no-audit --no-fund @tauri-apps/cli@2.12.6
gh release download "v$targetVersion" -R $repo -p $desktopZip -D $fixture
Assert-Digest (Join-Path $fixture $desktopZip) '96c339c9d8a86409d7feca23d59e26eaa01224a84ab1094ba1e60bc1acae3464'
cargo build --locked -p gsm-db --bin gsm-handoff
$target = (cargo metadata --no-deps --format-version 1 | ConvertFrom-Json).target_directory
$env:GSM_HANDOFF_HELPER = Join-Path $target 'debug/gsm-handoff.exe'
$release = Join-Path $target 'release'
New-Item -ItemType Directory -Force $release | Out-Null
$stage = Join-Path $PWD 'build/native-desktop'
Expand-Archive -LiteralPath (Join-Path $fixture $desktopZip) -DestinationPath $stage
Copy-Item -LiteralPath (Join-Path $stage 'GameSentenceMiner.exe') -Destination (Join-Path $release 'gsm-desktop.exe')
# Use the published native executable/resources with the exact NSIS configuration under test.
$override = Join-Path $fixture 'version.json'
@{version=$targetVersion} | ConvertTo-Json | Set-Content $override -Encoding utf8NoBOM
node "$tools/node_modules/@tauri-apps/cli/tauri.js" bundle --ci --bundles nsis --config src-tauri/tauri.bundle.conf.json --config $override
$installer = (Get-Item "$release/bundle/nsis/*$targetVersion*x64-setup.exe").FullName
"GSM_E2E_INSTALLER=$installer" >> $env:GITHUB_ENV
