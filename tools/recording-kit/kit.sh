#!/usr/bin/env sh
# Baton recording kit launcher for Git Bash / macOS / Linux:  ./kit.sh <command> [options]
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$HERE/node_modules/tsx/dist/cli.mjs" ]; then
  echo "Dependencies missing. Run: cd \"$HERE\" && npm install" >&2
  exit 1
fi
exec node "$HERE/node_modules/tsx/dist/cli.mjs" "$HERE/src/cli.ts" "$@"
