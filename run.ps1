# Use automatic $args instead of param binding
$cmd = $args

function Start-ForkedProcess {
    param($command, $directory)

    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = "cmd.exe"
    $processInfo.Arguments = "/c $command"
    if ($directory) { $processInfo.WorkingDirectory = $directory }
    $processInfo.UseShellExecute = $true

    [System.Diagnostics.Process]::Start($processInfo) | Out-Null
}

if (-not $cmd -or $cmd.Count -eq 0) {
    npm run start
    return
}

for ($i = 0; $i -lt $cmd.Count; $i++) {
    $action = $cmd[$i]
    Write-Output "Executing command: $action"

    switch ($action) {
        "sync" {
            Write-Host "Syncing environment..." -ForegroundColor Cyan
            uv sync --locked --no-dev
            ~\AppData\Roaming\GameSentenceMiner\python_venv\Scripts\python.exe -m uv sync --active --locked --no-dev --no-install-project --inexact --project .
        }
        "gsm" {
            Write-Host "Forking Main App..." -ForegroundColor Green
            Start-ForkedProcess -command "npm run start"
        }
        "overlay" {
            Write-Host "Forking Overlay..." -ForegroundColor Magenta
            Start-ForkedProcess -command "npm run start" -directory "./GSM_Overlay"
        }
        "add" {
            if ($i + 1 -lt $cmd.Count) {
                $package = $cmd[$i + 1]
                Write-Host "Adding package: $package" -ForegroundColor Yellow
                uv add "$package"
                Write-Host "Lockfiles are generated in CI. Run uv lock locally only if you need to test lock changes." -ForegroundColor DarkYellow
                $i++
            } else {
                Write-Error "Usage: add <package>"
            }
        }
        "manifest" {
            Write-Host "Generating runtime lock manifest..." -ForegroundColor Cyan
            python scripts/generate_runtime_lock_manifest.py --lock uv.lock --pyproject pyproject.toml --output runtime-lock-manifest.json --uv-version 0.9.22
        }
        "concat" {
            Write-Host "Concatenating files..." -ForegroundColor Blue
            python .\concat_proj.py --include "*.py" "*.ts"
        }
        default {
            Write-Host "Unknown command: $action" -ForegroundColor Red
        }
    }
}
