#!/usr/bin/env bash
# Apply migrations to the ONE local D1 both Workers share.
set -euo pipefail
cd "$(dirname "$0")/../../apps/api"
export PATH="$HOME/.bun/bin:$PATH"
bunx wrangler d1 migrations apply DB --local --persist-to ../../.wrangler/state
