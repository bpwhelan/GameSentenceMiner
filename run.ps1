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

function Start-ElevatedGsm {
    $powershellPath = (Get-Process -Id $PID).Path
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""

    try {
        Start-Process `
            -FilePath $powershellPath `
            -ArgumentList $arguments `
            -WorkingDirectory $PSScriptRoot `
            -Verb RunAs `
            -ErrorAction Stop
    } catch {
        Write-Error "Unable to start GSM as administrator: $($_.Exception.Message)"
    }
}

if (-not $cmd -or $cmd.Count -eq 0) {
    npm run start
    return
}

for ($i = 0; $i -lt $cmd.Count; $i++) {
    $action = $cmd[$i]
    Write-Output "Executing command: $action"

    switch ($action) {
        "admin" {
            Write-Host "Starting Main App as administrator..." -ForegroundColor Green
            Start-ElevatedGsm
            return
        }
        "sync" {
            Write-Host "Syncing environment..." -ForegroundColor Cyan
            uv lock --check
            uv sync --frozen --extra dev
            ~\AppData\Roaming\GameSentenceMiner\python_venv\Scripts\python.exe -m uv sync --active --frozen --no-dev --no-editable --no-install-project --inexact --project .
            ~\AppData\Roaming\GameSentenceMiner\python_venv\Scripts\python.exe -m pip check
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
                uv lock --check
                $i++
            } else {
                Write-Error "Usage: add <package>"
            }
        }
        "verify-python" {
            Write-Host "Verifying Python dependency policy and lock..." -ForegroundColor Cyan
            & ".\.venv\Scripts\python.exe" scripts/verify_python_dependency_policy.py
            & ".\.venv\Scripts\python.exe" -m uv lock --check
            & ".\.venv\Scripts\python.exe" -m pip check
        }
        "concat" {
            Write-Host "Concatenating files..." -ForegroundColor Blue
            python (Join-Path $PSScriptRoot "concat_proj.py") --include "*.py" "*.ts"
        }
        "test" {
            Write-Host "Running full pytest suite..." -ForegroundColor Cyan
            if (Test-Path ".\.venv\Scripts\python.exe") {
                & ".\.venv\Scripts\python.exe" -m pytest
            } else {
                python -m pytest
            }
            if ($LASTEXITCODE -ne 0) {
                exit $LASTEXITCODE
            }
        }
        default {
            Write-Host "Unknown command: $action" -ForegroundColor Red
        }
    }
}
