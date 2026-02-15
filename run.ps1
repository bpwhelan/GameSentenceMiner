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
            uv sync
            uv pip compile pyproject.toml -o requirements.lock --universal
            ~\AppData\Roaming\GameSentenceMiner\python_venv\Scripts\python.exe -m uv pip sync requirements.lock
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
                uv pip compile pyproject.toml -o requirements.lock --universal
                $i++
            } else {
                Write-Error "Usage: add <package>"
            }
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
