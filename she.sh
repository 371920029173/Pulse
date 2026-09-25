#!/usr/bin/env sh
# SHE launcher for macOS and Linux.
#
# All logic lives in scripts/she.mjs so every platform behaves identically; this
# wrapper only exists so the project can be started with one obvious command.
#
#   ./she.sh              start (desktop window if Electron is installed)
#   ./she.sh --browser    start, but open a browser instead
#   ./she.sh stop         stop the backend and close the window
#   ./she.sh restart      stop, then start
#   ./she.sh status       report what is running
#
# Exits with the launcher's status so it composes with scripts and CI.

set -eu

# Resolve this script's directory, following symlinks, so `sh she.sh` works from
# anywhere and from a symlinked install.
SELF=$0
while [ -h "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case "$LINK" in
    /*) SELF=$LINK ;;
    *)  SELF=$(dirname "$SELF")/$LINK ;;
  esac
done
HERE=$(cd "$(dirname "$SELF")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Install Node 20+: https://nodejs.org" >&2
  exit 1
fi

exec node "$HERE/scripts/she.mjs" "$@"
