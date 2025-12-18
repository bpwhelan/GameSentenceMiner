param([string]$cmd)

if (-not $cmd) {
    npm run start
} else {
    switch ($cmd) {
        "sync" { uv sync; uv pip compile pyproject.toml -o requirements.lock --universal }
        "run"  { pytest }
        "add" {
            $addArgs = $cmd.Split(" ")
            if ($addArgs.Count -eq 2) {
            uv add "$($addArgs[1])"
            uv pip compile pyproject.toml -o requirements.lock --universal
            } else {
            Write-Host "Usage: add <package>"
            }
        }
        "concat" {
            python .\concat_proj.py --include "*.py" "*.ts"
        }
        default { Write-Host "Unknown command: $cmd" }
    }
}
