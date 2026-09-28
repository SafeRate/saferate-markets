#!/usr/bin/env bash
# Sync Doppler secrets to the Worker.
#   bash scripts/bash/secrets-web.sh staging
#   bash scripts/bash/secrets-web.sh production
#
# Secrets live in Doppler, NOT in wrangler.jsonc vars, NOT via ad-hoc
# `wrangler secret put`, and NOT in .dev.vars. To add or rotate one: set it in
# Doppler, then run this. App code should read secrets defensively so it no-ops
# when one is unset.
#
# NOT everything in Doppler belongs in the Worker runtime. Two exclusions:
#
#   CLOUDFLARE_* are DEPLOY credentials. CLOUDFLARE_API_TOKEN carries
#   Workers Scripts:Edit and D1:Edit, so shipping it into the runtime means any
#   code-execution or SSRF bug in the Worker can read a token that redeploys the
#   Worker. The saferate-ai scripts push the whole set; that is a privilege
#   escalation waiting to happen and is deliberately not copied here.
#
#   The whole PREFIX is denied rather than that one name, because on 2026-09-18 a
#   second such credential arrived as CLOUDFLARE_SERVICE_TOKEN and an exact match
#   would have shipped it. A security filter keyed to one spelling is one rename
#   from being decorative.
#
#   DOPPLER_* are Doppler's own injected metadata, not application config.
#
# Everything else goes, so a missing secret is a Doppler problem rather than a
# question of which script filtered it.
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

# Piped, never written to disk and never passed in argv.
doppler secrets download \
	--project saferate-markets --config "$DOPPLER_CONFIG" \
	--no-file --format json --no-check-version \
| node -e '
	let raw = "";
	process.stdin.on("data", (c) => { raw += c; });
	process.stdin.on("end", () => {
		const all = JSON.parse(raw);
		const out = {};
		const skipped = [];
		for (const [key, value] of Object.entries(all)) {
			// DENY THE WHOLE CLOUDFLARE_ PREFIX, not one name.
			//
			// This was an exact match on CLOUDFLARE_API_TOKEN until 2026-09-18,
			// when CLOUDFLARE_SERVICE_TOKEN appeared in all three Doppler configs
			// carrying (per its author) the roles of BOTH the deploy token and the
			// R2 SQL token. The exact match would not have caught it, so the next
			// run of this script would have pushed a deploy-capable credential into
			// the Worker runtime — exactly the escalation the comment above says
			// this filter exists to prevent, defeated by a rename.
			//
			// Nothing in the runtime of this app reads a CLOUDFLARE_* secret: the Workers
			// reach Cloudflare services through BINDINGS. So denying the prefix
			// costs nothing and fails closed for whatever the next token is called.
			if (key.startsWith("CLOUDFLARE_") || key.startsWith("DOPPLER_")) {
				skipped.push(key);
				continue;
			}
			out[key] = value;
		}
		process.stderr.write(`pushing ${Object.keys(out).length} secrets: ${Object.keys(out).sort().join(", ")}\n`);
		process.stderr.write(`withheld from runtime: ${skipped.sort().join(", ")}\n`);
		process.stdout.write(JSON.stringify(out));
	});
' \
| doppler run --project saferate-markets --config "$DOPPLER_CONFIG" --no-check-version -- \
	bunx wrangler secret bulk - --env "$ENVIRONMENT"
