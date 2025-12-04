param([string]$cmd)

if (-not $cmd) {
    npm run start
} else {
    switch ($cmd) {
        "sync" { uv sync; uv pip compile --upgrade pyproject.toml -o requirements.lock --universal }
        "run"  { pytest }
        "add" {
            $addArgs = $cmd.Split(" ")
            if ($addArgs.Count -eq 2) {
            uv add "$($addArgs[1])"
            uv pip compile --upgrade pyproject.toml -o requirements.lock --universal
            } else {
            Write-Host "Usage: add <package>"
            }
        }
        default { Write-Host "Unknown command: $cmd" }
    }
}
