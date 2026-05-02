#!/usr/bin/env sh
set -eu

LIBSTDCPP_PATH="$(find /nix/store -name libstdc++.so.6 | head -n 1 || true)"
if [ -n "$LIBSTDCPP_PATH" ]; then
  LIBSTDCPP_DIR="$(dirname "$LIBSTDCPP_PATH")"
  export LD_LIBRARY_PATH="${LIBSTDCPP_DIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

export PATH="/opt/venv/bin:$PATH"
exec pnpm --filter backend start:prod
