#!/usr/bin/env bash
set -euo pipefail
if [[ ${GSM_TEST_XVFB:-} != 1 ]]; then
  exec xvfb-run -a dbus-run-session -- env -u WAYLAND_DISPLAY GDK_BACKEND=x11 XDG_SESSION_TYPE=x11 GSM_TEST_XVFB=1 bash "$0" "$@"
fi
openbox >/dev/null 2>&1 &
window_manager=$!
trap 'kill "$window_manager" 2>/dev/null || true' EXIT
repo_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
if [[ -d $HOME/.cache/gsm-native-node/node_modules ]]; then export GSM_NATIVE_DEPS=$HOME/.cache/gsm-native-node; fi
cd "$repo_root"
case ${1:-} in
  all) node scripts/check-native-desktop.mjs ;;
  package) shift; node scripts/test-native-package.mjs "$@" ;;
  *) node scripts/test-native-desktop.mjs "$@" ;;
esac
