#!/usr/bin/env bash
# Deploy the API Worker.
#   bash scripts/bash/deploy-api.sh staging
#   bash scripts/bash/deploy-api.sh production
#
# Unlike deploy-web.sh there is NO separate build step and `--env` is correct.
# apps/web goes through the Cloudflare Vite plugin, which bakes env-resolved
# bindings into dist/server/wrangler.json and makes `--env` deploy the wrong
# ones. This Worker has no Vite in the path, so wrangler resolves env.* itself,
# the ordinary way.
set -euo pipefail

ENVIRONMENT="${1:-}"
case "$ENVIRONMENT" in
	staging) DOPPLER_CONFIG="stg"; EXPECTED_WORKER="saferate-markets-api-staging" ;;
	production) DOPPLER_CONFIG="prd"; EXPECTED_WORKER="saferate-markets-api-production" ;;
	*)
		echo "usage: $0 {staging|production}" >&2
		exit 1
		;;
esac

cd "$(dirname "$0")/../.."

export PATH="$HOME/.bun/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
# Guarded, because the source line above already is. Without this the script
# dies under `set -e` on any machine with no nvm installed — even one whose
# system node is already 22 — since `nvm` is then an undefined command rather
# than a no-op. Node 22 is still REQUIRED; it just does not have to come
# from nvm.
command -v nvm >/dev/null && nvm use 22 >/dev/null

# wrangler strips types without checking them, so this is the only gate that
# would catch a type error before it 500s at request time.
( cd apps/api && bunx wrangler types >/dev/null 2>&1 && bunx tsc --noEmit )

# Same reasoning as deploy-web.sh: Cloudflare records nothing about which commit
# a deploy came from, and the bundle is the WORKING TREE rather than HEAD, so a
# bare commit id from a dirty checkout would name code that never shipped.
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
	GIT_SHA="${GIT_SHA}-dirty"
fi
echo "Stamping version as: $GIT_SHA"

# Refuse to deploy from a checkout BEHIND origin/main, which would silently
# revert whatever landed since this branch point. FAILS CLOSED — a guard that
# green-lights on a failed fetch is worse than no guard.
if [ "${SKIP_MAIN_CHECK:-}" != "1" ]; then
	if ! git fetch origin main --quiet; then
		echo "error: could not fetch origin/main, so the stale-tree check cannot run." >&2
		echo "       Set SKIP_MAIN_CHECK=1 to deploy anyway (e.g. deliberately offline)." >&2
		exit 1
	fi
	BEHIND=$(git rev-list --count HEAD..FETCH_HEAD)
	if [ "$BEHIND" -gt 0 ]; then
		echo "error: this checkout is $BEHIND commit(s) behind origin/main." >&2
		echo "       Deploying would silently revert them. git pull --ff-only origin main" >&2
		exit 1
	fi
fi

cd apps/api
echo "Deploying $EXPECTED_WORKER ..."

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
	bunx wrangler deploy --env "$ENVIRONMENT" --message "$GIT_SHA" --tag "$ENVIRONMENT"
else
	doppler run --project saferate-markets --config "$DOPPLER_CONFIG" -- \
		bunx wrangler deploy --env "$ENVIRONMENT" --message "$GIT_SHA" --tag "$ENVIRONMENT"
fi
