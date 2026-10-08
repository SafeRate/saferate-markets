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
bun test                               # 590 tests at 2026-09-29
bunx biome check .
bash scripts/bash/sync-treasury-client.sh <ref>   # re-vendor the client

# AFTER a deploy, as its own step (never chained to the deploy):
doppler run --project saferate-markets --config stg -- bun apps/api/smoke/smoke.ts
doppler run --project saferate-markets --config prd -- bun apps/api/smoke/smoke.ts
# The dashboard, as a signed-in user, through the real pages (staging or dev only):
doppler run --project saferate-markets --config stg -- bun scripts/exercise-portfolios.ts --env staging
```

**`scripts/exercise-portfolios.ts` is the dashboard's end-to-end check.** It
signs in as `--email` (default dylan@saferate.com) by writing a one-time
magic-link token to `verification` and letting the app's own verify endpoint
spend it (no email sent, no forged cookie), seeds four example portfolios
through create and CSV import at real closes (skipped when the name exists),
then drives tracking and every attribution period, stress, the overview, a
liability stream, every Builder method and lot preset, save, order CSV, track
as portfolio, and three refusals (bad CSV, off-market price, oversell), and
deletes its own "Script test" records unless `--keep`. It prints each
portfolio's overview figures. First run 2026-09-29 found the capped-match 503
below. Refuses `--env production`.

**The smoke test is the only authenticated check of a deployed environment.**
It uses `MARKETS_SMOKE_KEY` (Doppler stg and prd: a key on a subscribed
monitoring account), calls every REST route and MCP, and parses each body with
the API's own published schemas. First run 2026-09-28: 37/37 on staging and on
production; proved red with an unknown key (every authenticated check FAIL,
exit 1). Before it, the only authenticated calls ever made to a deployed
environment were Dylan's, to one route. Add each new route to it.

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

## Analytics — Google Analytics and Microsoft Clarity, four gates (2026-09-28)

Production only: GA `G-GXT251RBGJ` (stream "Safe Rate Markets", 15861881678),
Clarity `ypjj2lural`, in `apps/web/wrangler.jsonc` vars, committed (public
config, not secrets). Staging and dev are empty. Design ported from OKLocate
(its CLAUDE.md "Analytics — four gates"):

1. id configured for the environment (present = may run; there is no isActive)
2. no `markets_analytics=off` cookie  } read SERVER side: a refused visitor is
3. no `Sec-GPC: 1`                    } never sent the script
4. public path: never /dashboard, /sign-in, /sign-out, /api/auth
   (`isPathPublic` in @markets/schema, fails closed)

**Never paste a vendor snippet into root.tsx or a layout** — it bypasses all
four. Nothing is injected during SSR; `components/Analytics.tsx` re-decides on
every navigation, because a client-side move into /dashboard/keys (a new API key
shown once) must stop session replay. GA advertising signals are off in code.
`/privacy-choices` is the opt-out.

Verified on production: both injected on /, /pricing, /docs/indices; nothing on
/sign-in or /dashboard; with Sec-GPC or the opt-out cookie the ids are absent
from the page. NOT browser-tested: the in-session stop when navigating from a
public page into the dashboard (component logic, ported unchanged).

**No privacy policy page exists on saferate.markets.** Disclosing GA and Clarity
is a legal document, not written here. Owed before any real traffic.

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

- **Three plans (revised 2026-09-28, first pass): Individual $10, Team $100,
  Enterprise custom.** Individual is a natural person on their own account,
  60/min. Team is a firm's internal use, client reporting and its staff's own
  agents, 300/min, ONE seat until invitations are built. Enterprise is by
  enquiry: firm-wide, redistribution, and the benchmark licence as an add-on.
  **Individual's id stays `public`** (existing subscriptions and the lookup key
  markets_public_monthly carry it); only its display name changed. Not built
  yet: Team seats, any history cap (copy claims neither).
- **Beta codes, 100% off forever (BETA_COUPONS / BETA_CODES in plans.ts):**
  WIMBLEDON on Individual AND Team (coupon `markets_beta_all_plans`); MIT2004
  on Individual ONLY (coupon `markets_beta_wimbledon`, named for its first code,
  which has since moved), so a Team checkout must refuse MIT2004. Coupon product
  restrictions cannot be edited, hence one coupon per restriction; the seeder
  checks each existing coupon's products against the schema. No card collected
  at $0. Individual -> Team: a BETA subscriber (either coupon) is switched by
  ending Individual now and opening a Team checkout; a paying subscriber with a
  card switches in place, prorated (billing.server.ts switchPathFor).
- **Rate limit per plan**, per organization, REST and MCP together: one
  Cloudflare binding per plan per environment (RATE_LIMITER 60,
  RATE_LIMITER_TEAM 300), chosen from the organization's plan; pinned to the
  schema by apps/api/tests/rateLimit.test.ts. An unknown plan gets the lowest.
  A throttled request is a 429, not metered, and fails OPEN if a binding is
  missing. Verified on wrangler dev: 60 requests 200, the next 5 429.
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
- **Live Stripe seeded 2026-09-28** on Safe Rate Inc.: Individual
  `prod_VLQBvNmXJThfhy` / `price_1UKjLJG4qd65LvbdNG7hrD1D`, Team
  `prod_VLRDu1CVAIsPWg` / `price_1UKkKeG4qd65LvbdFuAMqdxh`, coupon `markets_beta_all_plans` with WIMBLEDON
  `promo_1UKkb6G4qd65LvbdCbEWunWF` (the first code, on the Individual-only coupon, is
  deactivated), webhook
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
4. REST parity with MCP is DONE (28 routes, 2026-09-28). New routes: pin the
   response schema on real rows, add a smoke check, and add the path to
   `API_SURFACES` (tests/surfaces.test.ts fails otherwise).
5. OAuth for the MCP server (claude.ai / Desktop connectors), targeting CIMD.

## Known: client readers that swallow failure

The vendored client's getX functions were written for web pages and several
turn an outage into empty data. REST and MCP index reads avoid them through
`packages/mcp-tools/src/reads/indices.ts`. Still used, and still swallowing:
**getFundComparison** (503 -> []), behind get_treasury_index's
`fund_comparison` include. Move it onto a strict reader before relying on it.

## REST surface (28 routes at 2026-09-28)

`API_SURFACES` in packages/schema/src/surfaces.ts is the grouped list the /docs
page renders; tests/surfaces.test.ts holds it to the spec both ways. Built this
session, each pinned on production rows and smoke-checked: the curve families
and history (routes/curveFamilies.ts), `/v1/securities` and `/v1/on-the-run`
(securityLists.ts), `/v1/rich-cheap`, `/v1/price/{coupon,bill}`, `/v1/debt`,
`/v1/strips`, `/v1/savings-bonds/{rates,i/value,ee/value}`.

- **Fixtures come from our own MCP endpoint**, not D1: a direct `wrangler d1
  execute --remote` SELECT on the treasury database is refused by the auto-mode
  classifier (production read). Call the matching MCP tool on production with
  `MARKETS_SMOKE_KEY`, map the parsed output back to upstream's column names,
  and confirm the result round-trips through the client's parser.
- **A smoke run seconds after a deploy can hit the previous version** (seen
  twice: web 404s, then "No route" for two new API paths). Re-probe before
  diagnosing; a rerun a minute later was clean both times.
- **A wall of 503s across old routes is upstream**, not the change (seen once,
  ~1 minute, 20 failures; clean on rerun). The 503 said "outage", as designed.
- `/v1/on-the-run` is NOT under `/v1/securities/`: that segment is the CUSIP
  route's, and "on-the-run" would fail its 9-character validation.

## The production freeze (2026-09-29): ENDED the same day

Lifted when the dashboard shipped: Dylan applied migrations 0003-0005 to
saferate-markets-production and deployed web and API at 73952c1; the production
smoke test passed 77/77. Production builds and deploys are run by Dylan (they
are blocked for Claude); the history below is kept for why.

### What the freeze was

A fund of funds may be onboarding onto the API. Until Dylan says the build is
done: deploy STAGING only (web and API), apply migrations to staging only, and
make no treasury-api deploy (Markets staging binds production treasury-api, so
any new TreasuryService method would be a production change). Hence the
portfolio maths runs in Markets (packages/portfolio) over existing RPC methods.
Pending for the final production deploy: migrations 0003, 0004 and 0005 on
saferate-markets-production, then web and API. Treasury PRs #8, #10 and #11
(#9 rebased) merged 2026-09-29; the vendored client is on treasury main
9101f2a.

## The dashboard (2026-09-29): menu, Portfolio Tracking, Treasury Rates

`routes/dashboard.layout.tsx` + `components/DashboardNav.tsx`. Unbuilt menu
items are listed as "Soon", not stub routes. apps/web has its own read-only
TREASURY binding now.

**packages/portfolio** is the engine: a daily ledger from trades and closes,
on the INDEX's conventions (END OF DAY close + accrual to T+1 settlement;
coupons in the half-open settlement window; trade-date holdings). Accrual is
ported from saferate-treasury treasuryYtm.ts and held to production analytics
to 12 places. Per-portfolio `policyIncome`: cash (default, earns the 1M bill
rate, purchases draw on it), reinvest (coupons buy the paying bond at the
close) or distribute. TWR chained daily; MWR; FIFO cost, realised/unrealised;
projected income. CSV import matches columns BY NAME with custodian aliases,
32nds, ISINs, US dates; all or nothing; undoable by idImport.

- **Measured end to end on production data:** 91282CMM0 bought at the 1 Sep
  close returned -2.83% to 28 Sep; its own 7-10 Year index -2.82%.
- **A period the portfolio did not span opens at the close of its FIRST DAY**,
  portfolio and benchmark alike. Found the hard way: a test buy entered 3
  points under the close showed as +3% of "performance". The trade-to-close
  gap now lives in the dollar gain and MWR, and trades >1 point from the
  close are flagged on the page (refused at 5).
- **Every kind is valued**, each through a pricer (packages/portfolio
  pricers.ts): nominals by the coupon formula; TIPS as real dirty x the stored
  index ratio at settlement (linear within a month, so two stored days fix any
  date), coupons on adjusted principal, deflation floor at maturity; FRNs at
  max(0, index + spread) actual/360 from the stored accrual, paid quarterly.
  Held to production rows to 10-12 places. End to end on production data from
  a 1 Sep buy: FRN +0.31% vs the FRN index +0.31%; TIPS -3.56% vs the TIPS
  index -2.57%, the gap confirmed by hand (real yield +47bp on an 8-year real
  duration against a 7-year index). Future TIPS/FRN coupons hold today's ratio
  or rate flat and are marked "estimate"; breakeven- and forward-implied
  projections are a later refinement.
- **Attribution** (packages/portfolio attribution.ts): the treasury repo's
  exact-repricing decomposition (returnAttribution.ts), ported and run DAILY on
  the ledger's own holdings, Carino-linked over any period (one period per page
  view: it is the costly part). Carry, roll-down, curve split into Diebold-Li
  level / slope / curvature (fixed loadings, decay 1/1.3684y) plus other shape,
  selection; bills/TIPS/FRNs as income and price; trading (trade vs close);
  cash interest. NOT split on the NSS thetas: measured 25 to 28 Sep, theta0
  moved +152bp in a day against theta3, so theta splits are offsetting
  fiction. Components add to the TWR (residual < 1e-9 in tests; nil on the
  four live test portfolios).
- **Stress Testing** (/dashboard/stress, services/stress.server.ts) on the
  treasury repo's own risk code, ported VERBATIM with its tests into
  packages/portfolio/src/risk (historicalSimulation, volatilityModels after
  Tsay: GARCH(1,1) + generalised Pareto tail; portfolioStress; nelderMead;
  keyRates). Standard shocks and a user shock reprice every nominal cashflow
  exactly on the day's fitted curve; every stored market_events window is
  replayed on today's holdings; VaR/ES 1 and 10 day, 95/99, by GARCH-filtered
  historical simulation over every curve move since 2008-09, EVT and empirical
  side by side. TIPS move by real duration (breakevens unchanged), FRNs by rate
  duration; neither enters VaR. The scenario set is cached per isolate by
  as-of date: first view ~7s, then ~1.5s. Checked on the live single-note
  book: DV01 $675/bp, +100bp -6.72%, 1-day 99% VaR $11,457 (1.19%).
  Veronesi is not cited anywhere in the treasury repo (asked 2026-09-29).
  Tsay diagnostics (risk/tsay.ts, tailDiagnostics): on the book's history of
  daily P&L (today's key-rate DV01 times each day's curve move), raw and
  GARCH-filtered: skew, excess kurtosis, Jarque-Bera, Ljung-Box(10) on the
  squares, and Hill alpha on losses (k = 2.5%); a Student-t fitted by ML on
  the filtered series gives a third VaR/ES. The proof the filter works is
  Ljung-Box on the squares: 692 raw falling to 7 (p 0.68) filtered on a
  $1.5M test book, with kurtosis 3.2 falling to 1.25 and nu about 10.
- TIPS and FRN risk is shown APART from nominal duration (real duration;
  spread and rate duration), never blended.
- **Run `build-web.sh staging` before calling a page done.** The dev server
  serves a page whose client code imports a `.server` module; the production
  build refuses it ("Server-only module referenced by client"). Found
  2026-09-29 on the Builder: shared constants now live in lib/builderOptions.ts.
  Likewise never import one route module from another; shared UI goes in
  components/, shared logic in lib/.
- **Dev-only noise:** "An RPC result was not disposed properly" and workerd
  "internal error; reference = ..." lines come from the remote binding proxy
  in `dev-web.sh`; pages still return correct data, and the deployed Workers
  make the same calls without them.
- **The matcher's LPs are bounded and scaled (2026-09-29).** A cash-flow match
  capped at 6 positions returned 503 on staging: one branch-and-bound node's
  simplex diverged (objective at -1e16 after 100,000 Bland pivots) and never
  returned. Three fixes in packages/portfolio, all measured: simplex has
  `maxIterations` and an "iteration-limit" status; the search has a 25,000
  pivot budget (a Worker's clock does not move during computation, so time
  cannot be the budget); and pinned indicators are no longer equality rows
  but dropped or bounded, so a seed is a ten-variable programme instead of a
  1,217-column one, with faces scaled to the liability. Cost now rises
  steadily as the cap tightens ($7.79M uncapped, $8.0M at 6, $9.7M at 1)
  where before a cap of 4 settled for $21.8M in one bond. The treasury repo's
  copy has the same flaw (not yet fixed there).
- **The testing portfolios (`--testing`, 2026-09-29).** Twenty "Test NN"
  portfolios on dylan@saferate.com in staging, each built to break one thing:
  a bill to maturity, one long bond, the same note bought monthly, FIFO in and
  out, a round trip, 40 and 100 securities, a TIPS ladder, every FRN, a mixed
  barbell, 2008 and COVID histories, a $750M block, $100 lots, first-day new
  issues, a reinvested bill roll, a quarterly 2-year roll, coupon-date and
  pre-maturity trades, TIPS against nominals, and 1,300 trades. Plus 25 import
  break tests. The script also fails any page showing NaN, Infinity,
  "undefined" or an unexplained attribution, and any overview that disagrees
  with Tracking. What they found, all fixed and each pinned by a test that
  fails on the old code:
  - FRN coupons on weekdays paid ZERO: a stored row settling on the coupon
    date carries the new period's accrued (0), and the coupon anchored on it.
    An all-FRN book showed half its income. Coupons now anchor strictly
    before their date (pricers.ts).
  - Attribution left -0.05 bp unexplained per coupon: the decomposition's end
    value carried coupons at forwards, which the ledger never pays. The end is
    now the coupon as received; the difference lands in selection, as the
    treasury repo's reinvestedAtForwards comment says it should.
  - A 100-security page took 26 s of Worker CPU (a timeout once): 68% was the
    holiday library via dayjs inside settlementFor. isBusinessDay,
    settlementFor, coupon schedules, accrued and yearFraction are memoised;
    20 s to 0.9 s locally, 38 s to 5 s on staging. The memoised schedule was
    checked identical to the old one on 192,526 random cases.
  - Weekend and holiday trade dates were accepted; now refused.
  - More than 5,000 rows in one import was a 500 (the persistence cap, never
    checked by the page); now a message. `MAX_TRANSACTIONS_PER_ADD`.
  - The overview added cash to a market value that already includes it.
  - Re-importing the same file doubled every position silently. An import
    containing trades identical to stored ones (CUSIP, side, trade date,
    face, price) now stops and offers "Import anyway" (`allowDuplicates`),
    since two identical tickets can be real.
- **Speed, measured on staging (2026-09-29, second pass).** A 100-security
  valuation spent 3.7-4.1 s of its 5 s loading securities (a detail and a
  FULL price history each over the service binding: the RPC takes no range),
  CPU only 1-2 s. Loaded securities are now cached per isolate, keyed by the
  latest price date, 400 at most (`securityCache` in portfolio.server.ts):
  other tabs of the same portfolio 8 s to 1.1-1.6 s, the overview 5.9 s to
  0.8 s; a cold first view is still 4-5 s. The cached marks are shared, so
  never sort or push them in place. The real fix for the cold view is a
  batch or ranged securityPrices RPC in treasury-api (frozen). The simplex
  pivots only non-zero columns on Float64Arrays: the capped match 13.6 s to
  about 4 s, identical plans (also in treasury, merged as #11).
- **Fixtures and end-to-end checks:** local dev (`dev-web.sh`) prints the magic
  link; sign in with curl and a cookie jar. The dev server's HMR can blow its
  stack after many edits ("Maximum call stack size exceeded" in
  getParentClientNodes) - restart it; it is not the code.

### Next, in order (agreed with Dylan 2026-09-29)
1. (done) Attribution: see above.
2. (done) Stress testing: see below.
3. (done, backtests 2026-09-29) Portfolio Builder: starting amount + liabilities -> recommended portfolio
   (cashflowMatching.ts, immunisation.ts) and strategy templates with pros and
   cons (bill roll, short end, ladder, bullet, barbell, duration targets,
   roll-down, rich/cheap switches, index tracking), each BACKTESTED through the
   engine on real closes. Order sheets split TreasuryDirect-eligible (new issue
   at an upcoming auction, non-competitive, <= $10M, buy only) from secondary
   (any CUSIP, buy or sell; IBKR, Apex, custodian).
4. (done 2026-09-29) Treasury Auctions: /dashboard/auctions, see below. Still
   wanted, both needing treasury deploys: a dated auctions read in treasury-api
   (new securities' announced auctions; short bills that are not reopenings)
   and the stored upcoming_auctions feed.
5. Trade Execution: order-sheet history now, IBKR later.

## Treasury Auctions (2026-09-29; one read and an API, 2026-10-02)

- **One reader, one analysis, three surfaces.** packages/mcp-tools
  reads/auctions.ts: `readAuctionsBetween` (treasury-api `auctionsBetween`,
  a dated read of security_auctions LEFT JOINED to security_details),
  `analyseAuctions` (terms, latest by term, announced, settling, history) and
  `publishAuction` / `publishLatestByTerm` (the snake_case record). The
  dashboard page, `GET /v1/auctions` + `/v1/auctions/latest`, and the
  `get_treasury_auctions` MCP tool all use them, so they cannot disagree.
- **400 days back, 60 ahead** (`loadAuctionWindow`, cached per isolate by
  price date). Six priors of a monthly 52-week bill need most of a year;
  saferate.com uses the same. The REST list defaults to 30 back / 60 ahead and
  refuses a window over 400 days.
- **New issues are kept**, maturity and coupon null until issued (a new note's
  coupon is set at its auction). The old fan-out over the on-the-run queues
  could not see them, and held only 3 prior 4-week auctions where 6 exist.
- **Changes average up to six priors, each counted apart**
  (`coverComparedWith`, `dealersComparedWith`), shown beside each change.
  tests: 912797VP9 on the real 4-week history must give +0.00 and -0.8863 pt
  over six, saferate.com's figures (proved failing at seven priors).
- **Bills group by the term OFFERED** (`securityTerm`), coupons by original
  term: a 4-week reopening of a 17-week bill is a 4-week auction; a reopened
  10-year is a 10-year ("9-Year 11-Month" as offered).
- **Bills lead with the discount rate**, investment rate beside it (agreed with
  saferate.com 2026-10-02): the discount rate is Treasury's headline and the
  only bill rate with a median, so high-less-median is on it.
- **A treasury-api without the method** is TreasuryAbsent: a 503 that says so
  (REST), the readable deploy-skew error (MCP), a 503 page (dashboard). Never an
  empty schedule.
- **The client keeps the full auction row** (treasury PR #10: bidder classes,
  allocation, low/median/high rates, discount rate / margin, price). Merged
  2026-09-29; vendored from treasury main 9101f2a. The REST route
  /v1/securities/{cusip} pins its eight published auction fields
  (`publishedAuction`): passing the new ones through its strict schema made
  every lookup a 500 in tests. MCP's get_treasury_security passes the record
  through, so its answers gain the new fields when the API deploys.
- Shares are of the competitive award (dealers + direct + indirect). "High
  less median" is NOT the tail (that needs the when-issued yield).

## The paid gate and the read-only demo (2026-10-01)

- **The dashboard's portfolio tools need a paid plan** (Dylan). An account
  without one tours a SHARED, READ-ONLY demo: organization `demo`
  (`DEMO_ORGANIZATION_ID`), seeded by migration 0006 with five portfolios
  (ladder, a Builder cash-flow match of the demo stream, TIPS and floaters,
  long duration through 2022, a bill roll), the demo liability stream and a
  saved plan. Shared rather than copied per sign-up: nothing written per
  account, the same curated tour for everyone, nothing to untangle on paying.
- **`requireDashboard`** (lib/session.server.ts) is the one switch: unpaid
  pages read `idOrganization = "demo"`, and any non-GET from an unpaid account
  is refused there with a 402 before an action runs. The forms are hidden too
  (components/WriteGate.tsx, reading `isDemo` from the layout's loader), but
  the server is what enforces it. Billing, keys and usage stay the account's
  own (`idOrganizationOwn`). Markets pages and backtests are open to any
  signed-in account: they are the tour.
- **Refresh the demo** with `scripts/demo-seed.ts <new migration name>` into a
  NEW migration; never edit an applied one.
- **Checked by** `exercise-portfolios.ts --demo --email <an unpaid account>`
  (staging: demo-check@saferate.com): the banner, all five portfolios value,
  every write is a 402, the demo is unchanged after.

## Markets menu and landing page (2026-10-01)

- **Pages:** Security Lookup (`/dashboard/securities`, search shared with
  the trade picker in services/securitySearch.server.ts; `/:cusip` from
  getSecurity), Curves (`/dashboard/curves`: each family's shape against a
  week, a month and a year back; Treasury Rates stays as the tables),
  Indices (`/dashboard/indices`, `/:code`), On / Off the Run
  (`/dashboard/on-the-run`). Built from treasury-integration's notes on the
  consumer pages (saferate-ai apps/consumer).
- **Traps handled, each from data:** index returns end on the newest DAILY
  valuation and chain from the base (packages/portfolio indexReturns.ts:
  the daily series starts the day AFTER the base, 2008-10-01 at 100.35, so
  the base is read off the first row); index analytics are one row per
  duration basis (the Aggregate has three); the open snapshot's
  rebalance_date is the period START; on-the-run premiums are struck on
  residuals, not yields; a floater's price-row coupon is today's reset
  rate, so floaters show no coupon; convexity is already divided by 100 in
  the client. Amount outstanding is in DOLLARS (the 10-year: $138.5B), not
  millions, which was measured, not assumed.
- **Coverage starts 2008-09-02** (`TREASURY_COVERAGE_START`), checked
  against production by treasury-integration; the index base is 2008-09-30.
  The client throws on an earlier date: five one-day curve routes turned
  that into a 500 until 2026-10-01 (now the documented 400; tests in
  curveFamilies.test.ts fail on the old routes). Pages refuse such dates
  before calling.
- **Landing page:** the full suite, coverage from the constant, provenance
  in saferate.com's wording ("primary sources, free to anyone"; never
  "public domain", an unchecked copyright claim). The call to action is the
  demo tour; the tools need a plan (above).

## Rich / Cheap page (2026-10-01, `/dashboard/rich-cheap`)

- The consumer site's internal page (saferate-ai, saferate.com/treasury/
  relative-value-private, basic auth) behind sign-in instead; nothing on it is
  secret. Same inputs as `/v1/rich-cheap`: `readRichCheap` (analyticsOn joined
  to pricesOn). `bandRichCheap` (mcp-tools reads/richCheap.ts) bands notes and
  bonds on the index boundaries (lower bound inclusive) and gives the five
  most unusually cheap and rich of each, RANKED ON z, not cents (cents is the
  level, structure; tests/richCheapBands.test.ts fails if it sorts by cents).
  Bills apart, by price residual, since every bill z is null: NOT by design,
  an upstream hardcoded null (treasuryBillPricing.ts, 2026-10-01), so the page
  says only "not published yet". TIPS: own section on the real curve. A
  null z is counted, never ranked; a z of 0 is scoreable and in neither list.
- Every date from the data, never the calendar (treasury-integration's
  warning, 2026-10-01: the September index rebalance had not published).
- Web only: no API change, no migration.

## Strategy backtests (2026-09-29, `/dashboard/backtest`)

- **Engine: packages/portfolio backtest.ts**, pure, data injected. The whole
  starting amount is in the book from day one (`openingCash` on buildLedger);
  everything between rebalances is the ledger (coupons, maturities, cash at
  the bill curve's 1M rate), the same code that values a customer portfolio.
- **Managed by maturity SLOTS (`slotsFor`), not rebuilt.** The first version
  rebuilt the template from scratch each quarter; "one year from now" names
  a new bond every quarter, so real runs turned over 300-400% a year. Now a
  position in one of the template's rungs is held (ladders, short end, bullet
  and bills to maturity; intermediate, long and barbell bonds sold when they
  age out of their sector) and cash fills the rungs short of their equal
  share. Self-financing by construction; `externalCash` reports any leak. The
  bullet's target dates are fixed at the start.
- **Tests** (tests/backtest.test.ts): a par market with cash at 4% must return
  4%, need no outside money and show no drawdown; a 10% one-day fall must show
  as the drawdown; a ladder's turnover must stay low. Proved against an engine
  that overspends by 5% (five tests fail).
- **Speed.** The cost is reading securities: comparing all seven over five
  years loads about 300 securities' FULL price histories (the RPC takes no
  range): about 20 s cold, 9.6 s of it CPU. Results are cached by engine
  version, latest price date and request, in the edge cache (per data centre:
  staging alternates YYZ and ATL) and in D1 `backtestResults` (migration 0005,
  shared): repeats 0.2-0.4 s. **Bump `ENGINE_VERSION` in backtest.server.ts**
  whenever the engine or its inputs change, or old results are served for two
  weeks. Windows are capped by frequency (monthly 5 years, quarterly 10, yearly
  18). The real fix for cold runs is a ranged securityPrices RPC (frozen).
- Five years to 2026-09-28, quarterly, $1M, half a 32nd a side: bill roll
  +3.53% a year, short end +2.40%, ladder +0.23%, intermediate +0.11%, bullet
  -1.47%, barbell -2.03%, long -6.03% (worst drawdown -36%); Aggregate index
  +0.47%.

## Rich/cheap — built 2026-09-28 (`/v1/rich-cheap`, `get_treasury_rich_cheap`)

Measured on the first live run (2026-09-25, 344 scored notes and bonds):
- **Default `min_years=1`.** Without it the top of the list was all notes
  inside four months of maturity (20bp from 2-3 cent price errors; median |z|
  3.04 under three months against 1.02 at six to twelve). The nominal curve is
  fitted from one year out. Echoed in the response; `min_years=0` asks for it.
- **No TIPS basis published.** All 53 TIPS were unscored (upstream computes no
  linker z). The reader keeps `basis: "tips"`; publish it when upstream scores
  them, and re-measure the short-end floor for linkers then.
- Each row says `vs_curve` (sign of the bp residual) and `vs_history` (sign of
  z) in words; they disagree for real bonds (91282CQZ7: rich, cheaper).

### The original guidance, from the treasury-integration session

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
- **Null z is not zero, and every bill has one** (an upstream hardcode, not a
  property of bills; TIPS 09-28..30 were nulled the same way). Sorting nulls
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

## Markdown twins (2026-10-05, `<page>.txt`)

- **Every public page has a `.txt` twin**: lib/publicPages.ts `PUBLIC_TWIN_PATHS`
  is the one list (/, /data, /indices, /capabilities, /about, /pricing, /docs,
  /docs/indices, /terms, /privacy, and from 2026-10-08 the pilot pages
  /strategies (the hub), /strategies/ladder-5y, /strategies/t-bill-reinvestment,
  /methodology/treasury-curve). The dashboard has none: it is behind
  sign-in.
- **The twin is the page**: routes/page-twin.ts runs the page's own loader,
  renders its own component in a one-route static data router (a bare
  MemoryRouter 500s: the framework's component wrapper reads props through
  useLoaderData), and converts the markup (lib/htmlToMarkdown.ts, a converter
  for our own markup, not a general one). So a twin cannot drift from its page.
- Served `text/markdown` with `Link: rel="canonical"` to the HTML page (as
  saferate.com's markdownResponse); every public HTML page sends
  `Link: <...txt>; rel="alternate"; type="text/markdown"` (workers/app.ts).
- **The Cloudflare rule** (Dylan's, in the dashboard) redirects
  `Accept: text/markdown` on exactly those paths to `concat(path, ".txt")`,
  so `/` lands on `/.txt`, which serves the home page. A page added to the
  rule but not to PUBLIC_TWIN_PATHS would send an agent to a 404: add both.
- New public page: add it to PUBLIC_TWIN_PATHS, to page-twin.ts's PAGES, to
  routes.ts as `<path>.txt`, and to the rule's path list.

## Search and agents: robots, sitemap, llms.txt, IndexNow (2026-10-05)

- Production welcomes everything (Dylan): robots.txt allows all with
  `Content-Signal: search=yes, ai-input=yes, ai-train=yes`, keeps out only
  /dashboard and /api/auth/, names /sitemap.xml. No `noindex` on public pages
  (the dashboard and sign-in keep it). Every non-production host disallows all
  and keeps `noindex`, so staging never competes in an index.
- sitemap.xml and llms.txt come from PUBLIC_TWIN_PATHS; llms.txt reads each
  page's own meta description (lib/publicPageModules.server.ts).
- IndexNow: the key (lib/indexNow.ts) is PUBLIC by design and served at
  `/<key>.txt` from apps/web/public; a test holds the two equal. deploy-web.sh
  runs scripts/indexnow.ts after every PRODUCTION deploy (never fails the
  deploy); Cloudflare Crawler Hints is also on for the zone.
- Cloudflare (Dylan's dashboard): Redirect Rule "Redirect Markdown" sends
  Accept: text/markdown on the public paths to concat(path, ".txt"), 302.
  "Markdown for Agents" and "Bot Preference Sync" stay OFF: our twins replace
  the first; the second would write Cloudflare's bot blocks into robots.txt.

## markets.saferate.com serves the site (2026-10-05)

- saferate.markets was registered 2026-09-28; a fund of funds' Cloudflare
  Gateway blocked it (the "New Domains" category, under 30 days). So
  markets.saferate.com (saferate.com, 2014) moved from REDIRECT_HOSTS to
  ALTERNATE_HOSTS: it SERVES the production site. saferate.markets stays
  canonical: `<link rel="canonical">` on every page, and the sitemap,
  robots.txt, llms.txt and twin canonicals all use canonicalOrigin()
  (lib/canonicalOrigin.ts), which is saferate.markets on production whatever
  the host. Auth trusts the alternate origin and builds magic links from the
  host in use; cookies are per host, so a session on one is not on the other.
- Production sends HSTS (1 year, includeSubDomains, not preloaded);
  /.well-known/security.txt is a route so its Expires is always 180 days out.

## The free tier (2026-10-06, FREE_TIER in @markets/schema)

- Three tiers in requireDashboard (lib/session.server.ts): PAID (own org, no
  limits); FREE (unpaid with a portfolio of its own: own org, writes allowed
  within the limits); DEMO (unpaid with none: the demo org, read-only). The
  one write the demo allows is creating a first portfolio
  (`requireDashboard(..., { startsFreeTier: true })` on /dashboard/portfolios),
  which goes into the account's own org and starts the free tier. Deleting
  every portfolio puts an account back in the demo.
- Limits (services/freeTier.server.ts): two portfolios; total value at most
  $100,000, valued as the dashboard values it (holdings at the latest close
  plus cash), WITH the incoming trades, checked in the trades `store` funnel
  (add and import) and when a plan is tracked as a portfolio. Market moves
  past the cap block new trades, never viewing. Deleting is never limited.
- Not a Stripe plan and not in PLANS: no API or MCP (the API already refuses
  an unentitled organization's keys). Shown first on Pricing, the home page,
  the terms' plan table and the JSON-LD offers.
- exercise-portfolios.ts --demo walks it end to end on an unpaid account and
  deletes what it made, leaving the account in the demo.
