#!/usr/bin/env bash
# Typecheck everything, the way each part must be checked.
#
#   apps/web  `tsc --build`. Its tsconfig.json is a SOLUTION file (files: []), so
#             `tsc --noEmit` there checks nothing and always prints 0 errors.
#   apps/api  `tsc --noEmit`, an ordinary tsconfig.
#   scripts/  `tsc --noEmit` against the root tsconfig (paths for @markets/*).
#
# Both generators run first. Their output is gitignored, and without it a fresh
# checkout reports phantom errors that look like a broken main.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$PATH"

( cd apps/api && bunx wrangler types >/dev/null && bunx tsc --noEmit && bunx tsc --noEmit -p smoke/tsconfig.json )
echo "apps/api: ok (and smoke/)"
( cd apps/web && bunx react-router typegen >/dev/null && bunx wrangler types >/dev/null && bunx tsc --build )
echo "apps/web: ok"
bunx tsc --noEmit -p tsconfig.json
echo "scripts: ok"
