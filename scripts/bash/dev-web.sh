#!/usr/bin/env bash
# The site on :3020 against local bindings, config from Doppler (saferate-markets/dev).
#
# There is deliberately NO .dev.vars. OKLocate's sibling app had one that
# silently won over Doppler for server code and carried a LIVE Stripe key while
# Doppler held the sandbox one. If you find one here, delete it.
#
# CLOUDFLARE_INCLUDE_PROCESS_ENV makes the Vite plugin surface the process
# environment as the Worker's `env`. It surfaces ALL of it, so a shell variable
# sharing a binding's name will shadow the binding.
#
# Local email has no binding, so the magic link is PRINTED to this terminal.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$PATH"

if [ -f apps/web/.dev.vars ]; then
	echo "warning: apps/web/.dev.vars exists and will shadow Doppler. Delete it." >&2
fi

cd apps/web
export CLOUDFLARE_INCLUDE_PROCESS_ENV=true
exec doppler run --project saferate-markets --config dev -- bunx react-router dev
