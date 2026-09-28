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

## Look: the saferate.com brand, not OKLocate's

Decided 2026-09-28: Markets is part of the Safe Rate brand; OKLocate is a
separate one. Tokens (indigo `#4F46E5` primary, slate neutrals, 0.625rem
radius), the TT Norms font, the logo SVG and the header/footer shape are copied
from `saferate-ai/apps/consumer` @ 48da6e68. Change them there first, then copy.
Light only, as saferate.com is.

TT Norms is a commercial font. Dylan confirmed 2026-09-28 that Safe Rate's
licence covers saferate.markets.

## Production: live since 2026-09-28 (`0ca0fb9`)

D1 `saferate-markets-production` (27098990…), migrations 0001 and 0002. Both
Workers deployed; the web Worker claims saferate.markets plus the four redirect
hosts, all verified 301 with path and query kept. Verified: /health, /v1 401
without a key, generated spec with production servers, unsigned webhook 400,
webhook signed with the prd secret 200, docs render in a browser pointing at
api.saferate.markets. Still `noindex` everywhere by design until launch.

Right after the first deploy the new names did not resolve on the dev machine
for a while (a cached NXDOMAIN from checking them before they existed) while
1.1.1.1 already answered. Check with `dig @1.1.1.1` before suspecting a deploy.

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
bun test                               # 229 tests at 2026-09-28
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

## Stripe — which account each config reaches (checked 2026-09-28)

| Doppler | `STRIPE_SECRET_KEY` | Account |
|---|---|---|
| `dev`, `stg` | `sk_test_…` (one key, both configs) | sandbox `acct_1UKir45aTiygYfqn`, created for Markets |
| `prd` | `rk_live_…` restricted, 9 Write scopes | Safe Rate Inc. `acct_1E3lnOG4qd65Lvbd`, LIVE, shared with saferate-ai and OKLocate |

Checked by reading, not by trusting the prefix: the sandbox key answers
`/v1/account` with that id; the live key is (correctly) refused `/v1/account`
and was identified by the `G4qd65Lvbd` fragment in the price ids it can list.
It can see OKLocate's prices, so every lookup key here is prefixed `markets_`.

dev and stg first held three different `rk_live_` keys, created without test
mode on. They were replaced the same day. Target an account with the key in
Doppler, never with the Stripe CLI's remembered profile (OKLocate: two accounts
were both called "oklocate" and the CLI's was the wrong one).

## Decisions (2026-09-28, with Dylan)

- One paid plan, **$10/month**, one subscription per organization, **single
  seat** (enforced by unique indexes in migration 0001).
- **Beta = a 100%-off promotion code on that plan**, no card collected. When the
  discount ends, access lapses until a card is added; build the warning email and
  banner with billing.
- **No quota; rate-limited at 60/min per organization** (confirmed), REST and
  MCP together, keyed on the organization so more keys do not mean more
  allowance. Cloudflare's rate-limit binding; the number is in wrangler.jsonc
  per environment and pinned to `RATE_LIMIT_PER_MINUTE` by
  `apps/api/tests/rateLimit.test.ts`. A throttled request is a 429, not metered.
  Fails OPEN if the binding is missing, with a log line. Verified on wrangler dev
  2026-09-28: 60 requests 200, the next 5 429 with Retry-After: 60.
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

Vendored at `3b5efe4` (the `treasury-client` branch, saferate-treasury PR #2).
**Re-sync from `main` once that PR merges.**

## Billing — built 2026-09-28, staging only

- Entitlement: `authenticateApiKey` left-joins `organizationSubscriptions`;
  a real key with no live subscription is a **402** naming /dashboard/billing,
  not metered. Live = `ENTITLED_STATUSES` (active, trialing, past_due).
- `organizationSubscriptions` is written ONLY by the webhook callbacks in
  `auth.server.ts`. The plugin's `subscription` table is a mirror; nothing reads
  it for access.
- `lib/stripeKey.ts` refuses a live key outside production and a test key in it.
- `scripts/stripe-seed.ts` seeds product, price, WIMBLEDON coupon + code and the
  webhook, and writes the signing secret to Doppler. Applied to the sandbox:
  `prod_VLPr1f4296sWMO`, `price_1UKj1R5aTiygYfqnYfJW20kt`, coupon
  `markets_beta_wimbledon`, `promo_1UKj1S5aTiygYfqnrFXH02fH`, webhook
  `we_1UKj1S5aTiygYfqnOei8z6Qf`.
- Verified on staging: unsigned and forged webhooks 400; a webhook signed with
  the real secret 200.
- **Live Stripe seeded 2026-09-28** on Safe Rate Inc.: `prod_VLQBvNmXJThfhy`,
  `price_1UKjLJG4qd65LvbdNG7hrD1D`, coupon `markets_beta_wimbledon`,
  `promo_1UKjLKG4qd65Lvbdsn1Io6VP` (WIMBLEDON), webhook
  `we_1UKjLKG4qd65LvbdnWeyp7JO` to https://saferate.markets.
- **Proven end to end on staging, 2026-09-28**, by Dylan in a browser: a new
  key 402'd, checkout with WIMBLEDON completed at $0 with no card, and the same
  key then returned the 2026-09-25 zero curve (10y 5.145%, matching
  saferate.com/treasury). Read back afterwards: organizationSubscriptions and the
  plugin mirror both `active` on `sub_1UKjGM5aTiygYfqncUbnDqtG`, which in Stripe
  is on markets_public_monthly with no payment method and the WIMBLEDON code.

## Not built yet, in order

2. Ending the beta: a script that removes the WIMBLEDON discount from existing
   subscriptions, plus the warning email and dashboard banner (no card is on
   file, so removal leads to past_due and then lost access).
3. The contact-us enquiry form for Redistribution and Benchmark (to
   team@saferate.com, stored in D1 as well so a bounce loses nothing), and a
   usage page.
4. More REST routes. Each needs its response schema pinned by a test against the
   client's real parse, as `apps/api/tests/api.test.ts` does for /v1/curves/zero.
5. OAuth for the MCP server (claude.ai / Desktop connectors), targeting CIMD.

## Rich/cheap — how to build it, from the treasury-integration session (2026-09-28)

Not a TreasuryService method, deliberately: compute it from `analyticsOn(date)`
joined to `pricesOn(date)` (type, maturity), both already bound. A method would
bake still-moving banding and ranking into the contract. Ask again once the
bands settle. The traps, as that session measured them on production (not yet
re-measured here):

- **The two residuals have OPPOSITE signs.** `price_residual_cents` is observed
  less fitted, positive = RICH. `residual_basis_points` is the same divided by
  duration with the sign flipped, positive = CHEAP. `residual_z_score` follows
  the bp sign: positive z = unusually CHEAP.
- **Rank on the z-score, not the cents.** z is against the security's OWN
  history; cents surfaces persistent structure (age, coupon), z surfaces change.
  The richest bond by cents on 2026-09-25 (+91.8c) had z -0.24.
- **Null z is not zero, and every bill has one** (by construction). Sorting nulls
  as 0 ranks all bills as ordinary: a claim, not an absence.
- **`residual_basis_points` is nullable** near maturity (duration -> 0 blew a 41c
  gap up to 14,784 bp). Quote cents there.
- Measured against the fitted zero curve for the date; no fit means no rows. TIPS
  and FRN live in other tables with z null, so they cannot rank on the same footing.

## Markets staging reads PRODUCTION treasury

Decided 2026-09-28. `treasury-api-staging` was stale that day (healthcheck
`mostRecentCurveDate: 2026-09-09` against production's 2026-09-25) and an older
deploy lacking production's index and analytics fields, so markets staging would
have rehearsed against data no customer sees. The TreasuryService entrypoint is
read-only, so binding production cannot write anything.

The cost: a treasury-api deploy reaches markets staging and production at the
same moment, with no rehearsal. **Local dev still binds treasury-api-staging**,
so its "latest" curve is stale; switch it too if that starts to mislead.
