#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$HOME/.cache/gsm-tauri-target}
cargo build --manifest-path "$repo_root/src-tauri/Cargo.toml" "$@"
