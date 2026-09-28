/**
 * The only place in this app that talks to the `TREASURY` service binding.
 *
 * Everything crosses two boundaries here and both matter:
 *
 * 1. TYPE. `wrangler types` emits `TREASURY: Service` with no type parameter,
 *    because `TreasuryService` is declared in saferate-treasury and nothing in
 *    this repo can see it. `TTreasuryService` below transcribes by hand ONLY
 *    the methods this app actually calls. Upstream has fifteen; the rest are
 *    transcribed alongside the pages that need them rather than carried here
 *    unused. If one CHANGES upstream, nothing in this repo fails to compile —
 *    that is the cost of the arrangement, and the reason every row is parsed
 *    below and covered by a fixture test. The upstream doc
 *    (docs/consumer-service-binding.md) is the contract of record.
 *
 * 2. SHAPE. The methods return `Record<string, unknown>[]` straight off SQL, in
 *    snake_case. Every row is zod-parsed into camelCase here, so a column
 *    rename upstream surfaces as a parse error on one page rather than as
 *    `undefined` rendered into a rate table.
 *
 * WHY A SERVICE BINDING AND NOT A D1 BINDING. A direct D1 binding would be
 * simpler, and this app already binds econ-forecasting that way, so it is the
 * obvious move. It is the wrong one. Five of the 37 economic series are
 * licensed to CBOE, ICE, the University of Michigan and Freddie Mac; FRED
 * redistributes them under agreements that do not extend to Safe Rate, so
 * storing them is fine and serving them onward is republication. That gate is
 * enforced in SQL *inside* these methods. A caller holding a D1 binding writes
 * its own queries and the gate is simply not in the path — one
 * `SELECT * FROM economic_series` on a public marketing site would put Freddie
 * Mac's mortgage survey rate on saferate.com. These methods make that
 * impossible rather than merely discouraged.
 */
import type { TRunStatus } from "@saferate/treasury-client/types";
import {
   ANALYSED_FAMILIES,
   INDEX_DISPLAY_ORDER,
   isIndexCode,
   RUN_KIND_ORDER,
   securityFamilyFromPriceType,
   type TIndexCode,
   TREASURY_COVERAGE_START,
   termYears,
   ZBillPrice,
   ZBreakevenDay,
   ZCouponPrice,
   ZCurveFitDiagnostics,
   ZDebtSummaryLine,
   ZEeBondRate,
   ZEeBondValuation,
   ZFrnAnalytics,
   ZFundComparison,
   ZIBondValuation,
   ZIndexAnalytics,
   ZIndexConstituent,
   ZIndexLevel,
   ZIndexLevelDaily,
   ZIndexReturns,
   ZLscCurveDay,
   ZMoneyMarketCurveDay,
   ZOpenConstituents,
   ZOpenConstituentsStatus,
   ZParCurveDay,
   ZPriceOnDate,
   ZRealCurveDay,
   ZRunStatus,
   ZSavingsBondRate,
   ZSavingsBondStock,
   ZSecurityAnalytics,
   ZSecurityAnalyticsWithCusip,
   ZSecurityDetail,
   ZSecurityOutstanding,
   ZSecurityPrice,
   ZStrippedSecurity,
   ZStrippedStatement,
   ZTipsAnalytics,
   ZTreasuryDirectSale,
   ZZeroCurvePoint,
} from "@saferate/treasury-client/types";
import { z } from "zod";

/**
 * The upstream RPC surface, transcribed. `unknown` where upstream declares
 * `unknown` — those three are single rows whose shape depends on the family,
 * and they are parsed below rather than trusted here.
 */
export type TTreasuryService = {
   availableSeries: () => Promise<Record<string, unknown>[]>;
   /**
    * OPTIONAL, like every method added after a consumer deploy. A method the
    * bound worker does not have is `undefined`, and calling it throws a
    * TypeError rather than returning a refusal — which `treasuryRead` cannot
    * classify, so it retries and then 503s the whole page. Declared with `?`
    * and guarded at the call site instead. Live since treasury-api a1b412ba.
    */
   indexAnalytics?: (input: {
      code: string;
      date?: string;
   }) => Promise<unknown[]>;
   indexReturns?: (input: { code: string }) => Promise<unknown>;
   curveSeries: (input: {
      family: string;
      from: string;
      limit?: number;
      to: string;
      // TWO SHAPES, on purpose, for as long as the transition lasts. See
      // `normaliseCurveSeriesReply`.
   }) => Promise<
      | Record<string, unknown>[]
      | { rows: Record<string, unknown>[]; truncated: boolean }
   >;
   security: (cusip: string) => Promise<Record<string, unknown> | null>;
   securityAnalytics: (cusip: string) => Promise<Record<string, unknown>[]>;
   // Per-CUSIP linker and floater analytics, shipped 2026-09-10 at our
   // request. Deliberately the same shape as securityAnalytics — no date
   // argument — because a page about one security needs its whole history.
   frnAnalytics: (input: { cusip: string }) => Promise<unknown>;
   tipsAnalytics: (input: { cusip: string }) => Promise<unknown>;
   // One shape, two behaviours: `date` returns a single row and REFUSES with
   // unknown_family when that date has no fit; `from`/`to` returns a series.
   realCurve: (input: {
      date?: string;
      from?: string;
      to?: string;
   }) => Promise<unknown>;
   breakevenOn: (input: { date: string }) => Promise<unknown>;
   // WHOLE-DAY reads, one call rather than one per CUSIP. A queue page needs a
   // yield for eleven securities; eleven `security(cusip)` round trips to get
   // them would be absurd when the day's whole table is a single call.
   analyticsOn: (date: string) => Promise<Record<string, unknown>[]>;
   frnAnalyticsOn: (input: { date: string }) => Promise<unknown>;
   tipsAnalyticsOn: (input: { date: string }) => Promise<unknown>;
   securityPrices: (cusip: string) => Promise<Record<string, unknown>[]>;
   savingsBondRates: () => Promise<Record<string, unknown>[]>;
   runStatusOn: (input: {
      basis?: "auction" | "issue";
      date: string;
   }) => Promise<unknown>;
   stripsOn: (input: { date: string }) => Promise<unknown>;
   stripsSeries: () => Promise<unknown>;
   /**
    * OPTIONAL, and the `?` is load-bearing rather than cautious typing.
    *
    * These three landed on the entrypoint in saferate-treasury a919eb5 and the
    * worker is NOT YET DEPLOYED with them. A missing RPC method is not a
    * refusal — the stub throws a TypeError, which `treasuryRead` cannot
    * classify, so it retries once and then serves a 503 for the WHOLE page.
    * Declared optional so the readers below must check before calling, which
    * turns an undeployed upstream into one absent section instead.
    *
    * Leave the `?` in place after the deploy. It is what protects the next
    * method added to this app before the worker that answers it.
    */
   debtSummary?: (input: { date: string }) => Promise<unknown>;
   /**
    * Six more that landed in saferate-treasury dcea1de and ARE deployed to both
    * environments. Optional for the same reason as the three above: it is what
    * keeps a method added here before the worker from 503ing a whole page.
    */
   eeBondRates?: () => Promise<unknown>;
   latestPriceDate?: () => Promise<unknown>;
   outstandingOn?: (input: { date: string }) => Promise<unknown>;
   pricesOn?: (input: { date: string }) => Promise<unknown>;
   savingsBondStock?: () => Promise<unknown>;
   treasuryDirectSales?: () => Promise<unknown>;
   /**
    * DAILY index valuations, landed in saferate-treasury 8d78e773.
    *
    * Optional for the same reason as every method above it, and the peer who
    * shipped it said plainly that it has NOT been proved end to end: the HTTP
    * route sits behind an API key gate that 401s an unknown path as readily as
    * a wrong key, so a 401 there proves the gate and nothing about the route.
    * This app's first call is the real proof, which is exactly the case the `?`
    * exists for.
    */
   indexLevelsDaily?: (input: {
      code: string;
      since?: string;
   }) => Promise<unknown>;
   indexLevels: (input?: { code?: string }) => Promise<unknown>;
   indexLevelsOn: (input: { date: string }) => Promise<unknown>;
   fundComparison: () => Promise<unknown>;
   indexConstituents: (input: {
      code: string;
      date?: string;
   }) => Promise<unknown>;
   /**
    * The OPEN period's membership, landed in saferate-treasury after the
    * daily-analytics run began writing `index_constituents_open`.
    *
    * Optional for the same reason as every method above it. This one also
    * refuses with `unknown_index` when the snapshot table is empty for a code —
    * which is a real state, not a mistyped code, because the table is written by
    * a producer run that can be behind. Both are one absent section here.
    */
   openConstituents?: (input: { code: string }) => Promise<unknown>;
   /**
    * WHY THE SNAPSHOT IS ABSENT, as a second call rather than a richer refusal.
    *
    * `openConstituents` refuses with `unknown_index` for two different states —
    * never written, and written but superseded by a newer rebalance — and the
    * difference is only in the message. Parsing that message would make prose a
    * contract. A distinct refusal CODE was the obvious alternative and is the
    * wrong one: an unrecognised code falls through this app's catch, gets
    * retried by `treasuryRead`, and 503s the whole index page, so it would need
    * a coordinated two-repo deploy in a fixed order to ship safely.
    *
    * This is purely additive instead. Nothing existing changes shape, so either
    * side can deploy first, and it is paid only on the branch that already
    * returned null.
    */
   openConstituentsStatus?: (input: { code: string }) => Promise<unknown>;
   eeBond: (input: {
      on?: string;
      principal?: number;
      purchased: string;
   }) => Promise<Record<string, unknown>>;
   iBond: (input: {
      on?: string;
      principal?: number;
      purchased: string;
   }) => Promise<Record<string, unknown>>;
   billPrice: (input: {
      discountRate?: number;
      maturityDate: string;
      price?: number;
      tradeDate?: string;
   }) => Promise<Record<string, unknown>>;
   couponPrice: (input: {
      cleanPrice?: number;
      couponRate?: number;
      cusip?: string;
      frequency?: number;
      maturityDate?: string;
      tradeDate?: string;
      yieldRate?: number;
   }) => Promise<Record<string, unknown>>;
   curvesOn: (date: string) => Promise<{
      date: string;
      dieboldLi: unknown;
      moneyMarket: unknown;
      nss: unknown;
      zero: Record<string, unknown>[];
   }>;
   latestCurve: () => Promise<{
      date: string;
      zero: Record<string, unknown>[];
   } | null>;
   series: (input: {
      from: string;
      ids: string[];
      limit?: number;
      to: string;
   }) => Promise<{ missing: string[]; rows: Record<string, unknown>[] }>;
};

/**
 * The six codes upstream uses for a request it has *understood and refused*.
 *
 * HOW THE CODE ACTUALLY ARRIVES, measured 2026-09-09 against the deployed
 * worker, because it is not what either side expected:
 *
 *   thrown upstream    TreasuryServiceError, name "no_valuation"
 *   received here      Error, name "Error",
 *                      message "no_valuation: no answer for that pair of dates…"
 *
 * Workers RPC does NOT preserve a custom error's `name`, and does not carry own
 * properties either, so `error.code` is undefined AND `error.name` is the
 * useless string "Error". What survives is the MESSAGE, with the code folded
 * onto the front as a `code: text` prefix.
 *
 * So the classification reads the message prefix. That is message matching,
 * which is normally brittle — but the code is a fixed machine token at a fixed
 * position, not prose, and it is the only thing that crosses the boundary.
 * `name` is still checked first so this keeps working if a future runtime (or a
 * same-isolate caller) does preserve it.
 *
 * THE COUPLING THIS DEPENDS ON, so nobody breaks it from either end: upstream
 * sets `TreasuryServiceError.name` TO THE CODE, and workerd's normalisation is
 * what moves that name onto the front of the message. If upstream ever "tidies"
 * that to a class name, every message arrives as "TreasuryServiceError: …",
 * this match finds nothing, and every refusal silently becomes a retried 503 —
 * a bond that can never be valued would tell the reader to come back later.
 * Upstream carries the same warning next to the assignment.
 *
 * The shape that would need none of this is a resolved `{ ok: false, code,
 * message }` for refusals, with throws reserved for genuine failures — a
 * refusal is an expected answer rather than an exception. Both sides agree that
 * is better; it needs a coordinated deploy, so it is a deliberate change rather
 * than a tidy-up.
 *
 * Anything matching NEITHER is a transport failure and should retry.
 */
const TREASURY_REFUSAL_CODES = [
   "bad_date",
   "bad_limit",
   "bad_principal",
   "bad_range",
   "no_valuation",
   "unknown_family",
   // Distinct from unknown_family, which names a curve family: this names an
   // index in the published family. Added upstream with the index methods and
   // NOT announced — found by reading `TServiceErrorCode` rather than by being
   // told, after an unknown index code would have been retried and served as a
   // 503 instead of a "no such index" page.
   //
   // THIS LIST MUST TRACK `TServiceErrorCode` in the upstream entrypoint. A
   // code missing from here does not fail loudly; it silently becomes a
   // retried transport error, which is the worse direction. Re-read that union
   // when upstream adds methods.
   "unknown_index",
] as const;

const REFUSAL_PREFIX = new RegExp(`^(${TREASURY_REFUSAL_CODES.join("|")}): `);

/**
 * The refusal code, or null when this is not a refusal.
 *
 * ⚠️ THREE PLACES, AND THE THIRD IS THE ONE THAT ACTUALLY FIRES IN PRODUCTION.
 * A cross-worker RPC boundary does not preserve a custom Error subclass: workerd
 * rebuilds the error in the calling isolate with `name` flattened to "Error" and
 * `message` carrying only the reader-facing half. The code survives ONLY in the
 * stack, whose first line upstream's thrower wrote as `no_valuation: …`.
 *
 * Measured on staging 2026-09-17, calling eeBond for a 1994 bond:
 *   name    "Error"
 *   message "no answer for that pair of dates. An EE bond issued before May…"
 *   stack   "no_valuation: no answer for that pair of dates…"
 *
 * Without the stack check both earlier branches miss, every refusal upstream
 * raises is misread as a transport failure, `treasuryRead` retries it and then
 * serves a 503 — the exact outcome its own docstring says must not happen,
 * since retrying "this bond predates the rate tables" can never help and a 503
 * tells a crawler to come back for a page that will never work.
 *
 * ⚠️ WHICH SHAPE YOU GET IS SET BY THE CALLING WORKER'S `compatibility_date`.
 * Proven on staging 2026-09-17 by deploying the SAME worker against the SAME
 * upstream twice, changing only that one field:
 *
 *   2025-04-04  message "no_valuation: no answer for that pair…"  <- prefixed
 *   2026-05-07  message "no answer for that pair…"                <- bare
 *
 * So this is not a bug one app has and another does not. apps/consumer is on
 * 2025-04-04 and its treasury pages render refusals correctly TODAY — the
 * earlier claim here that they were 503ing was wrong, and checking
 * staging.saferate.com/treasury/savings-bonds?series=EE&purchased=1994-01-01
 * disproves it in one request. apps/mcp is on 2026-05-07 and was broken.
 *
 * What that leaves is a landmine rather than an outage: BUMPING CONSUMER'S
 * COMPATIBILITY DATE, an ordinary piece of housekeeping nobody would think to
 * test treasury refusals after, silently converts every refusal page into a
 * 503. The stack branch below is what stops that, so do not "simplify" it away
 * on the grounds that the message branch already covers the live traffic.
 *
 * The in-process tests cannot catch any of this. They throw an Error they built
 * themselves, where `name` is intact and the first branch matches, so the bug
 * only exists across a real service binding.
 */
export const treasuryRefusalCode = (error: unknown) => {
   if (!(error instanceof Error)) return null;
   if ((TREASURY_REFUSAL_CODES as readonly string[]).includes(error.name)) {
      return error.name;
   }
   const fromMessage = REFUSAL_PREFIX.exec(error.message)?.[1];
   if (fromMessage !== undefined) return fromMessage;
   return REFUSAL_PREFIX.exec(error.stack ?? "")?.[1] ?? null;
};

/**
 * The reader-facing half of a refusal message, with the code prefix removed.
 *
 * Upstream's text is already written for a person — "An EE bond issued before
 * May 1995 is outside the rate tables" — so it goes on the page as-is. The
 * `no_valuation: ` prefix in front of it does not.
 */
export const treasuryRefusalMessage = (error: Error) =>
   error.message.replace(REFUSAL_PREFIX, "");

export const isTreasuryRefusal = (error: unknown) =>
   treasuryRefusalCode(error) !== null;

/**
 * Retry once, then 503 — EXCEPT for a refusal, which is re-thrown untouched.
 *
 * A cross-worker RPC call fails transiently for its own reasons (the upstream
 * worker cold-starting, its D1 overloaded) and these pages exist to be indexed,
 * so a transport failure becomes a 503: a 500 tells a crawler the page is
 * broken, a 503 tells it to come back.
 *
 * A REFUSAL IS THE OPPOSITE CASE AND MUST NOT BE RETRIED. "This bond was issued
 * before May 1995" is a deterministic answer; retrying it wastes a round trip
 * and, far worse, serving it as 503 tells a crawler to come back for a page
 * that can never work. Those surface as the original Error so the call site can
 * map them — `bad_*` and `unknown_family` to a 400, `no_valuation` to a 422 or
 * a 404 — rather than being flattened into "the upstream did not answer".
 *
 * DELIBERATELY NOT REUSING `d1Read`, which this used to do. `d1Read` retries
 * every throw, by design and for good reasons of its own, so there is no way to
 * hand it a classification. Layering on top of it would either retry refusals
 * anyway or cost a third attempt on genuine failures. The 503 policy below is
 * kept identical to it on purpose; if that policy changes there, change it here.
 *
 * NOT for "no data for that date". A weekend has no curve, and that is a 404
 * the caller decides on, not a failure.
 */
const TREASURY_RETRY_DELAY_MS = 50;

export async function treasuryRead<T>(run: () => Promise<T>, label: string) {
   try {
      return await run();
   } catch (firstError) {
      if (isTreasuryRefusal(firstError)) throw firstError;

      // biome-ignore lint/suspicious/noConsole: the Workers log is the only record of a failed read
      console.error(
         `[treasuryRead:${label}] read failed, retrying once:`,
         firstError,
      );
      await new Promise((resolve) =>
         setTimeout(resolve, TREASURY_RETRY_DELAY_MS),
      );
      try {
         return await run();
      } catch (retryError) {
         if (isTreasuryRefusal(retryError)) throw retryError;
         // biome-ignore lint/suspicious/noConsole: the Workers log is the only record of a failed read
         console.error(
            `[treasuryRead:${label}] read failed after retry, serving 503:`,
            retryError,
         );
         throw new Response("Data temporarily unavailable", { status: 503 });
      }
   }
}

/**
 * WHAT A CALLER MUST HAND US. This used to read the consuming app's generated
 * global `Env`, which worked while these functions lived inside one app and
 * stops working the moment two of them share the code: `wrangler types` emits
 * a different `Env` per worker and a package cannot see either. So the
 * requirement is stated here instead, structurally — any worker whose env
 * carries a `TREASURY` service binding satisfies it, and a worker that forgot
 * the binding fails to compile rather than returning `null` forever.
 */
export interface TTreasuryEnv {
   TREASURY: Service;
}

/**
 * The single cast. `Service` carries no method types, so exactly one expression
 * in the app asserts the shape and every caller goes through the functions
 * below.
 */
const serviceFrom = (env: TTreasuryEnv) =>
   env.TREASURY as unknown as TTreasuryService | undefined;

/**
 * The most recent fitted day and its zero curve.
 *
 * Deliberately "most recent fitted" rather than "today": weekends and holidays
 * have no curve, so asking for today's would return nothing on a Sunday. For a
 * plain rate display this is the only call needed.
 *
 * Returns null when the binding is absent, which is how a local dev run without
 * `remote: true` behaves. Callers render a degraded state rather than 500.
 */
export const getLatestCurve = async (_input: TInputGetLatestCurve) => {
   const input = ZInputGetLatestCurve.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   const result = await treasuryRead(
      () => service.latestCurve(),
      "latestCurve",
   );
   if (result === null || result.zero.length === 0) return null;

   return {
      date: result.date,
      diagnostics: ZCurveFitDiagnostics.parse(result.zero[0]),
      points: z.array(ZZeroCurvePoint).parse(result.zero),
   };
};

/**
 * `getLatestCurve`, but an unavailable upstream returns null instead of 503ing.
 *
 * FOR PAGES WHERE THE CURVE IS ONE PANEL, NOT THE POINT. `/treasury` also
 * carries what the data is, what is and is not claimed about it, and the links
 * onward — all of which are worth serving when the curve panel cannot be
 * filled. `/treasury/curves/*` is the opposite case: with no curve there is no
 * page, so those keep the 503.
 *
 * `d1Read` documents this as the intended escape hatch ("callers that wrap
 * reads in their own try/catch will absorb it and fall back to their degraded
 * value — that is intended for optional data").
 *
 * The catch is narrowed to the 503 this module raises. A `Response` is control
 * flow in React Router — redirects and 404s travel the same way — so
 * swallowing every one of them would make a redirect silently vanish. Anything
 * that is not our own 503 is re-thrown untouched, and it is re-thrown BEFORE
 * anything is logged, per the caught-Response rule in CLAUDE.md.
 */
export const getLatestCurveOptional = async (_input: TInputGetLatestCurve) => {
   try {
      return await getLatestCurve(_input);
   } catch (error) {
      if (error instanceof Response && error.status === 503) return null;
      throw error;
   }
};

/**
 * Every family fitted on one date.
 *
 * A date with no fit is not an error — it is a weekend, a holiday, or a day
 * TreasuryDirect served before end-of-day prices were posted (those are skipped
 * upstream rather than stored with every price at zero). Each family comes back
 * null independently, because the money market curve needs bills and the others
 * need coupons, so one can be absent while the rest are fine.
 */
export const getCurvesOn = async (_input: TInputGetCurvesOn) => {
   const input = ZInputGetCurvesOn.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   const result = await treasuryRead(
      () => service.curvesOn(input.date),
      `curvesOn:${input.date}`,
   );

   const zero = z.array(ZZeroCurvePoint).parse(result.zero ?? []);

   return {
      date: input.date,
      hasAnyCurve: zero.length > 0,
      lsc: parseOptionalRow(ZLscCurveDay, result.dieboldLi),
      moneyMarket: parseOptionalRow(ZMoneyMarketCurveDay, result.moneyMarket),
      par: parseOptionalRow(ZParCurveDay, result.nss),
      zero,
      zeroDiagnostics:
         zero.length > 0 ? ZCurveFitDiagnostics.parse(result.zero[0]) : null,
   };
};

/**
 * Upstream's `curveSeries` reply, in whichever of its two shapes arrived.
 *
 * IT RETURNED A BARE ARRAY AND IS BECOMING `{ rows, truncated }`. That change
 * is written upstream but at the time of writing is neither committed nor
 * deployed, so both `treasury-api` and `treasury-api-staging` still answer with
 * an array. Accepting both is what lets this branch be merged and deployed
 * TODAY and keep working after the upstream deploy, in either order and in
 * either environment independently.
 *
 * The alternative was a deploy-ordering constraint — upstream first, in both
 * environments — and that is a bad trade. Staging deployed with production not
 * would give a consumer that works in staging and 503s every curve-series page
 * in production, which is the worst possible way to discover the coupling. Five
 * lines here removes the constraint instead of documenting it.
 *
 * On the legacy path `truncated` has to be inferred, because a bare array
 * carries no flag — that inference is precisely the trap the new shape exists
 * to remove, and it is kept here only for as long as the old shape can arrive.
 *
 * DELETE THIS once `{ rows, truncated }` is deployed to both environments:
 * drop the union from `TTreasuryService.curveSeries`, drop
 * `LEGACY_CURVE_SERIES_LIMIT`, and read `result.truncated` directly.
 */
const normaliseCurveSeriesReply = (
   reply:
      | Record<string, unknown>[]
      | { rows: Record<string, unknown>[]; truncated: boolean },
) =>
   Array.isArray(reply)
      ? {
           rows: reply,
           truncated: reply.length >= LEGACY_CURVE_SERIES_LIMIT,
        }
      : reply;

/**
 * The cap the OLD shape enforced without reporting. Only used to infer
 * truncation from a bare array; goes away with the legacy path.
 */
const LEGACY_CURVE_SERIES_LIMIT = 20_000;

/**
 * The zero curve over a date range, as one row per tenor per day.
 *
 * TRUNCATION IS REPORTED WHERE POSSIBLE, INFERRED WHERE NOT. Upstream caps
 * every reply at a shared limit; the new reply shape says so with a flag, and
 * the old one leaves it to be guessed from the row count. Either way a
 * truncated reply throws rather than rendering.
 *
 * It matters because of the shape of the failure. The zero family stores TEN
 * rows per day, so the ceiling is only about 2,000 trading days — roughly eight
 * years of a possible eighteen. A full-history request therefore came back
 * holding the first eight years and looking complete, with nothing raised. A
 * page that quietly drops the back half of its own series is worse than a page
 * that fails.
 *
 * Every caller here requests at most one calendar year, about 2,520 rows, so
 * this should never fire. It exists for the caller who widens a range later.
 */
export const getZeroCurveSeries = async (_input: TInputGetZeroCurveSeries) => {
   const input = ZInputGetZeroCurveSeries.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return [];

   const reply = await treasuryRead(
      () =>
         service.curveSeries({
            family: "zero",
            from: input.from,
            to: input.to,
         }),
      `curveSeries:zero:${input.from}..${input.to}`,
   );

   const result = normaliseCurveSeriesReply(reply);

   if (result.truncated) {
      throw new Error(
         `getZeroCurveSeries(${input.from}..${input.to}) was truncated upstream, so the series is incomplete. Request a narrower range.`,
      );
   }

   return z.array(ZZeroCurvePoint).parse(result.rows);
};

/**
 * Everything one security has: its details, auctions, price history and risk.
 *
 * Three RPC calls in parallel rather than one, because that is the surface
 * upstream exposes. Returns null for an unknown CUSIP — upstream returns null
 * rather than throwing there, deliberately, because "no such security" is an
 * ordinary answer to a URL a reader typed, and the caller renders a 404.
 *
 * TWO DATES COME BACK, AND THEY DIFFER. `pricedThrough` and `analysedThrough`
 * are not the same day. A security stops getting analytics about three months
 * before it matures (a minimum-maturity filter upstream) while it carries on
 * being priced until it redeems, so 14 of the 353 coupon securities priced on
 * 2026-09-01 had analytics that stopped earlier — about 4%. A page showing one
 * date implies the risk numbers are current when they can be weeks stale.
 *
 * Both histories are capped at 5,000 rows upstream, newest first. No CUSIP
 * reaches that today: the longest history is 4,503 rows, which is every trading
 * day in the dataset. But the dataset grows by about 252 days a year, so a
 * long bond outstanding across the whole range hits the cap around 2028 and
 * would silently lose its OLDEST days. `isPriceHistoryTruncated` reports it
 * rather than letting the page quietly shorten.
 */
/**
 * The real curve on one date, or null when that date has no fit.
 *
 * Upstream REFUSES rather than returning null here — `unknown_family` carrying
 * the date — which is defensible for a request it understood and could not
 * fill. But a weekend is not an error on a page whose URL a reader can type, so
 * the refusal becomes null and the route turns that into a 404, exactly as
 * getCurvesOn does for the nominal families.
 */
/**
 * Breakeven inflation on one date: the nominal zero curve less the real one.
 *
 * SIX TENORS, not the ten the nominal curve fits. Upstream strikes a breakeven
 * only where BOTH curves publish a rate — 2, 3, 5, 7, 10 and 20 years — and
 * returns the dropped tenors in `missing` rather than interpolating one side.
 * That is the right refusal: a breakeven derived from a curve that was not
 * fitted at that tenor is a plausible number whose error is invisible.
 *
 * The difference is EXACT rather than an approximation, and only because both
 * curves publish continuously compounded rates: exp(n·t) = exp(r·t)·exp(π·t)
 * gives π = n − r with no compounding convention to get wrong. On annually
 * compounded yields the same subtraction would drift as rates rise.
 *
 * NOT EXPECTED INFLATION. It is expected inflation plus an inflation risk
 * premium less a liquidity premium on the linker, and the second is largest
 * exactly when a reader would most want to trust it — TIPS traded far below
 * fair value in late 2008, so breakevens collapsed further than any forecast
 * did. Nothing rendering this may call it a forecast.
 */
/**
 * A yield per CUSIP for one date, for whichever measure that family publishes.
 *
 * THREE TABLES, ONE SHAPE. Notes, bonds and bills carry a yield to maturity in
 * `security_analytics` (for a bill that column holds the investment rate, which
 * is coupon-equivalent and therefore comparable); linkers carry a REAL yield in
 * `tips_analytics`; floaters carry a discount margin in basis points and no
 * yield at all. The caller gets a map and a unit label, so a queue page can
 * compare members of one family without having to know which table answered.
 *
 * RESIDUALS COME BACK TOO, and they are what a premium should be struck on. The
 * off-the-run issues in a queue mature EARLIER than the benchmark — same
 * original term, auctioned earlier — so on an upward-sloping curve they yield
 * less, and the raw yield difference is dominated by that maturity gap rather
 * than by liquidity. Measured on the 2-Year note queue for 2026-09-08: yields
 * fall 4.391% to 4.365% across five ranks while the maturities shorten from 723
 * to 600 days. The residuals over the same five run -1.63, -0.76, -0.48, +0.61,
 * +1.32 bp — monotonic, with the benchmark richest, which is the premium once
 * the curve is taken out.
 *
 * Comparing ACROSS families through this would be wrong — a real yield and a
 * nominal yield are not the same quantity — which is why the unit comes back
 * with the numbers rather than being assumed by the caller.
 */
export const getQueueYields = async (_input: TInputGetQueueYields) => {
   const input = ZInputGetQueueYields.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined)
      return {
         outstanding: new Set<string>(),
         residuals: new Map<string, number>(),
         unit: "percent" as const,
         yields: new Map<string, number>(),
      };

   const empty = {
      /**
       * Cusips with an analytics row for this date, which is what separates a
       * security that is still outstanding from one that has redeemed.
       *
       * A matured security has NO row — verified across every matured member of
       * every queue on 2026-09-08 — while a live security whose yield is
       * withheld under the one-month floor still has one, with a null ytm. So
       * "has a row" is the outstanding test and "has a yield" is not: using the
       * latter would drop a security that exists and is simply inside the floor.
       */
      outstanding: new Set<string>(),
      residuals: new Map<string, number>(),
      unit: "percent" as const,
      yields: new Map<string, number>(),
   };

   if (input.kind === "TIPS") {
      const rows = await treasuryRead(
         () => service.tipsAnalyticsOn({ date: input.date }),
         `tipsAnalyticsOn:${input.date}`,
      );
      const parsed = z.array(ZTipsAnalytics).parse(rows ?? []);
      return {
         outstanding: new Set(parsed.map((row) => row.cusip)),
         residuals: new Map(
            parsed
               .filter((row) => row.residualBasisPoints !== null)
               .map((row) => [row.cusip, row.residualBasisPoints as number]),
         ),
         unit: "realPercent" as const,
         yields: new Map(
            parsed
               .filter((row) => row.realYield !== null)
               .map((row) => [row.cusip, row.realYield as number]),
         ),
      };
   }

   if (input.kind === "FRN") {
      const rows = await treasuryRead(
         () => service.frnAnalyticsOn({ date: input.date }),
         `frnAnalyticsOn:${input.date}`,
      );
      const parsed = z.array(ZFrnAnalytics).parse(rows ?? []);
      // A FLOATER NEEDS NO CURVE ADJUSTMENT. Its discount margin is already a
      // spread over the reference rate, so the difference between two margins
      // is the premium directly — there is no maturity effect to strip out the
      // way there is for a yield.
      return {
         outstanding: new Set(parsed.map((row) => row.cusip)),
         residuals: new Map(
            parsed.map((row) => [row.cusip, row.discountMarginBp]),
         ),
         unit: "marginBp" as const,
         yields: new Map(
            parsed.map((row) => [row.cusip, row.discountMarginBp]),
         ),
      };
   }

   const rows = await treasuryRead(
      () => service.analyticsOn(input.date),
      `analyticsOn:${input.date}`,
   );
   const parsed = z.array(ZSecurityAnalyticsWithCusip).parse(rows ?? []);
   return parsed.length === 0
      ? empty
      : {
           outstanding: new Set(parsed.map((row) => row.cusip)),
           residuals: new Map(
              parsed
                 .filter((row) => row.residualBasisPoints !== null)
                 .map((row) => [row.cusip, row.residualBasisPoints as number]),
           ),
           unit: "percent" as const,
           yields: new Map(
              parsed
                 .filter((row) => row.ytm !== null)
                 .map((row) => [row.cusip, row.ytm as number]),
           ),
        };
};

/**
 * One day's curves together with the previous FITTED day's, for change columns.
 *
 * The previous fitted day is read off the series rather than guessed at, for the
 * same reason the rates page does it: every weekend, every federal holiday and
 * every day Treasury served before end-of-day pricing is absent, so "yesterday"
 * is a question only the data can answer. A fourteen-day window covers the
 * longest gap in the history.
 *
 * Returns a null prior rather than failing when there is no earlier fitted day,
 * which is true of the first day of coverage and of nothing else.
 */
export const getCurvesWithPriorOn = async (_input: TInputGetCurvesOn) => {
   const input = ZInputGetCurvesOn.parse(_input);

   const lookback = new Date(
      Date.parse(`${input.date}T00:00:00Z`) - 14 * 86_400_000,
   )
      .toISOString()
      .slice(0, 10);
   const window = await getZeroCurveSeries({
      env: input.env,
      from:
         lookback < TREASURY_COVERAGE_START
            ? TREASURY_COVERAGE_START
            : lookback,
      to: input.date,
   });
   const fitted = [...new Set(window.map((point) => point.date))].sort();
   const priorDate = fitted.filter((date) => date < input.date).at(-1) ?? null;

   const [curves, priorCurves] = await Promise.all([
      getCurvesOn({ date: input.date, env: input.env }),
      priorDate === null
         ? Promise.resolve(null)
         : getCurvesOn({ date: priorDate, env: input.env }),
   ]);

   return { curves, priorCurves, priorDate };
};

export const getBreakevenOn = async (_input: TInputGetCurvesOn) => {
   const input = ZInputGetCurvesOn.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   try {
      const row = await treasuryRead(
         () => service.breakevenOn({ date: input.date }),
         `breakevenOn:${input.date}`,
      );
      return row === null ? null : ZBreakevenDay.parse(row);
   } catch (error) {
      // A date with no real curve cannot have a breakeven. Not an error on a
      // page whose other columns are fine.
      if (treasuryRefusalCode(error) === "unknown_family") return null;
      throw error;
   }
};

/**
 * The money market curve across a window, oldest first.
 *
 * Same `curveSeries` call as the zero curve with a different family key, but a
 * different ROW SHAPE at the other end: the money market curve is one wide row
 * per day carrying eight named rates, where the zero curve is one row per
 * (date, tenor). So this cannot reuse getZeroCurveSeries, and the truncation
 * guard matters less — 4,507 wide rows is a fifth of the ceiling, against the
 * zero curve's 45,070.
 */
export const getMoneyMarketSeries = async (
   _input: TInputGetZeroCurveSeries,
) => {
   const input = ZInputGetZeroCurveSeries.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return [];

   const reply = await treasuryRead(
      () =>
         service.curveSeries({
            family: "money-market",
            from: input.from,
            to: input.to,
         }),
      `curveSeries:money-market:${input.from}..${input.to}`,
   );
   const result = normaliseCurveSeriesReply(reply);
   if (result.truncated) {
      throw new Error(
         `getMoneyMarketSeries(${input.from}..${input.to}) was truncated upstream, so the series is incomplete. Request a narrower range.`,
      );
   }

   return z
      .array(ZMoneyMarketCurveDay)
      .parse(result.rows)
      .sort((left, right) => left.date.localeCompare(right.date));
};

export const getRealCurveOn = async (_input: TInputGetCurvesOn) => {
   const input = ZInputGetCurvesOn.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   try {
      const row = await treasuryRead(
         () => service.realCurve({ date: input.date }),
         `realCurve:${input.date}`,
      );
      return row === null ? null : ZRealCurveDay.parse(row);
   } catch (error) {
      if (treasuryRefusalCode(error) === "unknown_family") return null;
      throw error;
   }
};

/** The real curve across a window, oldest first, for a history plot. */
export const getRealCurveSeries = async (_input: TInputGetZeroCurveSeries) => {
   const input = ZInputGetZeroCurveSeries.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return [];

   const rows = await treasuryRead(
      () => service.realCurve({ from: input.from, to: input.to }),
      `realCurveSeries:${input.from}..${input.to}`,
   );
   return z
      .array(ZRealCurveDay)
      .parse(rows ?? [])
      .sort((left, right) => left.date.localeCompare(right.date));
};

export const getSecurity = async (_input: TInputGetSecurity) => {
   const input = ZInputGetSecurity.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   const [detailRow, priceRows, analyticsRows] = await Promise.all([
      treasuryRead(
         () => service.security(input.cusip),
         `security:${input.cusip}`,
      ),
      treasuryRead(
         () => service.securityPrices(input.cusip),
         `securityPrices:${input.cusip}`,
      ),
      treasuryRead(
         () => service.securityAnalytics(input.cusip),
         `securityAnalytics:${input.cusip}`,
      ),
   ]);

   if (detailRow === null) return null;

   const detail = ZSecurityDetail.parse(detailRow);
   // Upstream returns both histories newest-first; ascending reads better in a
   // table and is what the plots need.
   const prices = z
      .array(ZSecurityPrice)
      .parse(priceRows)
      .sort((left, right) => left.date.localeCompare(right.date));
   const analytics = z
      .array(ZSecurityAnalytics)
      .parse(analyticsRows)
      .sort((left, right) => left.date.localeCompare(right.date));

   // The family lives on the price row, not the detail row — a TIPS is stored
   // as an ordinary Bond with no flag. See ZSecurityFamily.
   const latestPrice = prices.at(-1) ?? null;
   const family =
      latestPrice === null
         ? null
         : securityFamilyFromPriceType(latestPrice.securityType);

   // FLOATERS COST A SECOND ROUND TRIP, and only floaters. Their measures live
   // in `frn_analytics`, not `security_analytics`, so the right table cannot be
   // chosen until the family is known — and the family is read off the PRICE
   // row, which is one of the calls above. Fetching both tables in parallel
   // would spend an extra call on all 2,613 securities to serve 51; serialising
   // every request would slow the common case for the same 51. So the extra
   // call is made here, after the family is known, and only when it is `frn`.
   const frnRows =
      family === "frn"
         ? await treasuryRead(
              () => service.frnAnalytics({ cusip: input.cusip }),
              `frnAnalytics:${input.cusip}`,
           )
         : [];
   const frnAnalytics = z
      .array(ZFrnAnalytics)
      .parse(frnRows)
      .sort((left, right) => left.date.localeCompare(right.date));

   const tipsRows =
      family === "tips"
         ? await treasuryRead(
              () => service.tipsAnalytics({ cusip: input.cusip }),
              `tipsAnalytics:${input.cusip}`,
           )
         : [];
   const tipsAnalytics = z
      .array(ZTipsAnalytics)
      .parse(tipsRows)
      .sort((left, right) => left.date.localeCompare(right.date));

   return {
      analysedThrough: analytics.at(-1)?.date ?? null,
      analytics,
      detail,
      family,
      frnAnalytics,
      // The nominal-analytics families. Floaters and linkers are NOT in this
      // set even though both now have measures, because "analysed" here gates
      // the nominal block — yield to maturity, key rate durations, rich/cheap
      // against the nominal curve — and neither family has those. Each carries
      // its own equivalents below.
      hasAnalysedFamily: family !== null && ANALYSED_FAMILIES.includes(family),
      frnAnalysedThrough: frnAnalytics.at(-1)?.date ?? null,
      tipsAnalysedThrough: tipsAnalytics.at(-1)?.date ?? null,
      tipsAnalytics,
      isAnalyticsHistoryTruncated:
         analyticsRows.length >= SECURITY_HISTORY_CEILING,
      isPriceHistoryTruncated: priceRows.length >= SECURITY_HISTORY_CEILING,
      latestAnalytics: analytics.at(-1) ?? null,
      latestFrnAnalytics: frnAnalytics.at(-1) ?? null,
      latestTipsAnalytics: tipsAnalytics.at(-1) ?? null,
      latestPrice,
      pricedThrough: latestPrice?.date ?? null,
      prices,
   };
};

/** Upstream's per-CUSIP history cap, for both prices and analytics. */
const SECURITY_HISTORY_CEILING = 5000;

/**
 * Why an optional section is absent, recorded rather than collapsed.
 *
 * The three readers below return null both when the METHOD is missing from the
 * stub and when the reader answers with NO ROWS. Those are a deploy problem and
 * a data problem, the page renders identically for each, and on 2026-09-11 that
 * ambiguity cost real time: three sections were absent from a staging page and
 * the null said nothing about which, so the search started in the upstream
 * database. It was neither — the deploy simply had not propagated to the edge
 * when the page was read, which a log line naming the cause would have shown
 * immediately by being absent.
 *
 * `observability` is on for this worker at full sampling with seven days of
 * retention, so one line per absent section is cheap and is the only trace
 * distinguishing the two. Not routed to `consumerErrorSink`: an optional
 * section that upstream cannot answer yet is not an error.
 */
const treasuryAbsent = (label: string, reason: "empty" | "method") => {
   // biome-ignore lint/suspicious/noConsole: the Workers log is the only record of a failed read
   console.warn(
      reason === "method"
         ? `[treasury:${label}] absent: the deployed upstream worker does not expose this method`
         : `[treasury:${label}] absent: the method answered with no rows`,
   );
   return null;
};

/**
 * How much of one security Treasury reports outstanding, and how much of that
 * is held stripped.
 *
 * NAMED FOR ITS SOURCE, NOT FOR AN ADJUSTMENT, and the earlier name
 * `getSecurityFloat` was wrong in a way that would have propagated: this is
 * NOT the float the indices weight on and it is not a float measure at all.
 * It is whatever Treasury reports in the Monthly Statement of the Public Debt,
 * and what that quantity MEANS varies by security class. At 2026-08-31, this
 * figure divided by the index's par:
 *
 *   Notes                            236 securities   mean 0.9875   min 0.8762
 *   Bonds                            110              mean 0.9812   min 0.8249
 *   Inflation-Protected Securities    53              mean 1.2963   max 2.0643
 *   Bills Maturity Value              40              mean 1.3979   max 2.6213
 *   Floating Rate Notes                8              mean 1.1050   max 1.8404
 *
 * For LINKERS the reason is established: Treasury's figure is
 * inflation-adjusted and the index's par is original par, with the uplift
 * living in the price instead. Dividing one by the other lands on the stored
 * `index_ratio` — 912810FD5 implies 2.0540 against a stored 2.0647, 912810FQ6
 * implies 1.8862 against 1.8814. So on a 2010 linker this reads about twice
 * the constituents page and both are right.
 *
 * For BILLS at 2.62 and FLOATERS at 1.84 the reason is NOT established. The
 * class is literally "Bills Maturity Value", which is a hint and not a
 * measurement, so nothing here claims a cause. Callers must not compute one
 * figure from the other or present their difference as float.
 *
 * TWO READS, because the two facts live in different upstream tables and
 * neither is keyed by CUSIP: `outstandingOn` answers per date and `stripsOn`
 * answers per date, so both come back whole and both are narrowed to one row
 * here. 463 rows and 406 rows respectively, which is the cost of asking a
 * date-keyed store a security-keyed question.
 *
 * NOT STRIPPABLE IS NOT ZERO, and the page has to tell them apart. Bills and
 * floaters carry no `security_stripped` row at all — a bill has one cashflow,
 * so there is nothing to separate, and a floater's coupons are not known in
 * advance. Both come back with `stripped: null`, which means the question does
 * not apply, against a note that genuinely has none outstanding in stripped
 * form. Measured at 2026-08-31: 912828U24 has $64.29bn outstanding of which
 * $190.45m is stripped; 912797UF2 (bill) and 91282CLT6 (floater) have an
 * outstanding figure and no stripped row.
 */
export const getSecurityOutstanding = async (
   _input: TInputGetSecurityOutstanding,
) => {
   const input = ZInputGetSecurityOutstanding.parse(_input);
   const service = serviceFrom(input.env);
   if (service?.outstandingOn === undefined)
      return treasuryAbsent("outstandingOn", "method");

   const [outstandingRows, strippedRows] = await Promise.all([
      treasuryRead(
         () =>
            service.outstandingOn?.({ date: input.on }) ?? Promise.resolve([]),
         `outstandingOn:${input.on}`,
      ),
      treasuryRead(
         () => service.stripsOn({ date: input.on }),
         `stripsOn:${input.on}`,
      ),
   ]);

   const outstanding = z
      .array(ZSecurityOutstanding)
      .parse(outstandingRows ?? [])
      .find((row) => row.cusip === input.cusip);
   if (outstanding === undefined)
      return treasuryAbsent("outstandingOn", "empty");

   const stripped = z
      .array(ZStrippedSecurity)
      .parse(strippedRows ?? [])
      .find((row) => row.cusip === input.cusip);

   return {
      outstanding: outstanding.outstanding,
      recordDate: outstanding.recordDate,
      securityClass: outstanding.securityClass,
      // Null means "this security cannot be stripped", not "none is".
      stripped: stripped?.stripped ?? null,
      strippedSharePercent:
         stripped === undefined || outstanding.outstanding === 0
            ? null
            : (stripped.stripped / outstanding.outstanding) * 100,
   };
};

/**
 * Every Series EE rate cohort, oldest period first.
 *
 * Three cohorts today, each a set of issue dates that earn under one set of
 * rules, and they do NOT pay the same rate: 3.20%, 3.39% and 2.40% for the
 * period beginning 2026-05-01. See ZEeBondRate for why that matters.
 */
export const getEeBondRates = async (_input: TInputGetEeBondRates) => {
   const input = ZInputGetEeBondRates.parse(_input);
   const service = serviceFrom(input.env);
   if (service?.eeBondRates === undefined)
      return treasuryAbsent("eeBondRates", "method");

   const rows = await treasuryRead(
      () => service.eeBondRates?.() ?? Promise.resolve([]),
      "eeBondRates",
   );
   const parsed = z.array(ZEeBondRate).parse(rows ?? []);
   if (parsed.length === 0) return treasuryAbsent("eeBondRates", "empty");

   const byCohort = new Map<string, typeof parsed>();
   for (const row of parsed) {
      byCohort.set(row.cohort, [...(byCohort.get(row.cohort) ?? []), row]);
   }
   return [...byCohort.entries()]
      .map(([cohort, periods]) => ({
         cohort,
         periods: [...periods].sort((left, right) =>
            left.periodStart.localeCompare(right.periodStart),
         ),
      }))
      .sort((left, right) => left.cohort.localeCompare(right.cohort));
};

/**
 * Every security priced on a date, narrowed to what a lookup needs.
 *
 * This is the LIVE SET: 464 securities on 2026-09-08, against 2,793 CUSIPs in
 * the archive, most of which matured years ago. The distinction matters because
 * the securities page used to say in a comment that "nothing lists them", which
 * was true before this method existed and is why its suggestions came from the
 * run queues alone.
 *
 * The price itself is dropped. A lookup needs the CUSIP and enough to recognise
 * it; carrying 464 closes would double the payload to answer a question the
 * page does not ask.
 */
export const getLiveSecuritiesOn = async (
   _input: TInputGetLiveSecuritiesOn,
) => {
   const input = ZInputGetLiveSecuritiesOn.parse(_input);
   const service = serviceFrom(input.env);
   if (service?.pricesOn === undefined)
      return treasuryAbsent("pricesOn", "method");

   const rows = await treasuryRead(
      () => service.pricesOn?.({ date: input.on }) ?? Promise.resolve([]),
      `pricesOn:${input.on}`,
   );
   const parsed = z.array(ZPriceOnDate).parse(rows ?? []);
   if (parsed.length === 0) return treasuryAbsent("pricesOn", "empty");

   return parsed
      .map((row) => ({
         couponPercent: row.couponPercent,
         cusip: row.cusip,
         family: securityFamilyFromPriceType(row.securityType),
         maturityDate: row.maturityDate,
      }))
      .sort((left, right) =>
         left.maturityDate.localeCompare(right.maturityDate),
      );
};

/**
 * Every CUSIP priced on a date, and NOTHING else about it.
 *
 * Exists beside `getLiveSecuritiesOn` rather than replacing it because the two
 * have different costs and the sitemap calls this one 216 times. The full
 * reader parses six fields per row against `ZPriceOnDate`; at roughly 460 rows
 * a date that is 100,000 parses for a document whose every entry is nine
 * characters. This narrows at the schema instead.
 *
 * `.passthrough()` is deliberate: upstream sends the whole price row and this
 * declines to describe the rest of it, rather than listing fields it does not
 * read and having to track them.
 */
export const getCusipsPricedOn = async (_input: TInputGetCusipsPricedOn) => {
   const input = ZInputGetCusipsPricedOn.parse(_input);
   const service = serviceFrom(input.env);
   if (service?.pricesOn === undefined)
      return treasuryAbsent("pricesOn", "method");

   const rows = await treasuryRead(
      () => service.pricesOn?.({ date: input.on }) ?? Promise.resolve([]),
      `pricesOn:${input.on}`,
   );
   const parsed = z
      .array(z.object({ cusip: z.string().min(1) }).passthrough())
      .parse(rows ?? []);
   return parsed.map((row) => row.cusip);
};

/**
 * The latest date the price archive holds.
 *
 * One row, where the alternative was fetching a whole curve to read its date.
 * Used as the anchor for anything that means "as of the most recent close"
 * rather than "as of the most recent fitted curve" — which are usually the same
 * day and are not the same question.
 */
export const getLatestPriceDate = async (_input: TInputGetLatestPriceDate) => {
   const input = ZInputGetLatestPriceDate.parse(_input);
   const service = serviceFrom(input.env);
   if (service?.latestPriceDate === undefined)
      return treasuryAbsent("latestPriceDate", "method");

   const row = await treasuryRead(
      () => service.latestPriceDate?.() ?? Promise.resolve(null),
      "latestPriceDate",
   );
   const parsed = z
      .union([
         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
         z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
         z.null(),
      ])
      .parse(row ?? null);
   if (parsed === null) return treasuryAbsent("latestPriceDate", "empty");
   return typeof parsed === "string" ? parsed : parsed.date;
};

/**
 * The BASE date of an index: the month-end where its level is 100.
 *
 * The base is the month-end BEFORE the first published level, so the first
 * stored level already carries a month of return. Confirmed on all eleven
 * indices — level(first row) equals 100 x (1 + that row's month return) to zero
 * error — and confirmed upstream, whose `monthEndDates()` returns 216 dates
 * from 2008-09-30 against 215 levels.
 *
 * DERIVED, NOT COPIED. Upstream publishes a `baseDate` field, but in a factsheet
 * document rather than on the RPC, so hardcoding the two dates it resolves to
 * today would be a restatement that drifts the moment an index is added — the
 * same failure as the licence wording that drifted into contradicting itself.
 * The last fitted trading day of the preceding calendar month is the rule those
 * dates came from, and it reproduces both: 2008-09-30 for the ten indices that
 * start in 2008, 2014-11-28 for the floaters.
 *
 * THE LOWER BOUND IS CLAMPED AND THE GUARD IT IS CLAMPED AGAINST IS OURS.
 * `zCoveredDate` below refuses a `from` before TREASURY_COVERAGE_START
 * ("2008-09-02"), and the very first window is one: September 2008 starts on
 * the 1st. Unclamped this 500s the calling page, and it did once. Upstream has
 * no coverage-start constant at all — its range check is ISO shape and
 * `from > to` — so anyone chasing this edge should grep THIS repository.
 * Clamping cannot move the answer, which is the LAST fitted day of the month.
 *
 * Null rather than a guess when the preceding month predates coverage, so an
 * index gets no base point rather than an invented one.
 */
export const getIndexBaseDate = async (_input: TInputGetIndexBaseDate) => {
   const input = ZInputGetIndexBaseDate.parse(_input);

   const year = Number(input.firstLevelDate.slice(0, 4));
   const month = Number(input.firstLevelDate.slice(5, 7));
   const priorYear = month === 1 ? year - 1 : year;
   const priorMonth = month === 1 ? 12 : month - 1;
   const stamp = String(priorMonth).padStart(2, "0");
   // Day 0 of the NEXT month is the last day of this one, leap years included.
   const lastDay = new Date(Date.UTC(priorYear, priorMonth, 0)).getUTCDate();
   const from = `${priorYear}-${stamp}-01`;
   const to = `${priorYear}-${stamp}-${String(lastDay).padStart(2, "0")}`;
   if (to < TREASURY_COVERAGE_START) return null;

   const points = await getZeroCurveSeries({
      env: input.env,
      from: from < TREASURY_COVERAGE_START ? TREASURY_COVERAGE_START : from,
      to,
   });
   return (
      points
         .map((point) => point.date)
         .sort()
         .at(-1) ?? null
   );
};

/**
 * One statement of the public debt, split into a headline and a breakdown.
 *
 * AS OF, NOT ON. Upstream resolves to the most recent statement at or before
 * the date, so passing today returns the current month's position and a
 * mid-month date returns that month's opening one. An EMPTY reply means the
 * date precedes the first statement (January 2001) — a real answer, not a
 * failure, and the page has to say something different for it than for a read
 * that did not land.
 *
 * THE SPLIT IS THE WHOLE POINT OF THIS FUNCTION. Treasury ships its own total
 * rows in the same table as the detail rows, marked `security_class = "_"`, so
 * summing the table double counts. Separating them here means no caller can
 * hold a list that mixes the two. See ZDebtSummaryLine for the measurements.
 *
 * The tie-out is computed and RETURNED rather than asserted, with its relative
 * gap, because the detail rows do not always sum to Treasury's own total: 25 of
 * 308 marketable statements differ, by round figures that repeat across
 * consecutive months, which is an artefact in the source file. A page can show
 * the check honestly; it must not fail on it.
 */
export const getDebtSummaryOn = async (_input: TInputGetDebtSummaryOn) => {
   const input = ZInputGetDebtSummaryOn.parse(_input);
   const service = serviceFrom(input.env);
   // The method check, not just the binding check. See TTreasuryService.
   if (service?.debtSummary === undefined)
      return treasuryAbsent("debtSummary", "method");

   const rows = await treasuryRead(
      () => service.debtSummary?.({ date: input.on }) ?? Promise.resolve([]),
      `debtSummary:${input.on}`,
   );
   const lines = z.array(ZDebtSummaryLine).parse(rows ?? []);
   // An empty reply is a REAL ANSWER here, not a failure: `debtSummary` is AS
   // OF, so it means the date precedes the first statement of January 2001.
   if (lines.length === 0) return treasuryAbsent("debtSummary", "empty");

   const details = lines.filter((line) => !line.isTotal);
   const totals = lines.filter((line) => line.isTotal);
   const headline = totals.find((line) => line.isHeadlineTotal) ?? null;

   const groupTotal = (securityType: string) =>
      totals.find((line) => line.securityType === securityType) ?? null;

   const tieOut = (securityType: string, totalType: string) => {
      const published = groupTotal(totalType);
      if (published === null) return null;
      const summed = details
         .filter((line) => line.securityType === securityType)
         .reduce((running, line) => running + line.total, 0);
      return {
         gap: summed - published.total,
         published: published.total,
         relativeGap:
            published.total === 0
               ? null
               : Math.abs(summed - published.total) / published.total,
         summed,
      };
   };

   return {
      details,
      headline,
      marketable: details.filter((line) => line.securityType === "Marketable"),
      marketableTie: tieOut("Marketable", "Total Marketable"),
      marketableTotal: groupTotal("Total Marketable"),
      nonmarketable: details.filter(
         (line) => line.securityType === "Nonmarketable",
      ),
      nonmarketableTie: tieOut("Nonmarketable", "Total Nonmarketable"),
      nonmarketableTotal: groupTotal("Total Nonmarketable"),
      recordDate: lines[0].recordDate,
   };
};

/**
 * The latest savings bond stock report, split into series and Treasury's total.
 *
 * ONE REPORT, NOT A HISTORY, and upstream pins that: `record_date` is fixed to
 * the table maximum, so this returns roughly a dozen rows out of the 1,260 the
 * table holds. The series also begins in 2019, seven years against the debt
 * summary's twenty-five, which is why nothing here is plotted against it.
 *
 * `series === "ALL"` IS TREASURY'S OWN TOTAL, NOT A SERIES, and it is the same
 * trap as `security_class = "_"` in the debt summary — in a different table,
 * with a different sentinel, and it was walked into here before being caught.
 * Summing every row rendered 542,264,326 bonds outstanding against Treasury's
 * published 271,132,163: exactly double, because the total was summed with the
 * parts. Split at the reader so no caller can mix them, which is the same
 * reasoning as getDebtSummaryOn.
 */
export const getSavingsBondStock = async (
   _input: TInputGetSavingsBondStock,
) => {
   const input = ZInputGetSavingsBondStock.parse(_input);
   const service = serviceFrom(input.env);
   if (service?.savingsBondStock === undefined)
      return treasuryAbsent("savingsBondStock", "method");

   const rows = await treasuryRead(
      () => service.savingsBondStock?.() ?? Promise.resolve([]),
      "savingsBondStock",
   );
   const parsed = z.array(ZSavingsBondStock).parse(rows ?? []);
   if (parsed.length === 0) return treasuryAbsent("savingsBondStock", "empty");

   const total = parsed.find((row) => row.series === "ALL") ?? null;
   const series = parsed.filter((row) => row.series !== "ALL");
   return { series, total };
};

/**
 * Every month of TreasuryDirect sales, oldest first.
 *
 * Retail demand rather than auction demand. Returned whole because upstream
 * takes no arguments; the caller reduces it, which is where the "last twelve
 * months" and "by series" cuts belong rather than here.
 */
export const getTreasuryDirectSales = async (
   _input: TInputGetTreasuryDirectSales,
) => {
   const input = ZInputGetTreasuryDirectSales.parse(_input);
   const service = serviceFrom(input.env);
   if (service?.treasuryDirectSales === undefined)
      return treasuryAbsent("treasuryDirectSales", "method");

   const rows = await treasuryRead(
      () => service.treasuryDirectSales?.() ?? Promise.resolve([]),
      "treasuryDirectSales",
   );
   const parsed = z.array(ZTreasuryDirectSale).parse(rows ?? []);
   return parsed.length === 0
      ? treasuryAbsent("treasuryDirectSales", "empty")
      : parsed;
};

/**
 * The current Series I and Series EE savings bond rates, and the I history.
 *
 * Treasury sets these every 1 May and 1 November, so "current" means the most
 * recent period that has started — not necessarily the newest row, since a
 * future period can be announced before it begins. Filtered on `periodStart`
 * against the caller's date rather than taking the last row.
 *
 * The two series are shaped differently on purpose. Series I has 57 periods of
 * history because its rate resets twice a year for every holder. Series EE has
 * one row, because its rate is fixed for the life of the bond, so the only
 * meaningful figure is the one a bond bought today would carry.
 */
export const getSavingsBondRates = async (
   _input: TInputGetSavingsBondRates,
) => {
   const input = ZInputGetSavingsBondRates.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   const rows = await treasuryRead(
      () => service.savingsBondRates(),
      "savingsBondRates",
   );

   const parsed = z.array(ZSavingsBondRate).parse(rows);
   const started = parsed
      .filter((rate) => rate.periodStart <= input.on)
      .sort((left, right) => left.periodStart.localeCompare(right.periodStart));

   const latestOf = (series: string) =>
      started.filter((rate) => rate.series === series).at(-1) ?? null;

   return {
      ee: latestOf("EE"),
      i: latestOf("I"),
      iHistory: started.filter((rate) => rate.series === "I"),
   };
};

/**
 * `getSavingsBondRates`, but an unavailable upstream returns null.
 *
 * The savings-bond panel is a SECTION of /treasury/rates, not the page, so it
 * must not be able to take the rates table down with it. Observed 2026-09-09:
 * `treasury-api-staging` answers `no such table: savings_bond_rates` while
 * every curve call on the same binding succeeds — the savings-bond tables are
 * loaded by a local script that has only ever been pushed to production, so the
 * two environments genuinely differ in schema despite carrying the same code.
 *
 * Narrowed to the 503 this module raises, and re-thrown before anything is
 * logged, for the same reasons as getLatestCurveOptional.
 */
export const getSavingsBondRatesOptional = async (
   _input: TInputGetSavingsBondRates,
) => {
   try {
      return await getSavingsBondRates(_input);
   } catch (error) {
      if (error instanceof Response && error.status === 503) return null;
      throw error;
   }
};

/**
 * Values one savings bond, returning either an answer or a REASON.
 *
 * `{ ok: true, value }` or `{ ok: false, reason }`, rather than throwing,
 * because "this bond cannot be valued" is an ordinary outcome of a form a
 * reader filled in and belongs on the page next to the form. Upstream throws
 * `no_valuation` for the cases that genuinely have no answer — an EE bond
 * issued before May 1995, a valuation before the purchase, or a six-month
 * window governed by a rate Treasury has not announced yet — and
 * `bad_principal` for an argument the reader can correct.
 *
 * Neither is retried and neither becomes a 503: `treasuryRead` classifies both
 * as refusals and re-throws them untouched. A transport failure still 503s,
 * which is the distinction that matters — one of those is worth trying again
 * and the other never will be.
 */
const valueSavingsBond = async <T>(
   run: () => Promise<Record<string, unknown>>,
   parse: (value: Record<string, unknown>) => T,
   label: string,
) => {
   try {
      return {
         ok: true as const,
         value: parse(await treasuryRead(run, label)),
      };
   } catch (error) {
      const code = treasuryRefusalCode(error);
      if (code !== null && error instanceof Error) {
         return {
            code,
            // "bad_*" is an argument the reader can change; "no_valuation" is a
            // date pair the series will never answer for, however it is asked.
            isCorrectable: code.startsWith("bad_"),
            ok: false as const,
            reason: treasuryRefusalMessage(error),
         };
      }
      throw error;
   }
};

/** What a Series I bond bought on one date is worth on another. */
export const valueIBond = async (_input: TInputValueSavingsBond) => {
   const input = ZInputValueSavingsBond.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   return valueSavingsBond(
      () =>
         service.iBond({
            on: input.on,
            principal: input.principal,
            purchased: input.purchased,
         }),
      (value) => ZIBondValuation.parse(value),
      `iBond:${input.purchased}`,
   );
};

/**
 * What a Series EE bond bought on one date is worth on another.
 *
 * `principal` IS WHAT WAS PAID, not the face printed on the bond. A paper EE
 * bond was sold at half its face, so $12.50 bought a $25 bond — which is why
 * upstream defaults this to 12.5 rather than to a round number, and why the
 * form has to say so.
 */
export const valueEeBond = async (_input: TInputValueSavingsBond) => {
   const input = ZInputValueSavingsBond.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   return valueSavingsBond(
      () =>
         service.eeBond({
            on: input.on,
            principal: input.principal,
            purchased: input.purchased,
         }),
      (value) => ZEeBondValuation.parse(value),
      `eeBond:${input.purchased}`,
   );
};

/**
 * Prices a Treasury bill, from either side.
 *
 * Give it a discount rate OR a price, never both — upstream refuses both and
 * neither with `bad_principal`, so the caller must choose. RATES GO IN AS
 * DECIMALS: 0.03895 for 3.895%. These functions take percent, like every other
 * rate on these pages, and convert at the boundary, so no page has to hold two
 * conventions in its head.
 *
 * Returns `{ ok }` like the savings bond valuers, because every failure here is
 * something the reader typed: a maturity before settlement, a malformed date, a
 * price no yield can produce. None of those is worth retrying and none is a
 * 503.
 */
export const priceBill = async (_input: TInputPriceBill) => {
   const input = ZInputPriceBill.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   return valueSavingsBond(
      () =>
         service.billPrice({
            discountRate:
               input.discountRatePercent === undefined
                  ? undefined
                  : input.discountRatePercent / 100,
            maturityDate: input.maturityDate,
            price: input.price,
            tradeDate: input.tradeDate,
         }),
      (value) => ZBillPrice.parse(value),
      `billPrice:${input.maturityDate}`,
   );
};

/**
 * Prices a coupon security, from either side.
 *
 * Give it a clean price OR a yield. Give it a CUSIP and the coupon, maturity
 * and frequency come from the security record, so the reader supplies a price
 * and a date and nothing else; without one, `couponRatePercent` and
 * `maturityDate` are both required and upstream refuses the request otherwise.
 *
 * Note the units asymmetry upstream: `yieldRate` goes in as a decimal and
 * `yieldToMaturity` comes back as a percentage. Both sides are normalised to
 * percent here — see ZCouponPrice.
 */
export const priceCouponSecurity = async (
   _input: TInputPriceCouponSecurity,
) => {
   const input = ZInputPriceCouponSecurity.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   return valueSavingsBond(
      () =>
         service.couponPrice({
            cleanPrice: input.cleanPrice,
            couponRate:
               input.couponRatePercent === undefined
                  ? undefined
                  : input.couponRatePercent / 100,
            cusip: input.cusip,
            frequency: input.frequency,
            maturityDate: input.maturityDate,
            tradeDate: input.tradeDate,
            yieldRate:
               input.yieldPercent === undefined
                  ? undefined
                  : input.yieldPercent / 100,
         }),
      (value) => ZCouponPrice.parse(value),
      `couponPrice:${input.cusip ?? input.maturityDate ?? "terms"}`,
   );
};

/**
 * Every security's place in its issuance queue on one date, grouped into
 * type-and-term queues.
 *
 * `basis` defaults to "issue", which ranks by when a security was ISSUED rather
 * than when it was auctioned. Those differ by a few days and can reorder two
 * securities around a month boundary, so the page states which it used.
 *
 * Returns queues ordered with the largest first, and each queue's members
 * ordered by rank so index 0 is the on-the-run issue. Only queues that actually
 * have a rank-0 member are returned: a queue whose benchmark has aged out is not
 * a queue, and upstream drops a term entirely once nothing has been auctioned
 * into it for a while rather than keeping a permanently stale benchmark.
 */
export const getRunStatusOn = async (_input: TInputGetRunStatusOn) => {
   const input = ZInputGetRunStatusOn.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   const rows = await treasuryRead(
      () => service.runStatusOn({ basis: input.basis, date: input.date }),
      `runStatusOn:${input.date}`,
   );

   const parsed = z.array(ZRunStatus).parse(rows ?? []);

   const queues = new Map<string, TRunStatus[]>();
   for (const row of parsed) {
      const key = `${row.securityKind}|${row.originalSecurityTerm}`;
      queues.set(key, [...(queues.get(key) ?? []), row]);
   }

   return {
      basis: input.basis ?? "issue",
      date: input.date,
      queues: [...queues.values()]
         .map((members) => [...members].sort((a, b) => a.runRank - b.runRank))
         .filter((members) => members[0]?.runRank === 0)
         // TYPE, THEN MATURITY ASCENDING. This sorted by queue length and then
         // by kind alphabetically, which put the 30-year bond above the 2-year
         // note and listed the notes as 10, 2, 3, 5, 7 — a string sort on the
         // term. Ordering here rather than per page means every on-the-run view
         // agrees; see RUN_KIND_ORDER and termYears.
         .sort(
            (left, right) =>
               RUN_KIND_ORDER.indexOf(left[0].securityKind) -
                  RUN_KIND_ORDER.indexOf(right[0].securityKind) ||
               termYears(left[0].originalSecurityTerm) -
                  termYears(right[0].originalSecurityTerm),
         ),
   };
};

/**
 * How much Treasury debt is held as separate principal and interest.
 *
 * Two calls: the monthly statement in force, and the whole aggregate series.
 * The series is 308 rows back to January 2001 and takes no arguments, which is
 * upstream's deliberate choice — paginating 308 rows would be machinery for
 * nothing.
 *
 * `stripsOn` resolves to the statement GOVERNING the date rather than requiring
 * an exact record date, because Treasury publishes monthly and a caller asking
 * for an arbitrary day should get the statement in force rather than an empty
 * array. Passing today therefore returns the most recent statement.
 *
 * Class shares are computed here rather than upstream because the interesting
 * cut is bonds against notes — stripping is a long-duration demand signal, so
 * it concentrates almost entirely in bonds, and an undifferentiated total hides
 * the only thing the number says.
 */
export const getStripsFloat = async (_input: TInputGetStripsFloat) => {
   const input = ZInputGetStripsFloat.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   const [securityRows, seriesRows] = await Promise.all([
      treasuryRead(
         () => service.stripsOn({ date: input.on }),
         `stripsOn:${input.on}`,
      ),
      treasuryRead(() => service.stripsSeries(), "stripsSeries"),
   ]);

   const securities = z.array(ZStrippedSecurity).parse(securityRows ?? []);
   const series = z.array(ZStrippedStatement).parse(seriesRows ?? []);
   if (securities.length === 0 || series.length === 0) return null;

   const byClass = new Map<string, { outstanding: number; stripped: number }>();
   for (const row of securities) {
      const running = byClass.get(row.securityClass) ?? {
         outstanding: 0,
         stripped: 0,
      };
      byClass.set(row.securityClass, {
         outstanding: running.outstanding + row.outstanding,
         stripped: running.stripped + row.stripped,
      });
   }

   // Trailing twelve statements of reconstitution, which is the flow that
   // makes the stripped stock a turnstile rather than a warehouse.
   const trailing = series.slice(-12);

   return {
      byClass: [...byClass.entries()]
         .map(([securityClass, totals]) => ({
            outstanding: totals.outstanding,
            securityClass,
            stripped: totals.stripped,
            strippedSharePercent:
               totals.outstanding === 0
                  ? null
                  : (totals.stripped / totals.outstanding) * 100,
         }))
         .filter((entry) => entry.stripped > 0)
         .sort((left, right) => right.stripped - left.stripped),
      latest: series[series.length - 1],
      mostStripped: [...securities]
         .filter((row) => row.strippedShareOfSize !== null)
         .sort(
            (left, right) =>
               (right.strippedShareOfSize ?? 0) -
               (left.strippedShareOfSize ?? 0),
         )
         .slice(0, 10),
      series,
      trailingReconstituted: trailing.reduce(
         (total, row) => total + row.reconstituted,
         0,
      ),
      trailingStatements: trailing.length,
   };
};

/**
 * The latest level of every published index — one row each, eleven rows.
 *
 * Ordered by the display order in INDEX_META rather than by code, so the parent
 * comes first and the maturity bands read in order. Codes present in the data
 * but unknown here are dropped rather than rendered: a new index appearing
 * upstream needs a name and a description before it belongs on a page, and
 * showing a bare code would be worse than not showing it.
 */
export const getLatestIndexLevels = async (
   _input: TInputGetLatestIndexLevels,
) => {
   const input = ZInputGetLatestIndexLevels.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return [];

   const rows = await treasuryRead(() => service.indexLevels(), "indexLevels");
   const parsed = z.array(ZIndexLevel).parse(rows ?? []);

   // INDEX_DISPLAY_ORDER, not Object.keys(INDEX_META) — see the note there.
   return parsed
      .filter((row) => isIndexCode(row.code))
      .sort(
         (left, right) =>
            INDEX_DISPLAY_ORDER.indexOf(left.code as TIndexCode) -
            INDEX_DISPLAY_ORDER.indexOf(right.code as TIndexCode),
      );
};

/**
 * One index's whole history, oldest first.
 *
 * Returns null for a code that names no index. Upstream throws `unknown_index`
 * there rather than returning empty, which is the right shape — a mistyped code
 * is a reader error and belongs as a 404, not an empty chart — so the refusal is
 * caught and converted rather than propagated as a 503.
 */
export const getIndexSeries = async (_input: TInputGetIndexSeries) => {
   const input = ZInputGetIndexSeries.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   try {
      const rows = await treasuryRead(
         () => service.indexLevels({ code: input.code }),
         `indexLevels:${input.code}`,
      );
      const parsed = z.array(ZIndexLevel).parse(rows ?? []);
      if (parsed.length === 0) return null;
      return [...parsed].sort((left, right) =>
         left.date.localeCompare(right.date),
      );
   } catch (error) {
      if (treasuryRefusalCode(error) === "unknown_index") return null;
      throw error;
   }
};

/**
 * One index's DAILY valuations, oldest first, or null when unavailable.
 *
 * GUARDED ON THE METHOD BEING PRESENT, which is the whole reason the
 * declaration carries a `?`. A missing RPC method throws a TypeError rather
 * than refusing, `treasuryRead` cannot classify that, so it retries once and
 * then 503s the entire page. An absent daily series has to degrade to one
 * missing panel, not to a dead index page.
 *
 * Null rather than throwing for `unknown_index` too, matching getIndexSeries: a
 * mistyped code is a reader error and belongs as a 404 upstream of this.
 */
export const getIndexLevelsDaily = async (
   _input: TInputGetIndexLevelsDaily,
) => {
   const input = ZInputGetIndexLevelsDaily.parse(_input);
   const service = serviceFrom(input.env);
   if (service?.indexLevelsDaily === undefined)
      return treasuryAbsent("indexLevelsDaily", "method");

   try {
      const rows = await treasuryRead(
         () =>
            service.indexLevelsDaily?.({
               code: input.code,
               ...(input.since === undefined ? {} : { since: input.since }),
            }) ?? Promise.resolve([]),
         `indexLevelsDaily:${input.code}`,
      );
      const parsed = z.array(ZIndexLevelDaily).parse(rows ?? []);
      if (parsed.length === 0)
         return treasuryAbsent("indexLevelsDaily", "empty");
      return [...parsed].sort((left, right) =>
         left.date.localeCompare(right.date),
      );
   } catch (error) {
      if (treasuryRefusalCode(error) === "unknown_index") return null;
      throw error;
   }
};

/**
 * How each index band tracked the fund that follows it.
 *
 * Ordered to match the index table rather than by code, so a reader comparing
 * the two is looking at the same sequence. Bands with no fund row are simply
 * absent — not every index has a fund tracking it.
 *
 * Optional, like the savings-bond panel: this is a validation SECTION of the
 * index page, not the page, so an unavailable feed must not take the levels
 * down with it.
 */
/**
 * One index's characteristics on its newest valuation day, or a named one.
 *
 * ALWAYS AN ARRAY, one entry per duration basis. See ZIndexAnalytics for why
 * that is not a convenience: the Aggregate has three and a caller that takes
 * `[0]` publishes its nominal sleeve as though it were the whole index.
 *
 * Omitting `date` gives the newest day THAT INDEX has, not the newest in the
 * table — upstream's choice, and the right one, because answering with another
 * index's date would be a wrong number wearing a right one's clothes.
 *
 * Empty array when the method is absent or the read fails, so a page renders
 * without the block rather than 500ing over a section that is supplementary.
 */
export const getIndexAnalytics = async (_input: TInputGetIndexAnalytics) => {
   const input = ZInputGetIndexAnalytics.parse(_input);
   const service = serviceFrom(input.env);
   if (service?.indexAnalytics === undefined) return [];

   try {
      const rows = await treasuryRead(
         () =>
            service.indexAnalytics?.({
               code: input.code,
               ...(input.date === undefined ? {} : { date: input.date }),
            }) ?? Promise.resolve([]),
         `indexAnalytics:${input.code}`,
      );
      return z.array(ZIndexAnalytics).parse(rows ?? []);
   } catch (error) {
      if (error instanceof Response && error.status === 503) return [];
      throw error;
   }
};

/**
 * Month, quarter and year to date for one index.
 *
 * Null when the method is absent or the read fails. `qtd` and `ytd` can each be
 * null INDEPENDENTLY of that, meaning the index has no level before the period
 * boundary — a young series rather than a failure, and the difference matters
 * because one renders as absent and the other as a degraded page.
 */
export const getIndexReturns = async (_input: TInputGetIndexReturns) => {
   const service = serviceFrom(_input.env);
   if (service?.indexReturns === undefined) return null;

   try {
      const row = await treasuryRead(
         () =>
            service.indexReturns?.({ code: _input.code }) ??
            Promise.resolve(null),
         `indexReturns:${_input.code}`,
      );
      return row === null || row === undefined
         ? null
         : ZIndexReturns.parse(row);
   } catch (error) {
      if (error instanceof Response && error.status === 503) return null;
      throw error;
   }
};

export const getFundComparison = async (_input: TInputGetFundComparison) => {
   const input = ZInputGetFundComparison.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return [];

   try {
      const rows = await treasuryRead(
         () => service.fundComparison(),
         "fundComparison",
      );
      return z
         .array(ZFundComparison)
         .parse(rows ?? [])
         .sort(
            (left, right) =>
               INDEX_DISPLAY_ORDER.indexOf(left.code as TIndexCode) -
               INDEX_DISPLAY_ORDER.indexOf(right.code as TIndexCode),
         );
   } catch (error) {
      if (error instanceof Response && error.status === 503) return [];
      throw error;
   }
};

/**
 * Which rebalances have published holdings for one index, newest first.
 *
 * Returned as a plain array of dates upstream. Build the page off THIS rather
 * than assuming a date resolves — which is now load-bearing in the other
 * direction: this used to return the current month alone, and returns all 215
 * rebalances since upstream backfilled them on 2026-09-10.
 *
 * Every index code has holdings now, TIPS and FRN included. Still returns an
 * empty array rather than throwing for a code that has none, so a future
 * addition degrades to an acknowledged gap instead of a broken link.
 */
export const getConstituentDates = async (_input: TInputGetIndexSeries) => {
   const input = ZInputGetIndexSeries.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return [];

   try {
      const dates = await treasuryRead(
         () => service.indexConstituents({ code: input.code }),
         `constituentDates:${input.code}`,
      );
      return z
         .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
         .parse(dates ?? [])
         .sort((left, right) => right.localeCompare(left));
   } catch (error) {
      if (treasuryRefusalCode(error) === "unknown_index") return [];
      throw error;
   }
};

/**
 * Every holding of one index at one rebalance, heaviest first.
 *
 * Upstream throws `unknown_index` both for a code that names no index AND for a
 * valid index with no holdings on that date, so a caller cannot tell those
 * apart from the error alone — which is fine here, because both are a 404 to a
 * reader. Converted rather than propagated, so neither becomes a retried 503.
 *
 * The weights and contributions are NOT summed here. The page does that from
 * the rows it received and shows the result beside the stored month return,
 * because a total computed somewhere the reader cannot see proves nothing.
 */
export const getIndexConstituents = async (
   _input: TInputGetIndexConstituents,
) => {
   const input = ZInputGetIndexConstituents.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   try {
      const rows = await treasuryRead(
         () =>
            service.indexConstituents({ code: input.code, date: input.date }),
         `constituents:${input.code}:${input.date}`,
      );
      const parsed = z.array(ZIndexConstituent).parse(rows ?? []);
      if (parsed.length === 0) return null;
      return [...parsed].sort(
         (left, right) => right.weightPercent - left.weightPercent,
      );
   } catch (error) {
      if (treasuryRefusalCode(error) === "unknown_index") return null;
      throw error;
   }
};

/**
 * What the index holds RIGHT NOW: the open period's members, heaviest first.
 *
 * THE TWIN OF getIndexConstituents, and the distinction is the reason both
 * exist. That one answers "what did it hold in August", whose contributions sum
 * to a published monthly return that is now fixed. This one answers "what does
 * it hold today", whose contributions sum to the month-to-date return and move
 * every trading day.
 *
 * ⚠️ THE SNAPSHOT'S `asOfDate` IS NOT THE PAGE'S VALUATION DATE. It has run a
 * day behind the daily levels — 2026-09-23 against 2026-09-24 when this was
 * written — and the gap is worth up to 109 basis points on the 20+ year band.
 * A caller that labels these rows with its own newest date is publishing
 * contributions that do not sum to the return printed beside them. Use the
 * `asOfDate` that comes back.
 *
 * NULL rather than a throw for all three absences, which are one thing to a
 * reader: the method is not deployed, the code names no index, or the producer
 * has not written this index's snapshot yet. The last is an ordinary state —
 * the table is filled by a daily run — so it must degrade to a missing section
 * rather than a 503 for the page around it.
 */
export const getOpenConstituents = async (
   _input: TInputGetOpenConstituents,
) => {
   const input = ZInputGetOpenConstituents.parse(_input);
   const service = serviceFrom(input.env);
   if (service?.openConstituents === undefined) return null;

   try {
      const reply = await treasuryRead(
         () =>
            service.openConstituents?.({ code: input.code }) ??
            Promise.resolve(null),
         `openConstituents:${input.code}`,
      );
      if (reply === null || reply === undefined) return null;
      const parsed = ZOpenConstituents.parse(reply);
      return parsed.rows.length === 0 ? null : parsed;
   } catch (error) {
      if (treasuryRefusalCode(error) === "unknown_index") return null;
      throw error;
   }
};

/**
 * Why `getOpenConstituents` returned null for this index.
 *
 * CALL IT ONLY ON THAT BRANCH. It is a second round trip bought to tell two
 * absences apart, and both are rare — asking for it alongside every successful
 * read would pay for it eleven times a page to answer a question nobody has.
 *
 * NULL WHEN THE METHOD IS ABSENT, which is the normal state until upstream's
 * next deploy, and the caller must render its existing sentence then rather
 * than an empty box. The `?` on the declaration is what makes an undeployed
 * upstream one missing explanation instead of a TypeError that `treasuryRead`
 * cannot classify and turns into a 503 for the page.
 *
 * NOT WRAPPED IN A REFUSAL CATCH, deliberately: this method answers about an
 * index whose code has already resolved on this page, so `unknown_index` here
 * would mean something genuinely unexpected rather than a reader's typo. It is
 * caught anyway — every failure of an explanatory call must degrade to no
 * explanation, never to a worse page than the one it was explaining.
 */
export const getOpenConstituentsStatus = async (
   _input: TInputGetOpenConstituentsStatus,
) => {
   const input = ZInputGetOpenConstituentsStatus.parse(_input);
   const service = serviceFrom(input.env);
   if (service?.openConstituentsStatus === undefined) return null;

   try {
      const reply = await treasuryRead(
         () =>
            service.openConstituentsStatus?.({ code: input.code }) ??
            Promise.resolve(null),
         `openConstituentsStatus:${input.code}`,
      );
      if (reply === null || reply === undefined) return null;
      return ZOpenConstituentsStatus.parse(reply);
   } catch {
      return null;
   }
};

/**
 * One index's stored level and month return at one rebalance.
 *
 * Exists so the constituents page can check its own arithmetic against the
 * published figure. `indexLevelsOn` returns all eleven for a date, which is
 * cheaper than pulling a 215-row history to read one row out of it.
 */
/**
 * All eleven index levels on one date, for the index overview at a past date.
 *
 * Sibling of getLatestIndexLevels, same ordering rule. Returns an empty array
 * rather than throwing for a date with no levels — index levels exist only at
 * month-ends, so a mistyped or mid-month date is an ordinary reader error and
 * the page offers a dropdown of the dates that do resolve.
 */
export const getIndexLevelsOn = async (_input: TInputGetCurvesOn) => {
   const input = ZInputGetCurvesOn.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return [];

   const rows = await treasuryRead(
      () => service.indexLevelsOn({ date: input.date }),
      `indexLevelsOn:${input.date}`,
   );
   return z
      .array(ZIndexLevel)
      .parse(rows ?? [])
      .filter((row) => isIndexCode(row.code))
      .sort(
         (left, right) =>
            INDEX_DISPLAY_ORDER.indexOf(left.code as TIndexCode) -
            INDEX_DISPLAY_ORDER.indexOf(right.code as TIndexCode),
      );
};

export const getIndexLevelOn = async (_input: TInputGetIndexConstituents) => {
   const input = ZInputGetIndexConstituents.parse(_input);
   const service = serviceFrom(input.env);
   if (service === undefined) return null;

   try {
      const rows = await treasuryRead(
         () => service.indexLevelsOn({ date: input.date }),
         `indexLevelsOn:${input.date}`,
      );
      return (
         z
            .array(ZIndexLevel)
            .parse(rows ?? [])
            .find((row) => row.code === input.code) ?? null
      );
   } catch (error) {
      if (treasuryRefusalCode(error) === "unknown_index") return null;
      throw error;
   }
};

/**
 * `curvesOn` types its three single-row families as `unknown`, and a day with
 * no fit yields null, undefined, or an empty array depending on the family. All
 * three mean "no curve that day", so they collapse to null before parsing.
 */
const parseOptionalRow = <T extends z.ZodTypeAny>(
   schema: T,
   value: unknown,
): z.infer<T> | null => {
   if (value === null || value === undefined) return null;
   if (Array.isArray(value)) {
      if (value.length === 0) return null;
      return schema.parse(value[0]);
   }
   return schema.parse(value);
};

/**
 * Coverage runs from 2008-09-02, so an earlier date is a 404 rather than a
 * request worth making. Kept loose on the upper bound: "today" is often ahead
 * of the last fitted day and that is the caller's 404, not a bad request.
 */
const zCoveredDate = z
   .string()
   .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
   .refine(
      (value) => value >= TREASURY_COVERAGE_START,
      `treasury coverage starts ${TREASURY_COVERAGE_START}`,
   );

/**
 * The env rather than the whole Cloudflare context, so these functions can be
 * called from a loader, an action or the scheduled handler alike.
 */
const zEnv = z.custom<TTreasuryEnv>(
   (value) => typeof value === "object" && value !== null,
);

const ZInputGetLatestCurve = z.object({ env: zEnv });
type TInputGetLatestCurve = z.infer<typeof ZInputGetLatestCurve>;

const ZInputGetCurvesOn = z.object({ date: zCoveredDate, env: zEnv });

const ZInputGetQueueYields = z.object({
   date: zCoveredDate,
   env: zEnv,
   kind: z.enum(["Bill", "Bond", "FRN", "Note", "TIPS"]),
});
type TInputGetQueueYields = z.infer<typeof ZInputGetQueueYields>;
type TInputGetCurvesOn = z.infer<typeof ZInputGetCurvesOn>;

/**
 * Savings bonds predate the curve history, so `purchased` is NOT bounded by
 * TREASURY_COVERAGE_START: Series I opened in September 1998 and EE rules reach
 * back to 1995, both long before the 2008 price history. Upstream refuses what
 * it cannot value; this only checks the shape.
 */
/**
 * Exactly one of the two sides, enforced here as well as upstream so a bad
 * combination never costs a round trip.
 */
const ZInputPriceBill = z
   .object({
      discountRatePercent: z.number().optional(),
      env: zEnv,
      maturityDate: z
         .string()
         .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
      price: z.number().positive().optional(),
      tradeDate: z
         .string()
         .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
         .optional(),
   })
   .refine(
      (input) =>
         (input.discountRatePercent === undefined) !==
         (input.price === undefined),
      "supply exactly one of a discount rate or a price",
   );
type TInputPriceBill = z.input<typeof ZInputPriceBill>;

const ZInputPriceCouponSecurity = z
   .object({
      cleanPrice: z.number().positive().optional(),
      couponRatePercent: z.number().min(0).optional(),
      cusip: z
         .string()
         .regex(/^[0-9A-Z]{9}$/)
         .optional(),
      env: zEnv,
      frequency: z.number().int().positive().optional(),
      maturityDate: z
         .string()
         .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
         .optional(),
      tradeDate: z
         .string()
         .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
         .optional(),
      yieldPercent: z.number().optional(),
   })
   .refine(
      (input) =>
         (input.cleanPrice === undefined) !==
         (input.yieldPercent === undefined),
      "supply exactly one of a clean price or a yield",
   )
   .refine(
      (input) =>
         input.cusip !== undefined ||
         (input.couponRatePercent !== undefined &&
            input.maturityDate !== undefined),
      "without a CUSIP, a coupon rate and a maturity date are both required",
   );
type TInputPriceCouponSecurity = z.input<typeof ZInputPriceCouponSecurity>;

const ZInputValueSavingsBond = z.object({
   env: zEnv,
   on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
      .optional(),
   principal: z.number().positive().optional(),
   purchased: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
});
type TInputValueSavingsBond = z.input<typeof ZInputValueSavingsBond>;

const ZInputGetIndexConstituents = z.object({
   code: z.string().min(1).max(16),
   date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
   env: zEnv,
});
type TInputGetIndexConstituents = z.input<typeof ZInputGetIndexConstituents>;

const ZInputGetOpenConstituents = z.object({
   code: z.string().min(1).max(16),
   env: zEnv,
});
type TInputGetOpenConstituents = z.input<typeof ZInputGetOpenConstituents>;

const ZInputGetOpenConstituentsStatus = z.object({
   code: z.string().min(1).max(16),
   env: zEnv,
});
type TInputGetOpenConstituentsStatus = z.input<
   typeof ZInputGetOpenConstituentsStatus
>;

const ZInputGetFundComparison = z.object({ env: zEnv });
type TInputGetFundComparison = z.input<typeof ZInputGetFundComparison>;

const ZInputGetLatestIndexLevels = z.object({ env: zEnv });
type TInputGetLatestIndexLevels = z.input<typeof ZInputGetLatestIndexLevels>;

/**
 * Declared HERE rather than beside getIndexAnalytics, and that is load-bearing:
 * `zEnv` is a `const` defined further down this file, and a schema built from it
 * at module scope any earlier throws a TDZ ReferenceError the moment the module
 * is imported. tsc reports that only as "Cannot find name 'zEnv'".
 */
const ZInputGetIndexAnalytics = z.object({
   code: z.string().min(1),
   date: z.string().optional(),
   env: zEnv,
});
type TInputGetIndexAnalytics = z.input<typeof ZInputGetIndexAnalytics>;

type TInputGetIndexReturns = { code: string; env: TTreasuryEnv };

const ZInputGetIndexLevelsDaily = z.object({
   code: z.string().min(1),
   env: zEnv,
   /** ISO date; omitted asks for the whole daily history. */
   since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
});

type TInputGetIndexLevelsDaily = z.infer<typeof ZInputGetIndexLevelsDaily>;

const ZInputGetIndexSeries = z.object({
   code: z.string().min(1).max(16),
   env: zEnv,
});
type TInputGetIndexSeries = z.input<typeof ZInputGetIndexSeries>;

const ZInputGetSecurityOutstanding = z.object({
   cusip: z.string().regex(/^[0-9A-Z]{9}$/, "expected a nine-character CUSIP"),
   env: zEnv,
   /** Any date; the month-end statement governing it is used. */
   on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
});
type TInputGetSecurityOutstanding = z.input<
   typeof ZInputGetSecurityOutstanding
>;

const ZInputGetEeBondRates = z.object({ env: zEnv });
type TInputGetEeBondRates = z.input<typeof ZInputGetEeBondRates>;

const ZInputGetCusipsPricedOn = z.object({
   env: zEnv,
   on: zCoveredDate,
});
type TInputGetCusipsPricedOn = z.input<typeof ZInputGetCusipsPricedOn>;

const ZInputGetLatestPriceDate = z.object({ env: zEnv });
type TInputGetLatestPriceDate = z.input<typeof ZInputGetLatestPriceDate>;

const ZInputGetLiveSecuritiesOn = z.object({
   env: zEnv,
   on: zCoveredDate,
});
type TInputGetLiveSecuritiesOn = z.input<typeof ZInputGetLiveSecuritiesOn>;

const ZInputGetIndexBaseDate = z.object({
   env: zEnv,
   /** The index's earliest published level date. */
   firstLevelDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
});
type TInputGetIndexBaseDate = z.input<typeof ZInputGetIndexBaseDate>;

const ZInputGetSavingsBondStock = z.object({ env: zEnv });
type TInputGetSavingsBondStock = z.input<typeof ZInputGetSavingsBondStock>;

const ZInputGetTreasuryDirectSales = z.object({ env: zEnv });
type TInputGetTreasuryDirectSales = z.input<
   typeof ZInputGetTreasuryDirectSales
>;

const ZInputGetDebtSummaryOn = z.object({
   env: zEnv,
   /** Any date; the statement IN FORCE on it is returned, not one matching it. */
   on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
});
type TInputGetDebtSummaryOn = z.input<typeof ZInputGetDebtSummaryOn>;

const ZInputGetStripsFloat = z.object({
   env: zEnv,
   /** Any date; the statement in force on it is returned. Defaults to today. */
   on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
});
type TInputGetStripsFloat = z.input<typeof ZInputGetStripsFloat>;

const ZInputGetRunStatusOn = z.object({
   basis: z.enum(["auction", "issue"]).optional(),
   date: zCoveredDate,
   env: zEnv,
});
type TInputGetRunStatusOn = z.input<typeof ZInputGetRunStatusOn>;

const ZInputGetSavingsBondRates = z.object({
   env: zEnv,
   /** Valuation date, so "current" is well defined and testable. */
   on: zCoveredDate,
});
type TInputGetSavingsBondRates = z.input<typeof ZInputGetSavingsBondRates>;

const ZInputGetSecurity = z.object({
   /**
    * Upper-cased before validating, so a reader who types a lowercase CUSIP in
    * the URL bar gets the page rather than a 404. The canonical form is upper.
    */
   cusip: z
      .string()
      .transform((value) => value.trim().toUpperCase())
      .pipe(
         z
            .string()
            .regex(/^[0-9A-Z]{9}$/, "a CUSIP is nine alphanumeric characters"),
      ),
   env: zEnv,
});
type TInputGetSecurity = z.input<typeof ZInputGetSecurity>;

const ZInputGetZeroCurveSeries = z
   .object({ env: zEnv, from: zCoveredDate, to: zCoveredDate })
   .refine((input) => input.from <= input.to, "from must not be after to");
type TInputGetZeroCurveSeries = z.infer<typeof ZInputGetZeroCurveSeries>;
