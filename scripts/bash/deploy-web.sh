#!/usr/bin/env bash
# Deploy an ALREADY-BUILT bundle.
#   bash scripts/bash/deploy-web.sh staging
#   bash scripts/bash/deploy-web.sh production
#
# Does NOT build. Run build-web.sh for the same environment first: what gets
# deployed is whatever was last built into apps/web/dist.
set -euo pipefail

ENVIRONMENT="${1:-}"
case "$ENVIRONMENT" in
	staging) DOPPLER_CONFIG="stg"; EXPECTED_WORKER="saferate-markets-web-staging" ;;
	production) DOPPLER_CONFIG="prd"; EXPECTED_WORKER="saferate-markets-web-production" ;;
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

cd apps/web

CONFIG="dist/server/wrangler.json"
if [ ! -f "$CONFIG" ]; then
	echo "error: $CONFIG not found. Run build-web.sh $ENVIRONMENT first." >&2
	exit 1
fi

# apps/web/dist is ONE directory shared by staging, production, and anyone else
# working in this checkout, so the bundle sitting there is not necessarily yours.
# Deploying a staging build to saferate.markets is a quiet, plausible mistake. Refuse
# it here rather than discover it in production.
ACTUAL_WORKER=$(node -e "console.log(require('./$CONFIG').name)")
if [ "$ACTUAL_WORKER" != "$EXPECTED_WORKER" ]; then
	echo "error: $CONFIG was built for '$ACTUAL_WORKER', not '$EXPECTED_WORKER'." >&2
	echo "       Re-run build-web.sh $ENVIRONMENT before deploying." >&2
	exit 1
fi

# The same argument as the worker-name assert above, applied to secrets. That
# check exists because this dist/ may not be yours; a bundle of unknown
# provenance is exactly the one whose client assets nobody has scanned.
#
# build-web.sh already gates on this, so in the normal flow it passes twice.
# The point is the path that SKIPS build-web.sh — a hand-run
# `bunx react-router build`, or a dist/ left behind by someone else — where the
# build-time gate never ran at all. Uploading is publishing; check before, not
# after.
#
# DOPPLER_CONFIG is passed so the exact-value tier matches THIS environment's
# secrets. Scanning a production bundle against stg values would check the
# wrong list and pass.
#
# Deliberately NOT stricter than the build gate: with no Doppler reachable it
# reports UNVERIFIED and continues, because the credential-free tier still
# catches the mechanism, and the CLOUDFLARE_API_TOKEN path below exists
# precisely for environments that have no Doppler.
echo "Checking the client bundle for leaked secrets ..."
( cd ../.. && DIST_DIR="apps/web/dist/client" DOPPLER_CONFIG="$DOPPLER_CONFIG" \
	bun scripts/verify-no-secret-leak.ts )

# Cloudflare records NOTHING about which commit a deploy came from: every row in
# `wrangler deployments list` shows an empty message, tag and author. Stamping the
# version with its commit turns "what is in production?" from an investigation
# into a lookup.
#
# The -dirty marker is not decoration. The build bundles the WORKING TREE, not
# HEAD, so a bare commit id from a dirty checkout would describe code that never
# shipped. `git status --porcelain` rather than `git diff --quiet`, so
# untracked-but-not-ignored files count too: Vite bundles an untracked source file
# if anything imports it.
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
	GIT_SHA="${GIT_SHA}-dirty"
fi
echo "Stamping version as: $GIT_SHA"

# Refuse to deploy from a checkout BEHIND origin/main, which would silently revert
# whatever landed since this branch point. A clean working tree does not answer
# this question.
#
# Fetch here, immediately, and compare against FETCH_HEAD rather than the
# origin/main tracking ref: origin/main is a LOCAL ref that only moves when
# something fetches, so reading it without fetching compares against whatever this
# checkout last happened to see and reports "0 behind" for a badly stale tree.
# FAILS CLOSED — a failed fetch exits rather than warning, because a guard that
# green-lights on failure is worse than no guard.
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

echo "Deploying $ACTUAL_WORKER ..."

# wrangler needs CLOUDFLARE_API_TOKEN, which lives in Doppler. Wrapped here so
# callers do not have to remember it, and skipped when already set so an outer
# `doppler run` and CI both still work.
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
	bunx wrangler deploy --config "$CONFIG" --message "$GIT_SHA" --tag "$ENVIRONMENT"
else
	doppler run --project saferate-markets --config "$DOPPLER_CONFIG" -- \
		bunx wrangler deploy --config "$CONFIG" --message "$GIT_SHA" --tag "$ENVIRONMENT"
fi
