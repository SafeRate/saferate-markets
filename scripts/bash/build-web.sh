#!/usr/bin/env bash
# Build the web bundle for a named environment.
#   bash scripts/bash/build-web.sh staging
#   bash scripts/bash/build-web.sh production
#
# Sets CLOUDFLARE_ENV, which the Cloudflare Vite plugin needs at BUILD time to
# bake the right bindings into dist/server/wrangler.json. A bare
# `bunx react-router build` produces a bundle carrying local-dev bindings.
#
# DIFFERENT FROM OKLOCATE, on purpose: no secrets are exported to the build at
# all. OKLocate exports every Doppler secret as VITE_<KEY>, which is the prefix
# Vite hands to CLIENT code, and then scans the bundle to prove none leaked.
# Nothing in this app's client needs configuration, so the mechanism is not
# copied and the scan below runs against an input that cannot contain a secret.
# If a client value is ever needed, add that ONE name, not the whole config.
set -euo pipefail

ENVIRONMENT="${1:-}"
case "$ENVIRONMENT" in
	staging) DOPPLER_CONFIG="stg" ;;
	production) DOPPLER_CONFIG="prd" ;;
	*)
		echo "usage: $0 {staging|production}" >&2
		exit 1
		;;
esac

cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$PATH"

cd apps/web
echo "Building for $ENVIRONMENT ..."
CLOUDFLARE_ENV="$ENVIRONMENT" bunx react-router build

BUILT_NAME=$(node -e "console.log(require('./dist/server/wrangler.json').name)")
echo "Built worker: $BUILT_NAME"

echo "Checking the client bundle for leaked secrets ..."
cd ../..
DIST_DIR="apps/web/dist/client" DOPPLER_CONFIG="$DOPPLER_CONFIG" \
	bun scripts/verify-no-secret-leak.ts
