#!/usr/bin/env bash
# The API Worker on :5320: local D1 and Analytics Engine, REMOTE treasury.
#
# Doppler is here for CLOUDFLARE_API_TOKEN only. This Worker has no secrets; the
# token is what lets wrangler open the `remote: true` TREASURY binding to the
# deployed treasury-api-staging. Without it wrangler refuses to start at all
# rather than skipping the binding (OKLocate measured this).
#
# NO --local: it disables every remote binding, silently. Local bindings are
# already the default without it.
#
# --persist-to is shared with apps/web (vite.config.ts), so a key minted in the
# local dashboard resolves here.
set -euo pipefail
cd "$(dirname "$0")/../../apps/api"
export PATH="$HOME/.bun/bin:$PATH"

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
	exec bunx wrangler dev --port 5320 --persist-to ../../.wrangler/state
fi
exec doppler run --project saferate-markets --config dev -- \
	bunx wrangler dev --port 5320 --persist-to ../../.wrangler/state
