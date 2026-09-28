# Safe Rate Markets

The institutional portal for Safe Rate's U.S. Treasury data: a REST API and an
MCP server behind one API key, with sign-in, key management and (soon) billing.
Cloudflare Workers, React Router v7, Hono, Bun.

Built 2026-09-28 from the saferate-oklocate blueprint. **OKLocate's CLAUDE.md
(`~/coding/saferate-oklocate/CLAUDE.md`) is the authority on every pattern ported
here**: key rotation, the D1 adapter, the email guard, the Env type trap, the
deploy scripts. Read its section before changing one of those here.

## Environments

| App | Environment | Host | Worker | Doppler |
|---|---|---|---|---|
| web | production | saferate.markets | `saferate-markets-web-production` | `prd` |
| web | staging | staging.saferate.markets | `saferate-markets-web-staging` | `stg` |
| web | dev | localhost:3020 | — | `dev` |
| api | production | api.saferate.markets | `saferate-markets-api-production` | `prd` |
| api | staging | api-staging.saferate.markets | `saferate-markets-api-staging` | `stg` |
| api | dev | localhost:5320 | — | `dev` (for the Cloudflare token only) |

Account `5056399ef6d173a029f7e355967e7b23` (Safe Rate). Hostnames live in
`packages/schema/src/site.ts` and nowhere else. `www.saferate.markets`,
`saferate.market`, `www.saferate.market` and `markets.saferate.com` are claimed
by the production web Worker and 301 to `saferate.markets`.

**Why saferate.markets and not markets.saferate.com** (decided 2026-09-28): every
name is one level deep, so the free universal certificate covers it (two-level
names like `api.markets.saferate.com` serve no valid certificate), and the
portal's cookies are isolated from everything on saferate.com.

Mail sends from `noreply@notifications.saferate.markets` (Cloudflare Email
Service). A new sending domain has no reputation: check spam before debugging a
magic link.

## Layout

```
apps/api                 Hono. /v1/* REST, /mcp, /openapi.json, /reference. NO secrets.
apps/web                 React Router. Sign-in, dashboard, docs. Sessions live here only.
packages/schema          Hosts, plans, rate limit. The single source; no page asserts a fact it does not read from here.
packages/persistence     Migrations, API keys, usage.
packages/email           Provider seam + non-production allowlist guard.
packages/mcp-tools       The Treasury MCP tools. THE AUTHORITY: mcp.saferate.com should register a subset of these.
packages/treasury-client VENDORED from saferate-treasury. Never edit by hand.
```

## Commands

```bash
bun install
bash scripts/bash/migrate-local.sh     # the ONE local D1 both Workers share
bash scripts/bash/dev-api.sh           # :5320, needs CLOUDFLARE_API_TOKEN (remote TREASURY binding)
bash scripts/bash/dev-web.sh           # :3020, magic link is PRINTED to this terminal
bash scripts/bash/typecheck.sh         # both Workers, the way each must be checked
bun test                               # 188 tests at 2026-09-28
bunx biome check .
bash scripts/bash/sync-treasury-client.sh <ref>   # re-vendor the client
```

`apps/web` typechecks with `tsc --build`. Its tsconfig.json is a solution file,
so `tsc --noEmit` there checks nothing and prints 0 errors. `apps/api` is an
ordinary `tsc --noEmit`. `typecheck.sh` runs both generators first; without them
a fresh checkout shows phantom errors.

## Rules carried over, each of which cost OKLocate real time

- **better-auth and @modelcontextprotocol/server are pinned EXACTLY.** A caret on
  better-auth 500ed every magic link in a sibling app for ~18 hours. The MCP SDK's
  published types are minified aliases, so a patch release can move them.
- **Secrets are Doppler, project `saferate-markets`.** Not wrangler `vars`, not
  `wrangler secret put`, not `.dev.vars` (delete one on sight). `secrets-web.sh`
  withholds the whole `CLOUDFLARE_` prefix from the runtime, so a bug in the
  Worker cannot read a token that redeploys it.
- **`build-web.sh` exports NO secrets to Vite.** OKLocate exports all of them as
  `VITE_*` and scans for leaks; nothing here needs client config, so the
  mechanism is not copied. The scan still runs.
- **Deploy web with `--config dist/server/wrangler.json`, API with `--env`.** Not
  interchangeable. Both deploy scripts refuse a checkout behind origin/main. Deploy
  and verify are separate steps: never build, deploy and curl in one block.
- **Worker secrets augment BOTH `Env` interfaces** (`app/types/env-secrets.d.ts`).
- **Rotation is not create-plus-revoke.** `revokedAt` kills now; `expiresAt` ends a
  7-day grace. Both in `authenticateApiKey`'s WHERE clause. Verified locally
  2026-09-28: after rotate both keys 200; revoking the old one mid-grace 401s it
  at once while the new one keeps working.
- **No test keys, and no `modeApiKey` column,** until test keys have their own
  data path. OKLocate's column promised isolation nothing enforced for months.
- **The dashboard honesty rule.** A number is real or explicitly absent. Usage is
  measured from the first request, so a zero is a real zero; billing is not
  built, so the plan says so.
- **An absence must say why.** The treasury client returns null for BOTH "no
  binding" and "no curve that day"; the API checks the binding first and 503s,
  so a misconfiguration can never read as a weekend.

## Decisions (2026-09-28, with Dylan)

- One paid plan, **$10/month**, one subscription per organization, **single
  seat** (enforced by unique indexes in migration 0001).
- **Beta = a 100%-off promotion code on that plan**, no card collected. When the
  discount ends, access lapses until a card is added; build the warning email and
  banner with billing.
- **No quota; rate-limited** (60/min per organization proposed, REST + MCP
  together, Cloudflare rate-limit binding, approximate). Not enforced yet.
- **Licence tiers by who sees the data:** internal use and client reporting are
  the $10 plan; public display or inside another product is Redistribution;
  inside a financial product is a Benchmark licence. The last two are
  contact-us, to team@saferate.com. Counsel writes the actual terms.
- **MCP auth is the API key** for now. OAuth for claude.ai / Desktop later,
  targeting Client ID Metadata Documents, not DCR.

## The treasury client is vendored, and why

Bun 1.4 turns every GitHub git dependency into an unauthenticated tarball fetch
(404 on a private repo) and cannot install a subdirectory. So
`sync-treasury-client.sh` copies `packages/client` from saferate-treasury at a
pinned commit, recorded in `packages/treasury-client/VENDORED`. saferate-treasury's
`clientContract.ts` fails tsc there when the client stops matching TreasuryService,
so the copy at commit X matches treasury-api at X. It says nothing about what is
DEPLOYED; that is what the client's optional methods are for.

Vendored at `276a2b6` (the `treasury-client` branch, saferate-treasury PR #2).
**Re-sync from `main` once that PR merges.**

## Not built yet, in order

1. **Entitlement.** `authenticateApiKey` accepts any key of any organization.
   Billing must add the subscription join BEFORE production takes traffic.
2. Billing: migration 0002, `@better-auth/stripe` 1.7.1 exact, a restricted
   `rk_live_` key, prices seeded from `PLANS` by lookup key, the Beta coupon,
   OKLocate's guard against moving a lookup key off a price with subscribers.
3. Rate limiting, a usage page, the contact-us enquiry form (stored in D1 as well
   as emailed, so a bounce loses nothing).
4. More REST routes. `/v1/curves/zero` is the only one; each new route needs its
   response schema pinned by a test against the client's real parse, as
   `apps/api/tests/api.test.ts` does for this one.
5. Deploy: create the two D1 databases (the `REPLACE_AT_FIRST_DEPLOY` ids),
   Doppler `stg`/`prd` secrets, then staging end to end.

## Known issue upstream

**`treasury-api-staging` is stale.** Its healthcheck on 2026-09-28 reported
`mostRecentCurveDate: 2026-09-09` against production's 2026-09-25, and it lacks
the index and analytics fields production reports, so it is also an older deploy.
Local dev and markets staging read it, so their "latest" curve is 19 days old.
Decide before staging goes to anyone outside: refresh it, or bind markets
staging to production treasury-api (the RPC is read-only).
