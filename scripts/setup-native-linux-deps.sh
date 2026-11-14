#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
destination=$HOME/.cache/gsm-native-node
mkdir -p "$destination"
cp "$repo_root/package.json" "$repo_root/package-lock.json" "$destination/"
cd "$destination"
npm ci --omit=dev --no-audit --no-fund
