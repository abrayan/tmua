#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"

tmua_python="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
if [[ ! -x "$tmua_python" ]]; then
  tmua_python="$(command -v python3 || true)"
fi
if [[ -z "$tmua_python" ]]; then
  print "Python 3 is needed to open this website. Install Python 3, then open this file again."
  read "?Press Return to close."
  exit 1
fi

if ! "$tmua_python" server.py "$@"; then
  read "?Press Return to close."
  exit 1
fi
