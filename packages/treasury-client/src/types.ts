/**
 * Shapes returned by the `TREASURY` service binding.
 *
 * `wrangler types` emits `TREASURY: Service` with no type parameter, because
 * the `TreasuryService` class lives in a different repo (saferate-treasury) and
 * nothing here can see its declaration. So the contract is written out by hand,
 * once, and every row is zod-parsed at the boundary in
 * `app/lib/treasury.server.ts`. Nothing else in the app touches the binding.
 *
 * Two things worth knowing before reading a number off any of these:
 *
 * 1. RATES ARE PERCENT, MOVES ARE BASIS POINTS. `zeroRate: 5.3094` means
 *    5.3094%, and `move10y: 3.75` means the ten-year moved 3.75bp. Mixing the
 *    two units in one chart is the obvious way to get this wrong.
 *
 * 2. `rmseBasisPoints` IS NOT DECORATION. Typical daily fit error is 3-4bp on
 *    the two Svensson families and the worst single day in the history is
 *    20.39bp (zero, 2008-12-11), where the market was genuinely dislocated
 *    rather than the fit being wrong. Check it before presenting a single day's
 *    curve as fact — see CURVE_FIT_SUSPECT_BP.
 *
 *    An earlier version of this note said September and October 2022 "run to
 *    roughly 23bp". That number is the FEDERAL RESERVE BENCHMARK DIFFERENCE,
 *    not a fit error, and the two are not comparable. Those two months peak at
 *    9.64bp (nss) and 9.14bp (zero), both on 2022-10-13.
 */
import { z } from "zod";

/**
 * The four families that may be served, keyed by the API's own short names.
 *
 * These keys are FROZEN. They appear in an intern's script and in
 * docs/api-quickstart.md, and the products were renamed without renaming them.
 * The display names are the product names; the keys are the wire format.
 *
 * There is deliberately no `swap` member. A USD swap curve is fitted and stored
 * upstream, but DTCC's dissemination terms permit internal use and NOT
 * redistribution, so it is excluded from the API, from the SQL export, and from
 * here. Adding it to this enum is the first step of shipping data we have no
 * right to publish.
 */
export const ZCurveFamily = z.enum([
   "zero",
   "nss",
   "diebold-li",
   "money-market",
]);

export type TCurveFamily = z.infer<typeof ZCurveFamily>;

/**
 * The order the families are offered in, which is not alphabetical and not the
 * order of the enum.
 *
 * Zero first because it is the one to use unless a reader has a specific reason
 * otherwise; then the two that cover ground the zero curve does not, money
 * market below a year and real in inflation-adjusted terms; then par, which is
 * for comparing against a published par curve; then LSC, which is for
 * regressing on rather than for reading a rate off.
 *
 * "real" is included even though it is not a `ZCurveFamily` — it is served by
 * its own method, not the family map. See ZRealCurveDay.
 */
export const CURVE_FAMILY_ORDER = [
   "zero",
   "money-market",
   "real",
   "nss",
   "diebold-li",
] as const;

export const CURVE_FAMILY_NAMES: Record<TCurveFamily, string> = {
   "diebold-li": "Safe Rate Treasury LSC Curve",
   "money-market": "Safe Rate Money Market Curve",
   nss: "Safe Rate Treasury Par Curve",
   zero: "Safe Rate Treasury Zero Curve",
};

/**
 * Above this daily fit error, a family's curve is shown with a caveat rather
 * than as fact.
 *
 * PER FAMILY, and it has to be. Each threshold is that family's own 95th
 * percentile across every fitted day, so the rule is uniform — flag the worst
 * 5% of days — while the number respects that the four families do not fit
 * equally tightly. Re-measured 2026-09-10 over 4,507 days, after upstream
 * refitted the curves:
 *
 *     family         mean   p50    p95     max   worst day    flags
 *     nss            3.83   3.37    6.98   19.13  2008-12-10   5.0%
 *     zero           3.79   3.08    7.37   20.39  2008-12-11   4.7%
 *     diebold-li     9.61   8.57   18.75   27.75  2008-11-03   4.2%
 *     money-market   1.95   1.41    5.61   29.37  2023-05-12   5.1%
 *
 * The refit moved nothing that matters: 4 days were added and no figure moved
 * by more than 0.03bp, so the thresholds below are unchanged and still flag
 * 4.2-5.1% of days each. The `flags` column is the measured rate at the
 * threshold actually shipped, which is the claim worth checking after a refit —
 * a threshold is only right if it still catches roughly one day in twenty.
 *
 * A single shared threshold is what makes this wrong rather than merely
 * imprecise. At 8bp — reasonable for the two Svensson families — the LSC curve
 * would be flagged on the majority of days in the history, because three
 * factors legitimately cannot bend as many ways as six and 9.58bp is its normal
 * rather than its bad. Crying wolf on 60% of days trains the reader to ignore
 * the warning on the 5% that matter.
 */
export const CURVE_FIT_SUSPECT_BP: Record<TCurveFamily, number> = {
   "diebold-li": 19,
   "money-market": 5.5,
   nss: 7,
   zero: 7.5,
};

/**
 * Longest maturity at which an instantaneous forward is published.
 *
 * MEASURED, not chosen. Against the Federal Reserve's own SVENF series across
 * 4,498 days, our forwards hold up to twenty years and then fall off a cliff:
 *
 *     tenor   meanAbs   RMSE    worst
 *     10y      3.75     5.41      26
 *     15y      6.26    10.61      66
 *     20y      5.07     7.18      49
 *     25y     16.76    27.18     143
 *     30y     35.44    60.64     306
 *
 * Twenty years is 7 bp, which is the same order as the zero curve's own 3.06
 * and the par curve's 2.10. Thirty years is 61 bp with a worst day over three
 * percentage points, and the methodology page has always said so in those
 * words — "the forwards are not usable beyond twenty years, at all" — while the
 * summary tables printed a thirty-year forward anyway. This makes the tables
 * agree with the page.
 *
 * A forward is the DERIVATIVE of the curve, so whatever is loose in the fit
 * shows up there first and largest. That is a property of differentiating a
 * fitted curve at its unconstrained end, not a missing input: no additional
 * data source would fix it, because the forward is computed from our own zero
 * curve rather than observed anywhere.
 */
export const FORWARD_MAX_TENOR_YEARS = 20;

/**
 * TWO UPSTREAM FIELDS THAT ARE SERVED BUT MUST NOT BE RENDERED, recorded here
 * beside the forward limit because it is the same kind of boundary and this is
 * where someone looks for it.
 *
 * `curveMoveOn({ date })` returns `move_03m` and `move_06m`. Both evaluate the
 * ZERO curve at 0.25 and 0.5 years, BELOW its fitted domain, so they are
 * extrapolation — and they contradict this site's own guidance to read the
 * front end off the money market curve, which is fitted from bills for exactly
 * that range. Upstream serves them because they are stored and a caller asking
 * for a row should get the row; nothing in the response says any of this.
 *
 * Nothing in this app reads `curveMoveOn` today. The note exists so that the
 * first thing built on it does not put a number on a page that the methodology
 * page already disowns.
 */
export const CURVE_MOVE_FIELDS_NOT_RENDERABLE = [
   "move_03m",
   "move_06m",
] as const;

/**
 * WHY THERE IS NO RPC METHOD FOR THE ECONOMIC SERIES, and why that is not a gap
 * to be helpfully filled.
 *
 * `economicSeries` and `economicSeriesMeta` exist upstream as HTTP routes and
 * are deliberately NOT on the RPC entrypoint. Their licence check lives in the
 * ROUTE, which 403s a restricted series, and not in the reader — so an RPC
 * wrapper would republish the CBOE, ICE, University of Michigan and Freddie Mac
 * series that FRED redistributes under agreements which do not extend to us.
 *
 * For observations use `series`, which reads a different function that filters
 * `licence != 'restricted'` in its own SQL. `seriesCatalogue` is discovery only
 * and does list restricted entries, each carrying a notice, so an obligation is
 * met before anything is built against a series that cannot be served.
 *
 * This app reads no economic series at all today — `availableSeries` is
 * declared on the service type and never called. If that changes, the rule
 * above is the one to follow rather than reaching for whatever reader looks
 * closest.
 */
export const ECONOMIC_SERIES_READER = "series" as const;

/**
 * TWO NEWLY EXPOSED METHODS THIS APP DELIBERATELY DOES NOT CALL, recorded so
 * the decision is visible rather than looking like an oversight.
 *
 * `curveMoveOn` — the curves page already shows a one-day change at every
 * tenor, computed from the prior fitted day it ALREADY fetches. Reading the
 * stored move as well would put a second, differently-computed answer to the
 * same question on the same page, at a fixed set of tenors we do not choose,
 * two of which must not be rendered at all. A page that answers "how much did
 * the curve move" twice will eventually answer it twice differently.
 *
 * `seriesCatalogue` — this app publishes no economic series, so a catalogue of
 * them would be a list of things a reader cannot get here. It is the right
 * method for a client that intends to consume the series and the wrong one for
 * a site that does not. If that changes, read the licence note above first: the
 * catalogue lists restricted entries deliberately, each carrying a notice,
 * because discovery is where the obligation is meant to be met.
 */
export const RPC_METHODS_NOT_USED = ["curveMoveOn", "seriesCatalogue"] as const;

/** First day with a fitted curve. Nothing before this exists at any route. */
export const TREASURY_COVERAGE_START = "2008-09-02";

const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** SQLite has no boolean; the curve tables store 0/1 integers. */
const zSqliteBoolean = z.union([z.literal(0), z.literal(1)]).transform(Boolean);

/**
 * Per-day fit diagnostics. Repeated on every row of a day's zero curve, so it
 * is parsed off whichever row comes first rather than being its own query.
 */
export const ZCurveFitDiagnostics = z
   .object({
      converged: zSqliteBoolean,
      date: zIsoDate,
      lambda_1: z.number(),
      lambda_2: z.number(),
      rmse_basis_points: z.number(),
      rmse_price_cents: z.number(),
      security_count: z.number().int(),
      theta_0: z.number(),
      theta_1: z.number(),
      theta_2: z.number(),
      theta_3: z.number(),
   })
   .transform((row) => ({
      date: row.date,
      hasConverged: row.converged,
      lambda1: row.lambda_1,
      lambda2: row.lambda_2,
      rmseBasisPoints: row.rmse_basis_points,
      rmsePriceCents: row.rmse_price_cents,
      securityCount: row.security_count,
      theta0: row.theta_0,
      theta1: row.theta_1,
      theta2: row.theta_2,
      theta3: row.theta_3,
   }));

export type TCurveFitDiagnostics = z.infer<typeof ZCurveFitDiagnostics>;

/**
 * One tenor on one day of the zero curve. Ten per day: 1, 2, 3, 5, 7, 10, 15,
 * 20, 25 and 30 years.
 */
export const ZZeroCurvePoint = z
   .object({
      date: zIsoDate,
      forward_rate: z.number(),
      par_yield: z.number(),
      tenor_years: z.number(),
      zero_rate: z.number(),
   })
   .transform((row) => ({
      date: row.date,
      forwardRate: row.forward_rate,
      parYield: row.par_yield,
      tenorYears: row.tenor_years,
      zeroRate: row.zero_rate,
   }));

export type TZeroCurvePoint = z.infer<typeof ZZeroCurvePoint>;

/**
 * The par curve, as stored: one row per day carrying thirteen fitted tenors.
 *
 * This is the family to compare against a published par curve, and the wrong
 * choice for anything else — it carries a coupon effect the zero curve does
 * not. Use `zero` to discount a cashflow.
 */
export const ZParCurveDay = z
   .object({
      converged: zSqliteBoolean,
      date: zIsoDate,
      max_residual_basis_points: z.number(),
      rate_02y: z.number(),
      rate_03m: z.number(),
      rate_03y: z.number(),
      rate_04m: z.number(),
      rate_05y: z.number(),
      rate_06m: z.number(),
      rate_07y: z.number(),
      rate_10y: z.number(),
      rate_12m: z.number(),
      rate_15y: z.number(),
      rate_20y: z.number(),
      rate_25y: z.number(),
      rate_30y: z.number(),
      rmse_basis_points: z.number(),
      security_count: z.number().int(),
   })
   .transform((row) => ({
      date: row.date,
      hasConverged: row.converged,
      maxResidualBasisPoints: row.max_residual_basis_points,
      rates: [
         { label: "3M", rate: row.rate_03m, tenorYears: 0.25 },
         { label: "4M", rate: row.rate_04m, tenorYears: 1 / 3 },
         { label: "6M", rate: row.rate_06m, tenorYears: 0.5 },
         { label: "1Y", rate: row.rate_12m, tenorYears: 1 },
         { label: "2Y", rate: row.rate_02y, tenorYears: 2 },
         { label: "3Y", rate: row.rate_03y, tenorYears: 3 },
         { label: "5Y", rate: row.rate_05y, tenorYears: 5 },
         { label: "7Y", rate: row.rate_07y, tenorYears: 7 },
         { label: "10Y", rate: row.rate_10y, tenorYears: 10 },
         { label: "15Y", rate: row.rate_15y, tenorYears: 15 },
         { label: "20Y", rate: row.rate_20y, tenorYears: 20 },
         { label: "25Y", rate: row.rate_25y, tenorYears: 25 },
         { label: "30Y", rate: row.rate_30y, tenorYears: 30 },
      ],
      rmseBasisPoints: row.rmse_basis_points,
      securityCount: row.security_count,
   }));

export type TParCurveDay = z.infer<typeof ZParCurveDay>;

/**
 * The Diebold-Li factor model: level, slope and curvature as daily series.
 *
 * This is the family to regress on. The Svensson coefficients change sign every
 * third day while describing a curve that moved five basis points, so a
 * regression on those measures noise.
 */
export const ZLscCurveDay = z
   .object({
      beta_0: z.number(),
      beta_1: z.number(),
      beta_2: z.number(),
      curvature: z.number(),
      date: zIsoDate,
      implied_short_rate: z.number(),
      lambda: z.number(),
      level: z.number(),
      rate_01y: z.number(),
      rate_02y: z.number(),
      rate_03m: z.number(),
      rate_03y: z.number(),
      rate_05y: z.number(),
      rate_06m: z.number(),
      rate_07y: z.number(),
      rate_10y: z.number(),
      rate_20y: z.number(),
      rate_30y: z.number(),
      rmse_basis_points: z.number(),
      security_count: z.number().int(),
      slope: z.number(),
   })
   .transform((row) => ({
      beta0: row.beta_0,
      beta1: row.beta_1,
      beta2: row.beta_2,
      curvature: row.curvature,
      date: row.date,
      impliedShortRate: row.implied_short_rate,
      lambda: row.lambda,
      level: row.level,
      rates: [
         { label: "3M", rate: row.rate_03m, tenorYears: 0.25 },
         { label: "6M", rate: row.rate_06m, tenorYears: 0.5 },
         { label: "1Y", rate: row.rate_01y, tenorYears: 1 },
         { label: "2Y", rate: row.rate_02y, tenorYears: 2 },
         { label: "3Y", rate: row.rate_03y, tenorYears: 3 },
         { label: "5Y", rate: row.rate_05y, tenorYears: 5 },
         { label: "7Y", rate: row.rate_07y, tenorYears: 7 },
         { label: "10Y", rate: row.rate_10y, tenorYears: 10 },
         { label: "20Y", rate: row.rate_20y, tenorYears: 20 },
         { label: "30Y", rate: row.rate_30y, tenorYears: 30 },
      ],
      rmseBasisPoints: row.rmse_basis_points,
      securityCount: row.security_count,
      slope: row.slope,
   }));

export type TLscCurveDay = z.infer<typeof ZLscCurveDay>;

/**
 * Breakeven inflation for one date, as upstream returns it.
 *
 * `missing` carries the tenors where a breakeven could NOT be struck because
 * one curve had no rate there. Kept rather than dropped, so a page can say
 * which maturities are absent instead of silently showing a shorter table.
 */
export const ZBreakevenDay = z
   .object({
      date: zIsoDate,
      missing: z.array(z.number()),
      // CAMELCASE, unlike every other shape in this file. These are not database
      // rows: upstream computes the breakeven and returns its own
      // `TBreakevenPoint` objects, so there is no snake_case column to map from.
      points: z.array(
         z.object({
            breakeven: z.number(),
            nominal: z.number(),
            real: z.number(),
            tenorYears: z.number(),
         }),
      ),
   })
   .transform((row) => ({
      date: row.date,
      missingTenors: row.missing,
      /** Percent throughout. Nominal less real, exactly — see getBreakevenOn. */
      points: row.points,
   }));

export type TBreakevenDay = z.infer<typeof ZBreakevenDay>;

/**
 * A `security_analytics` row that carries its CUSIP.
 *
 * `ZSecurityAnalytics` deliberately does not: it is parsed from
 * `securityAnalytics(cusip)`, where the CUSIP was the argument and repeating it
 * on every row would be noise. A whole-day read has to identify each row, so
 * this is the same schema with the key kept.
 */
export const ZSecurityAnalyticsWithCusip = z
   .object({
      cusip: z.string(),
      residual_basis_points: z.number().nullable(),
      ytm: z.number().nullable(),
   })
   .passthrough()
   .transform((row) => ({
      cusip: row.cusip,
      /** Yield less the fitted curve at this security's own maturity. */
      residualBasisPoints: row.residual_basis_points,
      ytm: row.ytm,
   }));

/**
 * The fitted REAL curve, from inflation-linked securities.
 *
 * A FIFTH CURVE, BUT NOT A FIFTH `ZCurveFamily`. The four family keys are the
 * wire format for `curveSeries({ family })`, and upstream does not serve the
 * real curve through that map — it has its own `realCurve({ date | from, to })`
 * method. So adding "real" to that enum would name a key the API rejects.
 * `/treasury/curves/real` is handled by its own branch instead.
 *
 * EVERY RATE IS A REAL YIELD, which is the point: a return above inflation, not
 * in cash terms. The 10-year here sitting near 2.4% while the nominal zero
 * curve is near 4.1% is not a discrepancy — the difference between them is
 * roughly inflation compensation, and is NOT a forecast. Do not label it one.
 *
 * SEVEN TENORS, 2 to 30 years, against the nominal curve's ten from 1 to 30.
 * There is no real curve inside two years because there are rarely enough
 * short-dated linkers to fit one, and no forward or par series because neither
 * is published for this family.
 *
 * It fits less tightly than the nominal curves and the reason is structural:
 * 24 to 46 linkers on any given day against 350-odd nominal coupons. Measured
 * over all 4,507 days on 2026-09-10 — mean 6.21bp, median 5.55, p95 8.91, worst
 * 48.28 on 2008-12-02 — and 103 days did not converge, against 16 for the par
 * fit. Both figures belong on the page rather than in a footnote.
 */
export const ZRealCurveDay = z
   .object({
      converged: zSqliteBoolean,
      date: zIsoDate,
      max_price_error_cents: z.number(),
      rate_02y: z.number(),
      rate_03y: z.number(),
      rate_05y: z.number(),
      rate_07y: z.number(),
      rate_10y: z.number(),
      rate_20y: z.number(),
      rate_30y: z.number(),
      rmse_basis_points: z.number(),
      tips_count: z.number().int(),
   })
   .transform((row) => ({
      date: row.date,
      hasConverged: row.converged,
      maxPriceErrorCents: row.max_price_error_cents,
      /** Real yields in PERCENT, shaped like the other curve days. */
      rates: [
         { label: "2Y", rate: row.rate_02y, tenorYears: 2 },
         { label: "3Y", rate: row.rate_03y, tenorYears: 3 },
         { label: "5Y", rate: row.rate_05y, tenorYears: 5 },
         { label: "7Y", rate: row.rate_07y, tenorYears: 7 },
         { label: "10Y", rate: row.rate_10y, tenorYears: 10 },
         { label: "20Y", rate: row.rate_20y, tenorYears: 20 },
         { label: "30Y", rate: row.rate_30y, tenorYears: 30 },
      ],
      rmseBasisPoints: row.rmse_basis_points,
      /** How many linkers entered the fit. 24-46 across the history. */
      tipsCount: row.tips_count,
   }));

export type TRealCurveDay = z.infer<typeof ZRealCurveDay>;

/**
 * Above this daily fit error the real curve is shown with a caveat.
 *
 * Its own p95 (8.91), rounded to 9, which flags 4.9% of the 4,507 days — the
 * same "worst 5%" rule as CURVE_FIT_SUSPECT_BP, kept separate because the real
 * curve is not a member of that enum.
 */
export const REAL_CURVE_FIT_SUSPECT_BP = 9;

/**
 * The sub-one-year segment, fitted from bills alone.
 *
 * `convention` is "bond equivalent" throughout the history, and matters: a bill
 * is quoted on a discount basis, so a bond-equivalent yield is a conversion
 * rather than the quoted number.
 */
export const ZMoneyMarketCurveDay = z
   .object({
      bill_count: z.number().int(),
      converged: zSqliteBoolean,
      convention: z.string(),
      date: zIsoDate,
      implied_overnight: z.number(),
      max_residual_basis_points: z.number(),
      rate_01m: z.number(),
      rate_01w: z.number(),
      rate_02m: z.number(),
      rate_03m: z.number(),
      rate_04m: z.number(),
      rate_06m: z.number(),
      rate_09m: z.number(),
      rate_12m: z.number(),
      rmse_basis_points: z.number(),
   })
   .transform((row) => ({
      billCount: row.bill_count,
      convention: row.convention,
      date: row.date,
      hasConverged: row.converged,
      impliedOvernight: row.implied_overnight,
      maxResidualBasisPoints: row.max_residual_basis_points,
      rates: [
         { label: "1W", rate: row.rate_01w, tenorYears: 7 / 365 },
         { label: "1M", rate: row.rate_01m, tenorYears: 1 / 12 },
         { label: "2M", rate: row.rate_02m, tenorYears: 2 / 12 },
         { label: "3M", rate: row.rate_03m, tenorYears: 0.25 },
         { label: "4M", rate: row.rate_04m, tenorYears: 1 / 3 },
         { label: "6M", rate: row.rate_06m, tenorYears: 0.5 },
         { label: "9M", rate: row.rate_09m, tenorYears: 0.75 },
         { label: "1Y", rate: row.rate_12m, tenorYears: 1 },
      ],
      rmseBasisPoints: row.rmse_basis_points,
   }));

export type TMoneyMarketCurveDay = z.infer<typeof ZMoneyMarketCurveDay>;

/* ─── Securities ─────────────────────────────────────────────────────────── */

/**
 * The five instrument families, as the PRICE file names them.
 *
 * THE CLASSIFICATION LIVES ON THE PRICE ROW, NOT THE DETAIL ROW, and this is
 * the one non-obvious thing about rendering a security.
 * `security_details.security_type` has exactly three values — Bill, Bond, Note
 * — so a TIPS is stored as an ordinary "Bond" or "Note" with no flag marking it
 * as inflation-linked (verified: 912810FD5 is `Bond`, `floating_rate` 0, and it
 * is a linker). An FRN is at least detectable there via `floating_rate`, but a
 * TIPS is not detectable at all.
 *
 * `treasury_prices.security_type` carries the real five-way split, and no CUSIP
 * in 1.7M rows ever changes it, so the latest price row is a stable
 * discriminator. Classify from that; never infer a linker from the detail row.
 */
export const ZSecurityFamily = z.enum(["bill", "bond", "frn", "note", "tips"]);

export type TSecurityFamily = z.infer<typeof ZSecurityFamily>;

const PRICE_TYPE_TO_FAMILY: Record<string, TSecurityFamily> = {
   "MARKET BASED BILL": "bill",
   "MARKET BASED BOND": "bond",
   "MARKET BASED FRN": "frn",
   "MARKET BASED NOTE": "note",
   TIPS: "tips",
};

export const securityFamilyFromPriceType = (priceType: string) =>
   PRICE_TYPE_TO_FAMILY[priceType] ?? null;

/**
 * Which families this app can currently render nominal analytics for.
 *
 * BILLS ARE IN THIS SET, and the comment that used to say their rows "are not
 * in production yet" was simply out of date. `security_analytics` holds 177,747
 * bill rows across 1,439 CUSIPs from 2008-09-02 to the latest close, with ytm,
 * duration, DV01, convexity and both residuals populated on every one — the
 * same completeness as the 983,938 note rows. Staging was rendering "analytics
 * for this security type are not published yet" over a complete dataset.
 *
 * Two things about a bill differ from a coupon and are handled at the render
 * site rather than here, because they are presentation and not coverage:
 *
 *   - Its residual is struck against the MONEY MARKET curve, not the nominal
 *     zero curve. Identified rather than assumed: the largest |residual| among
 *     the 49 bills analysed on 2026-09-08 is 7.624768 bp, and
 *     `money_market_curves.max_residual_basis_points` for that date is
 *     7.624767606241578. The heading has to name the right curve.
 *   - Its entire rate sensitivity sits in one key-rate bucket, because it has
 *     one cashflow. A twelve-bucket profile with eleven empty bars says less
 *     than one sentence does.
 *
 * TIPS and FRNs stay out: they need a real yield and a discount margin
 * respectively, which are different quantities rather than missing ones and
 * land in their own tables, so a greyed-out "modified duration" on a linker
 * would be the wrong measure omitted rather than an honest gap. Each has its
 * own block on the page.
 */
export const ANALYSED_FAMILIES: readonly TSecurityFamily[] = [
   "bill",
   "bond",
   "note",
];

/**
 * Days to maturity inside which a bill's residual is quoted as a price.
 *
 * Upstream's own floor for coupons, reused deliberately rather than chosen:
 * inside a month it withholds a coupon's yield and its yield residual. Bills
 * never got that treatment, so this app applies it at the render site. See
 * `app/utils/treasuryResidual.ts` for the measurements — 1,435 bp and a z-score
 * of 1,039 five days from redemption, against 3.9 cents on the same row.
 */
export const BILL_ANNUALISATION_FLOOR_DAYS = 30;

const zCusip = z
   .string()
   .regex(/^[0-9A-Z]{9}$/, "a CUSIP is nine uppercase alphanumeric characters");

/** One auction of one security. Reopenings mean a CUSIP can have several. */
export const ZSecurityAuction = z
   .object({
      auction_date: zIsoDate,
      bid_to_cover_ratio: z.number().nullable(),
      high_yield: z.number().nullable(),
      issue_date: zIsoDate,
      offering_amount: z.number().nullable(),
      original_security_term: z.string(),
      reopening: zSqliteBoolean,
      total_accepted: z.number().nullable(),
   })
   .transform((row) => ({
      auctionDate: row.auction_date,
      bidToCoverRatio: row.bid_to_cover_ratio,
      highYield: row.high_yield,
      isReopening: row.reopening,
      issueDate: row.issue_date,
      offeringAmount: row.offering_amount,
      originalSecurityTerm: row.original_security_term,
      totalAccepted: row.total_accepted,
   }));

export type TSecurityAuction = z.infer<typeof ZSecurityAuction>;

/**
 * `security(cusip)`: the detail row with its auction history attached.
 *
 * `interest_rate` here is a PERCENT (2 for a 2% note). The price row's `rate`
 * is a DECIMAL (0.02 for the same security). They are different units on
 * fields with almost the same name, which is why both are renamed on the way
 * through.
 */
export const ZSecurityDetail = z
   .object({
      auctions: z.array(ZSecurityAuction).default([]),
      callable: zSqliteBoolean,
      cusip: zCusip,
      dated_date: zIsoDate.nullable(),
      first_interest_payment_date: zIsoDate.nullable(),
      floating_rate: zSqliteBoolean,
      interest_payment_frequency: z.string().nullable(),
      interest_rate: z.number().nullable(),
      maturity_date: zIsoDate,
      original_security_term: z.string(),
      security_type: z.string(),
      spread: z.number().nullable(),
   })
   .transform((row) => ({
      auctions: row.auctions,
      couponPercent: row.interest_rate,
      cusip: row.cusip,
      datedDate: row.dated_date,
      detailSecurityType: row.security_type,
      firstInterestPaymentDate: row.first_interest_payment_date,
      hasFloatingRate: row.floating_rate,
      isCallable: row.callable,
      maturityDate: row.maturity_date,
      originalSecurityTerm: row.original_security_term,
      paymentFrequency: row.interest_payment_frequency,
      spread: row.spread,
   }));

export type TSecurityDetail = z.infer<typeof ZSecurityDetail>;

/**
 * One day's price for one security.
 *
 * `buy` OF ZERO MEANS THERE WAS NO BID, not that the security was worth
 * nothing. 118,359 of 1,700,678 rows carry it — about 7% — including 32 of the
 * securities priced on 2026-09-01, and a real example is 912797RS8 on
 * 2026-09-01 with buy 0 against a close of 99.99. It is mapped to null here so
 * that no page can render a zero into a bid column, which would be the most
 * visibly wrong number on the page.
 *
 * `close` of zero is a different thing and is filtered upstream: it means
 * Treasury served the file before end-of-day pricing, and such a day is skipped
 * rather than stored.
 */
export const ZSecurityPrice = z
   .object({
      buy: z.number(),
      close: z.number(),
      date: zIsoDate,
      rate: z.number(),
      security_type: z.string(),
      sell: z.number(),
   })
   .transform((row) => ({
      bid: row.buy === 0 ? null : row.buy,
      close: row.close,
      couponPercent: row.rate * 100,
      date: row.date,
      offer: row.sell === 0 ? null : row.sell,
      securityType: row.security_type,
   }));

export type TSecurityPrice = z.infer<typeof ZSecurityPrice>;

/** The twelve key-rate tenors, in the order the columns appear. */
export const KEY_RATE_TENORS = [
   { column: "krd_03m", label: "3M", years: 0.25 },
   { column: "krd_06m", label: "6M", years: 0.5 },
   { column: "krd_01y", label: "1Y", years: 1 },
   { column: "krd_02y", label: "2Y", years: 2 },
   { column: "krd_03y", label: "3Y", years: 3 },
   { column: "krd_05y", label: "5Y", years: 5 },
   { column: "krd_07y", label: "7Y", years: 7 },
   { column: "krd_10y", label: "10Y", years: 10 },
   { column: "krd_15y", label: "15Y", years: 15 },
   { column: "krd_20y", label: "20Y", years: 20 },
   { column: "krd_25y", label: "25Y", years: 25 },
   { column: "krd_30y", label: "30Y", years: 30 },
] as const;

/**
 * One day's risk numbers for one security.
 *
 * `residualZScore` IS NULL FAR MORE OFTEN THAN "under twenty observations"
 * suggests. It is filled by a separate ordered sweep rather than by the run
 * that writes the row, so a rebuild of the table leaves it empty until the
 * sweep runs again — observed 2026-09-09, when an analytics backfill took the
 * local store from 1.24M scored rows to 272. Treat absent as "not scored",
 * render it as such, and never infer a security is fairly priced from a missing
 * score.
 *
 * For a BILL these columns do not mean what a note's do: `ytm` holds the
 * investment rate (coupon-equivalent, so comparable), `modifiedDuration` is
 * differentiated from the bond-equivalent convention rather than being
 * macaulay/(1+y/2), and `residualBasisPoints` is struck against the money
 * market curve. Bills are not rendered on the note/bond template.
 *
 * ONLY `ytm` IS EVER NULL, and a null there means WITHHELD rather than missing.
 * Inside a month of maturity a Treasury trades on settlement mechanics and its
 * quote is a rounding of par, so upstream declines to publish a yield rather
 * than publishing a meaningless one: 0.156 of a point earned over two days
 * annualises to 34.71%. 16,918 rows are affected as of the 2026-09-10
 * correction, and 329 stored rows above 8% had been sitting inside thirty days
 * without tripping any sanity bound.
 *
 * DURATION, DV01 AND CONVEXITY SURVIVE, and they are declared non-nullable to
 * say so. Measured upstream across all 16,918 withheld rows: zero nulls in any
 * of them. The reason is that they are not yield-derived in the way that
 * matters — Macaulay duration of a two-day security is two days whatever yield
 * you plug in, and the yield enters only through a (1 + y/2) factor that barely
 * moves it. It is ANNUALISATION that makes the yield meaningless, and duration
 * annualises nothing.
 *
 * That is why these are strict rather than defensively nullable. If one of them
 * ever does arrive null, the parse should fail loudly — because "withheld"
 * would then be the wrong word for a reason nobody has established yet, and a
 * plausible-looking wrong label is worse than a 503.
 *
 * EVERY OTHER COLUMN ON A WITHHELD ROW IS GOOD — the dirty price, both
 * residuals and all twelve key rate durations. The page shows the row and
 * explains the gap; it does not drop the observation.
 */
/**
 * One day of inflation-linked (TIPS) analytics for one security.
 *
 * PERCENTS AND MULTIPLIERS HERE, DECIMALS IN THE FLOATER TABLE. Confirmed with
 * upstream 2026-09-10, because the two tables disagree and nothing in the column
 * names says so: `real_yield` 2.425 means 2.425%, while
 * `frn_analytics.discount_margin` 0.000525 means 5.25 bp. No conversion is
 * needed on this side; the trap is assuming symmetry with ZFrnAnalytics.
 *
 * `index_ratio` IS A MULTIPLIER, NOT A PERCENT AND NOT A CHANGE. 2.0647 means
 * the principal has slightly more than doubled since the dated date. It ranges
 * 0.975 to 2.0716 across the table, and BELOW ONE IS CORRECT: the inflation
 * floor applies to the final REDEMPTION, where a linker pays the greater of par
 * and its indexed principal, not to the ratio along the way. A ratio of 0.975 is
 * the CPI having fallen since that security's dated date, which happened, and
 * clamping it would be inventing a protection that does not exist until maturity.
 *
 * THE PRICES ARE REAL AND ARE NOT MULTIPLIED BY THE RATIO. This is the one
 * upstream flagged as most likely to be rendered wrong, and it would be: to get
 * what a holder actually pays, multiply `real_clean_price` by `index_ratio`. The
 * transform therefore names every real field `real*` and exposes the money price
 * as a separate computed field, so the multiplication is done once here rather
 * than being forgotten in a component.
 *
 * THREE FIELDS ARE NULLABLE AND WERE NOT UNTIL 2026-09-10. Upstream withholds
 * `real_yield`, `residual_basis_points` and `residual_z_score` together once
 * less than one month of the security's life remains — the same
 * MIN_YIELD_MATURITY_YEARS = 1/12 floor it applies to nominal coupon securities,
 * imported rather than restated so the two cannot drift. Before that fix these
 * reached a real yield of 47.59% and a residual of 4,799 bp two days from
 * redemption. The durations and the CENTS residual are untouched, because none of
 * them annualises: 912828ET3 two days out is a real -13.14 cents on a duration of
 * 0.0027 years and both are sound.
 */
export const ZTipsAnalytics = z
   .object({
      accrued_real: z.number(),
      convexity: z.number(),
      cusip: z.string(),
      date: zIsoDate,
      dv01: z.number(),
      index_ratio: z.number(),
      indexed_principal: z.number(),
      macaulay_duration: z.number(),
      modified_duration: z.number(),
      price_residual_cents: z.number(),
      real_clean_price: z.number(),
      real_dirty_price: z.number(),
      /** Percent. Null under a month to maturity — see the note above. */
      real_yield: z.number().nullable(),
      residual_basis_points: z.number().nullable(),
      residual_z_score: z.number().nullable(),
   })
   .transform((row) => ({
      accruedReal: row.accrued_real,
      /**
       * ⚠️ DIVIDED BY 100, WHICH IS THE REPORTING CONVENTION AND NOT A FUDGE.
       *
       * Upstream stores the raw textbook quantity, (1/P) d2P/dy2 in years
       * squared, and it is correct: pricing a 30-year 4.75% at 5% by hand and
       * taking a central second difference reproduces its 358.2180 to
       * finite-difference truncation. S&P, Bloomberg and ICE all publish that
       * number divided by 100.
       *
       * The divisor is what lets the second-order term be written with yield in
       * PERCENTAGE POINTS rather than decimals: half x 358.21 x 0.01^2 and
       * half x 3.5821 x 1^2 are the same 1.79% of price for a 100bp move.
       *
       * It is scaled HERE, at the one boundary this app converts units at —
       * beside couponPercent, indexRatePercent and four others — so every
       * surface downstream agrees by construction. The index page, the security
       * pages, the calculator, both markdown exports and the MCP examples all
       * read this field, and scaling at any one of them would have put our own
       * site on two conventions under one name.
       *
       * The stored value stays raw. A database should hold the definitional
       * quantity; the scale a reader expects is a presentation decision.
       *
       * WHY IT CHANGED: published as 65.69 against S&P's 0.56 on a comparable
       * index, our figure read as a hundredfold error to Dylan, who knows this
       * data better than any reader will. Being right is not the same as being
       * readable, and a correct number that looks wrong on every comparison a
       * prospect makes is not doing its job.
       */
      convexity: row.convexity / 100,
      cusip: row.cusip,
      date: row.date,
      dv01: row.dv01,
      /** A multiplier. May be below 1; that is deflation, not a bad row. */
      indexRatio: row.index_ratio,
      indexedPrincipal: row.indexed_principal,
      macaulayDuration: row.macaulay_duration,
      modifiedDuration: row.modified_duration,
      /**
       * What a holder actually pays per 100 of ORIGINAL face: the real price
       * grossed up by the index ratio. Computed here so no component has to
       * remember that `realCleanPrice` alone is not the money price.
       */
      moneyCleanPrice: row.real_clean_price * row.index_ratio,
      priceResidualCents: row.price_residual_cents,
      realCleanPrice: row.real_clean_price,
      realDirtyPrice: row.real_dirty_price,
      /** Percent, against the REAL curve. */
      realYield: row.real_yield,
      residualBasisPoints: row.residual_basis_points,
      residualZScore: row.residual_z_score,
   }));

export type TTipsAnalytics = z.infer<typeof ZTipsAnalytics>;

/**
 * One day of floating-rate note analytics for one security.
 *
 * EVERY RATE IN THIS TABLE IS A DECIMAL, and that is NOT true of the linker
 * table next to it — `tips_analytics.real_yield` is a percent. Confirmed with
 * upstream 2026-09-10 rather than inferred: `discount_margin` 0.000525 means
 * 5.25 basis points, and rendering it as "0.000525%" is a mistake nothing would
 * catch. So the transform converts once, here, and everything downstream reads
 * basis points and percent.
 *
 * `rate_duration` IS MEANT TO BE ~0. A floater resets quarterly, so it has
 * almost no sensitivity to the level of rates — median 3.56e-4 years across the
 * table. That is the instrument, not a missing value, and it is the reason a
 * yield to maturity would be the wrong measure for these securities.
 *
 * NO GATE IS NEEDED HERE, unlike the nominal and linker tables. Measured over
 * all 23,047 rows: the discount margin stays within -79.9 to +261.3 bp even
 * inside thirty days of maturity, and -23.5 to +36.8 bp beyond a year, with not
 * one of the 51 floaters exceeding 100 bp on its latest row. A margin is a
 * spread divided by a spread duration that shrinks on the same horizon, so the
 * ratio does not run away the way an annualised yield does.
 */
export const ZFrnAnalytics = z
   .object({
      accrued_interest: z.number(),
      clean_price: z.number(),
      cusip: z.string(),
      date: zIsoDate,
      dirty_price: z.number(),
      discount_margin: z.number(),
      index_rate: z.number(),
      /** Same fewer-than-20-observations rule as the nominal z-score. */
      margin_z_score: z.number().nullable(),
      quoted_spread: z.number(),
      rate_duration: z.number(),
      spread_dv01: z.number(),
      spread_duration: z.number(),
   })
   .transform((row) => ({
      accruedInterest: row.accrued_interest,
      cleanPrice: row.clean_price,
      cusip: row.cusip,
      date: row.date,
      dirtyPrice: row.dirty_price,
      /** Basis points. Stored as a decimal; converted once, here. */
      discountMarginBp: row.discount_margin * 10_000,
      /** Percent. The reference rate the note resets off. */
      indexRatePercent: row.index_rate * 100,
      marginZScore: row.margin_z_score,
      /** Basis points, the spread fixed at auction. */
      quotedSpreadBp: row.quoted_spread * 10_000,
      rateDurationYears: row.rate_duration,
      spreadDurationYears: row.spread_duration,
      spreadDv01: row.spread_dv01,
   }));

export type TFrnAnalytics = z.infer<typeof ZFrnAnalytics>;

export const ZSecurityAnalytics = z
   .object({
      convexity: z.number(),
      date: zIsoDate,
      dirty_price: z.number(),
      dv01: z.number(),
      krd_01y: z.number(),
      krd_02y: z.number(),
      krd_03m: z.number(),
      krd_03y: z.number(),
      krd_05y: z.number(),
      krd_06m: z.number(),
      krd_07y: z.number(),
      krd_10y: z.number(),
      krd_15y: z.number(),
      krd_20y: z.number(),
      krd_25y: z.number(),
      krd_30y: z.number(),
      macaulay_duration: z.number(),
      modified_duration: z.number(),
      price_residual_cents: z.number(),
      // NULLABLE SINCE 2026-09-10, and it must be. Upstream now nulls both of
      // these wherever `ytm` is null, because a yield residual annualises and
      // is meaningless days from redemption — see treasuryResidual.ts. Declared
      // non-nullable, that change 500s 825 of 2,613 CUSIP pages: the parse is
      // outside treasuryRead, so a ZodError is an unhandled throw rather than a
      // 503. `price_residual_cents` is unaffected and stays required.
      residual_basis_points: z.number().nullable(),
      residual_z_score: z.number().nullable(),
      ytm: z.number().nullable(),
   })
   .transform((row) => ({
      /**
       * ⚠️ DIVIDED BY 100, WHICH IS THE REPORTING CONVENTION AND NOT A FUDGE.
       *
       * Upstream stores the raw textbook quantity, (1/P) d2P/dy2 in years
       * squared, and it is correct: pricing a 30-year 4.75% at 5% by hand and
       * taking a central second difference reproduces its 358.2180 to
       * finite-difference truncation. S&P, Bloomberg and ICE all publish that
       * number divided by 100.
       *
       * The divisor is what lets the second-order term be written with yield in
       * PERCENTAGE POINTS rather than decimals: half x 358.21 x 0.01^2 and
       * half x 3.5821 x 1^2 are the same 1.79% of price for a 100bp move.
       *
       * It is scaled HERE, at the one boundary this app converts units at —
       * beside couponPercent, indexRatePercent and four others — so every
       * surface downstream agrees by construction. The index page, the security
       * pages, the calculator, both markdown exports and the MCP examples all
       * read this field, and scaling at any one of them would have put our own
       * site on two conventions under one name.
       *
       * The stored value stays raw. A database should hold the definitional
       * quantity; the scale a reader expects is a presentation decision.
       *
       * WHY IT CHANGED: published as 65.69 against S&P's 0.56 on a comparable
       * index, our figure read as a hundredfold error to Dylan, who knows this
       * data better than any reader will. Being right is not the same as being
       * readable, and a correct number that looks wrong on every comparison a
       * prospect makes is not doing its job.
       */
      convexity: row.convexity / 100,
      date: row.date,
      dirtyPrice: row.dirty_price,
      dv01: row.dv01,
      keyRateDurations: KEY_RATE_TENORS.map((tenor) => ({
         label: tenor.label,
         value: row[tenor.column],
         years: tenor.years,
      })),
      macaulayDuration: row.macaulay_duration,
      modifiedDuration: row.modified_duration,
      priceResidualCents: row.price_residual_cents,
      residualBasisPoints: row.residual_basis_points,
      residualZScore: row.residual_z_score,
      ytm: row.ytm,
   }));

export type TSecurityAnalytics = z.infer<typeof ZSecurityAnalytics>;

/* ─── Savings bonds ──────────────────────────────────────────────────────── */

/**
 * One published savings-bond rate period.
 *
 * RATES ARE DECIMALS IN THIS TABLE, unlike every curve table, which stores
 * percent. `composite_rate` 0.0425503 is 4.255%. Converted on the way through
 * so that nothing downstream has to remember which convention it is holding.
 *
 * `series` is left a plain string rather than an enum. Treasury has published I
 * and EE here so far; if a third appeared, an enum would throw and take the
 * whole rates page down over a benign addition, whereas an unrecognised series
 * simply is not selected.
 *
 * Series EE carries no inflation component — its rate is fixed for the life of
 * the bond — so `semiannual_inflation_rate` is null for it and that is correct
 * rather than absent.
 */
export const ZSavingsBondRate = z
   .object({
      composite_rate: z.number(),
      fixed_rate: z.number(),
      period_start: zIsoDate,
      semiannual_inflation_rate: z.number().nullable(),
      series: z.string(),
   })
   .transform((row) => ({
      compositePercent: row.composite_rate * 100,
      fixedPercent: row.fixed_rate * 100,
      periodStart: row.period_start,
      semiannualInflationPercent:
         row.semiannual_inflation_rate === null
            ? null
            : row.semiannual_inflation_rate * 100,
      series: row.series,
   }));

export type TSavingsBondRate = z.infer<typeof ZSavingsBondRate>;

/**
 * One six-month period of one Series EE COHORT's rate.
 *
 * EE IS NOT ONE RATE, which is the thing this fixes. The savings bond page
 * showed a single EE figure on the stated reasoning that "its rate is fixed for
 * the life of the bond, so the only meaningful figure is the one a bond bought
 * today would carry". That is true of a bond bought today and false of every
 * bond already held: bonds issued under the pre-2005 rules earn a rate that
 * still resets, and the cohorts diverge materially. For the period beginning
 * 2026-05-01 the three cohorts pay 3.20%, 3.39% and 2.40% — a full point apart,
 * on the same instrument, decided entirely by when it was bought.
 *
 * `longTermRate` is populated on only three rows of the whole table, all in the
 * 1995-05 cohort, so it is rendered where present and absent otherwise rather
 * than being given a column of dashes.
 */
export const ZEeBondRate = z
   .object({
      /** The issue era these rules apply to, as YYYY-MM. */
      cohort: z.string().min(1),
      long_term_rate: z.number().nullable(),
      period_start: zIsoDate,
      rate: z.number(),
   })
   .transform((row) => ({
      cohort: row.cohort,
      longTermPercent:
         row.long_term_rate === null ? null : row.long_term_rate * 100,
      periodStart: row.period_start,
      ratePercent: row.rate * 100,
   }));

export type TEeBondRate = z.infer<typeof ZEeBondRate>;

/**
 * Amount outstanding for one CUSIP at one month-end statement.
 *
 * THE CLASS VOCABULARY IS NOT THE ONE debt_summary USES. This table says
 * "Bills Maturity Value" and "Inflation-Protected Securities" where the debt
 * summary says "Bills" and "Treasury Inflation-Protected Securities", so a join
 * across the two on class silently drops bills and linkers while looking
 * entirely normal. Nothing in this app joins them; the note is here because the
 * join is the obvious thing to write.
 */
export const ZSecurityOutstanding = z
   .object({
      cusip: z.string(),
      outstanding: z.number(),
      record_date: zIsoDate,
      security_class: z.string(),
   })
   .transform((row) => ({
      cusip: row.cusip,
      outstanding: row.outstanding,
      recordDate: row.record_date,
      securityClass: row.security_class,
   }));

export type TSecurityOutstanding = z.infer<typeof ZSecurityOutstanding>;

/**
 * One security's price row read from a DATE rather than from a CUSIP.
 *
 * The per-CUSIP read drops `cusip` and `maturity_date` because the page already
 * knows both; a date-keyed read is the other way round and needs them to say
 * which security each row is. Same table, different question, so a separate
 * schema rather than making fields optional on the existing one.
 */
export const ZPriceOnDate = z
   .object({
      close: z.number(),
      cusip: z.string(),
      date: zIsoDate,
      maturity_date: zIsoDate,
      rate: z.number(),
      security_type: z.string(),
   })
   .transform((row) => ({
      close: row.close,
      couponPercent: row.rate * 100,
      cusip: row.cusip,
      date: row.date,
      maturityDate: row.maturity_date,
      securityType: row.security_type,
   }));

export type TPriceOnDate = z.infer<typeof ZPriceOnDate>;

/**
 * What a Series I bond is worth on a date, and what a holder would receive.
 *
 * `accruedValue` and `redemptionValue` ARE DIFFERENT NUMBERS and the difference
 * is the whole reason this is an endpoint rather than a rate table with
 * arithmetic on top. Three rules separate them:
 *
 *   1. A bond cannot be redeemed at all for twelve months, so
 *      `redemptionValue` is null before `redeemableFrom`.
 *   2. Redeemed inside five years, the last three months of interest are
 *      forfeit — and that is the value three months EARLIER, not a percentage
 *      taken off the current value.
 *   3. It stops earning at thirty years, after which holding it costs the
 *      holder money in real terms.
 *
 * Showing `accruedValue` as "what your bond is worth" would overstate what
 * anyone could actually get for it during the first five years.
 */
export const ZIBondValuation = z
   .object({
      accruedValue: z.number(),
      completedPeriods: z.number().int(),
      /**
       * The bond's position: which two ANNOUNCEMENTS its rate is drawn from,
       * and which of its own six-month windows the valuation date falls in.
       *
       * `fixedRateSetOn` and `inflationRateSetOn` are different dates, and that
       * is the whole point — the fixed half comes from the period the bond was
       * bought in and never changes, while the inflation half comes from
       * whichever announcement governs the window it is currently earning
       * through. That window runs from the bond's own issue month, not from May
       * and November, so two bonds bought four months apart are earning
       * different inflation rates on the same day.
       */
      currentPeriod: z
         .object({
            compositeRate: z.number(),
            earningPeriodEnd: zIsoDate,
            earningPeriodStart: zIsoDate,
            fixedRate: z.number(),
            fixedRateSetOn: zIsoDate,
            inflationRateSetOn: zIsoDate,
            semiannualInflationRate: z.number(),
         })
         .nullable()
         .optional(),
      finalMaturity: zIsoDate,
      matured: z.boolean(),
      monthsIntoCurrentPeriod: z.number().int(),
      on: zIsoDate,
      penaltyAmount: z.number(),
      penaltyMonths: z.number().int(),
      principal: z.number(),
      purchased: zIsoDate,
      redeemable: z.boolean(),
      redeemableFrom: zIsoDate,
      redemptionValue: z.number().nullable(),
      valueAtLastCompletedPeriod: z.number(),
   })
   .transform((row) => ({
      accruedValue: row.accruedValue,
      completedPeriods: row.completedPeriods,
      currentPeriod: row.currentPeriod ?? null,
      finalMaturity: row.finalMaturity,
      hasMatured: row.matured,
      isRedeemable: row.redeemable,
      monthsIntoCurrentPeriod: row.monthsIntoCurrentPeriod,
      on: row.on,
      penaltyAmount: row.penaltyAmount,
      penaltyMonths: row.penaltyMonths,
      principal: row.principal,
      purchased: row.purchased,
      redeemableFrom: row.redeemableFrom,
      redemptionValue: row.redemptionValue,
      valueAtLastCompletedPeriod: row.valueAtLastCompletedPeriod,
   }));

export type TIBondValuation = z.infer<typeof ZIBondValuation>;

/**
 * What a Series EE bond is worth on a date.
 *
 * THREE INSTRUMENTS WEAR THIS NAME and `cohort` says which. A bond from 2010
 * carries one rate for twenty years; one from 2000 took a new rate every six
 * months; one from 1996 had one rate for five years and another after. The
 * doubling term moves too — seventeen years through May 2003 and twenty from
 * June 2003 — so two bonds two months apart reach their guarantee three years
 * apart, which is why `doublingYears` comes back rather than being assumed.
 *
 * `guaranteeApplied` is the interesting field. At the stated rates of the last
 * fifteen years the doubling is worth more than the coupon, so for most bonds
 * the guarantee IS the return and the quoted rate is close to irrelevant.
 *
 * `assumesRateAfterTwenty` is a warning, not a detail: past year twenty
 * Treasury may change the rate and has not said it will not, so a valuation
 * reaching beyond it is an assumption rather than a calculation.
 */
export const ZEeBondValuation = z
   .object({
      accruedValue: z.number(),
      annualisedYield: z.number(),
      assumesRateAfterTwenty: z.boolean(),
      cohort: z.string(),
      doublingYears: z.number(),
      finalMaturity: zIsoDate,
      guaranteeApplied: z.boolean(),
      guaranteeDate: zIsoDate,
      guaranteeUplift: z.number(),
      matured: z.boolean(),
      on: zIsoDate,
      penaltyAmount: z.number(),
      penaltyMonths: z.number().int(),
      principal: z.number(),
      purchased: zIsoDate,
      rate: z.number(),
      redeemable: z.boolean(),
      redeemableFrom: zIsoDate,
      redemptionValue: z.number().nullable(),
   })
   .transform((row) => ({
      accruedValue: row.accruedValue,
      /** Decimal upstream; percent here, like every other rate on these pages. */
      annualisedYieldPercent: row.annualisedYield * 100,
      cohort: row.cohort,
      doublingYears: row.doublingYears,
      finalMaturity: row.finalMaturity,
      guaranteeDate: row.guaranteeDate,
      guaranteeUplift: row.guaranteeUplift,
      hasGuaranteeApplied: row.guaranteeApplied,
      hasMatured: row.matured,
      isRateAssumedAfterTwenty: row.assumesRateAfterTwenty,
      isRedeemable: row.redeemable,
      on: row.on,
      penaltyAmount: row.penaltyAmount,
      penaltyMonths: row.penaltyMonths,
      principal: row.principal,
      purchased: row.purchased,
      ratePercent: row.rate * 100,
      redeemableFrom: row.redeemableFrom,
      redemptionValue: row.redemptionValue,
   }));

export type TEeBondValuation = z.infer<typeof ZEeBondValuation>;

/* ─── Pricers ────────────────────────────────────────────────────────────── */

/**
 * THE UNITS ARE ASYMMETRIC AND IT IS DELIBERATE UPSTREAM. Rates going IN are
 * decimals (0.03895 for 3.895%); `yieldToMaturity` coming OUT is a percentage
 * (4.024565). The asymmetry exists so that `couponPrice` agrees with the
 * `security_analytics.ytm` column for the same security, which matters more
 * than internal tidiness — two different numbers for one security's yield is
 * worse than one awkward convention.
 *
 * Everything is normalised to PERCENT on the way through here, so nothing
 * downstream has to remember which side of the boundary it is on. The `*Percent`
 * suffix is the marker.
 */

/**
 * A priced Treasury bill.
 *
 * Three rates describe one bill and they are not interchangeable.
 * `discountRate` is how Treasury quotes it, on an ACT/360 basis against face.
 * `investmentRate` is the coupon-equivalent yield on ACT/365 against price,
 * which is the one comparable with a note's yield. Presenting the discount rate
 * as "the yield" overstates nothing and understates everything: it is computed
 * on the wrong denominator and the wrong day count.
 *
 * `daysInYear` comes back because the 365/366 choice is keyed off the issue
 * date rather than the calendar year, and a reader reproducing the arithmetic
 * needs to know which was used.
 */
export const ZBillPrice = z
   .object({
      daysInYear: z.number().int(),
      daysToMaturity: z.number().int(),
      discountRate: z.number(),
      investmentRate: z.number(),
      maturityDate: zIsoDate,
      price: z.number(),
      settlementDate: zIsoDate,
   })
   .transform((row) => ({
      daysInYear: row.daysInYear,
      daysToMaturity: row.daysToMaturity,
      discountRatePercent: row.discountRate * 100,
      investmentRatePercent: row.investmentRate * 100,
      maturityDate: row.maturityDate,
      price: row.price,
      settlementDate: row.settlementDate,
   }));

export type TBillPrice = z.infer<typeof ZBillPrice>;

/**
 * A priced coupon security.
 *
 * `cleanPrice` is what is quoted; `dirtyPrice` is what is paid, being the clean
 * price plus accrued interest. A calculator that reports only the clean price
 * has not answered "what will this cost me".
 *
 * `isFinalPeriod` matters more than it looks. In its last coupon period a bond
 * is discounted on SIMPLE interest, not compound, and the two diverge as the
 * stub shortens rather than converging — the gap tends to (y/2)², which is
 * 6.25bp at a 5% yield and reaches 5.7bp one day from redemption. A careful
 * user's spreadsheet will disagree with us on exactly these securities, and
 * this flag is what lets the page explain why instead of shrugging.
 *
 * `yieldToMaturity` arrives as a PERCENTAGE while the inputs are decimals. See
 * the note above.
 */
export const ZCouponPrice = z
   .object({
      accruedInterest: z.number(),
      cleanPrice: z.number(),
      convexity: z.number(),
      couponRate: z.number(),
      couponsRemaining: z.number().int(),
      cusip: z.string().nullable(),
      dirtyPrice: z.number(),
      dv01: z.number(),
      isFinalPeriod: z.boolean(),
      macaulayDuration: z.number(),
      maturityDate: zIsoDate,
      modifiedDuration: z.number(),
      settlementDate: zIsoDate,
      yieldToMaturity: z.number(),
   })
   .transform((row) => ({
      accruedInterest: row.accruedInterest,
      cleanPrice: row.cleanPrice,
      /**
       * ⚠️ DIVIDED BY 100, WHICH IS THE REPORTING CONVENTION AND NOT A FUDGE.
       *
       * Upstream stores the raw textbook quantity, (1/P) d2P/dy2 in years
       * squared, and it is correct: pricing a 30-year 4.75% at 5% by hand and
       * taking a central second difference reproduces its 358.2180 to
       * finite-difference truncation. S&P, Bloomberg and ICE all publish that
       * number divided by 100.
       *
       * The divisor is what lets the second-order term be written with yield in
       * PERCENTAGE POINTS rather than decimals: half x 358.21 x 0.01^2 and
       * half x 3.5821 x 1^2 are the same 1.79% of price for a 100bp move.
       *
       * It is scaled HERE, at the one boundary this app converts units at —
       * beside couponPercent, indexRatePercent and four others — so every
       * surface downstream agrees by construction. The index page, the security
       * pages, the calculator, both markdown exports and the MCP examples all
       * read this field, and scaling at any one of them would have put our own
       * site on two conventions under one name.
       *
       * The stored value stays raw. A database should hold the definitional
       * quantity; the scale a reader expects is a presentation decision.
       *
       * WHY IT CHANGED: published as 65.69 against S&P's 0.56 on a comparable
       * index, our figure read as a hundredfold error to Dylan, who knows this
       * data better than any reader will. Being right is not the same as being
       * readable, and a correct number that looks wrong on every comparison a
       * prospect makes is not doing its job.
       */
      convexity: row.convexity / 100,
      couponRatePercent: row.couponRate * 100,
      couponsRemaining: row.couponsRemaining,
      cusip: row.cusip,
      dirtyPrice: row.dirtyPrice,
      dv01: row.dv01,
      isFinalPeriod: row.isFinalPeriod,
      macaulayDuration: row.macaulayDuration,
      maturityDate: row.maturityDate,
      modifiedDuration: row.modifiedDuration,
      settlementDate: row.settlementDate,
      /** Already a percentage upstream — NOT multiplied by 100 here. */
      yieldToMaturityPercent: row.yieldToMaturity,
   }));

export type TCouponPrice = z.infer<typeof ZCouponPrice>;

/* ─── On the run ─────────────────────────────────────────────────────────── */

/**
 * One security's position in its own issuance queue on one date.
 *
 * `runRank` 0 is ON-THE-RUN — the most recently issued security of that kind
 * and term, and the one the market quotes as the benchmark. Ranks 1 through 10
 * are the issues behind it, first off-the-run through tenth.
 *
 * THE QUEUE IS KEYED ON KIND AS WELL AS TERM, and it did not used to be. Before
 * that fix a ten-year TIPS auctioned after a ten-year note took the note's
 * benchmark slot, so one of each pair was invisible: five terms had two
 * instruments competing for one place. On 2026-09-01 ten terms therefore carry
 * fourteen benchmarks — a 10-year note AND a 10-year TIPS, a 5-year note AND a
 * 5-year TIPS, a 30-year bond AND a 30-year TIPS, a 2-year note AND a 2-year
 * FRN, plus six terms with a single instrument.
 *
 * `MAX_TRACKED_RUN_RANK` is 10, so about 75% of priced coupon securities carry
 * no rank at all. That is a CEILING, not an omission: past ten issues back the
 * concept stops meaning anything, and an unranked security has aged out of the
 * queue rather than lost its label. "Not tracked beyond ten issues" is the
 * honest phrasing.
 */
export const MAX_TRACKED_RUN_RANK = 10;

export const ZRunStatus = z
   .object({
      basis: z.enum(["auction", "issue"]),
      cusip: z.string(),
      date: zIsoDate,
      original_security_term: z.string(),
      run_rank: z.number().int().min(0).max(MAX_TRACKED_RUN_RANK),
      /**
       * Added upstream with the kind-aware ranking and backfilled, so it is
       * never null on a stored row. Derived the same way the ranking derives it:
       * inflation_indexed first, then floating_rate, then security_type.
       */
      security_kind: z.enum(["Bill", "Bond", "FRN", "Note", "TIPS"]),
   })
   .transform((row) => ({
      basis: row.basis,
      cusip: row.cusip,
      date: row.date,
      isOnTheRun: row.run_rank === 0,
      originalSecurityTerm: row.original_security_term,
      runRank: row.run_rank,
      securityKind: row.security_kind,
   }));

export type TRunStatus = z.infer<typeof ZRunStatus>;
export type TSecurityKind = TRunStatus["securityKind"];

/**
 * A type-and-term queue, addressed by one URL slug: `10-year-note`,
 * `26-week-bill`, `5-year-tips`.
 *
 * The slug is the search phrase rather than a pair of path segments, because
 * "on the run 10 year treasury note" is how the question is actually asked. The
 * path already carries "treasury", so the slug does not repeat it.
 */
export const runQueueSlug = (kind: TSecurityKind, term: string) =>
   `${term.toLowerCase().replace(/\s+/g, "-")}-${kind.toLowerCase()}`;

/**
 * Instrument types in the order every on-the-run view presents them.
 *
 * Shortest instrument first, then the two that are neither nominal nor fixed.
 * NOT alphabetical, which would read Bill, Bond, Floating Rate Note, Note,
 * TIPS and put the thirty-year bond above the two-year note.
 *
 * Written out rather than derived, because the order is an editorial choice: a
 * set over whatever queues happen to exist would reorder itself the next time
 * Treasury changes its auction calendar.
 */
export const RUN_KIND_ORDER: readonly TSecurityKind[] = [
   "Bill",
   "Note",
   "Bond",
   "TIPS",
   "FRN",
];

/**
 * An original security term as a number of years, for sorting.
 *
 * REQUIRED BECAUSE THESE DO NOT SORT AS STRINGS. "17-Week" precedes "4-Week"
 * alphabetically and "10-Year" precedes "2-Year", so a string sort listed the
 * notes as 10, 2, 3, 5, 7 and the linkers as 10, 30, 5.
 *
 * Parsed rather than mapped from a fixed list, so a term Treasury has not
 * issued before sorts into its right place instead of falling to the end. An
 * unparseable term sorts last, which is the safe direction: it appears, visibly
 * out of position, rather than being dropped.
 */
export const termYears = (term: string) => {
   const weeks = /^(\d+)-Week/i.exec(term);
   if (weeks !== null) return Number(weeks[1]) / 52;
   const years = /^(\d+)-Year/i.exec(term);
   return years === null ? Number.POSITIVE_INFINITY : Number(years[1]);
};

/** Human label for a queue, e.g. "10-Year Note". */
export const KIND_LABEL: Record<TSecurityKind, string> = {
   Bill: "Bill",
   Bond: "Bond",
   FRN: "Floating Rate Note",
   Note: "Note",
   TIPS: "TIPS",
};

/* ─── STRIPS float ───────────────────────────────────────────────────────── */

/**
 * One security's stripped position on one monthly statement.
 *
 * `outstanding` is the par on issue, `stripped` the par currently held as
 * separate principal and interest components, and `reconstituted` the par
 * reassembled back into whole bonds DURING that month — a flow, not a stock,
 * and the figure that makes stripping look like a turnstile rather than a
 * warehouse.
 *
 * MONTHLY, NOT DAILY. Treasury publishes this as a month-end statement, so a
 * STRIPS figure beside a daily curve is a month-end figure beside a daily
 * close. The statement date is always reported for that reason.
 */
export const ZStrippedSecurity = z
   .object({
      cusip: z.string(),
      maturity_date: zIsoDate,
      outstanding: z.number(),
      reconstituted: z.number(),
      record_date: zIsoDate,
      security_class: z.string(),
      stripped: z.number(),
   })
   .transform((row) => ({
      cusip: row.cusip,
      maturityDate: row.maturity_date,
      outstanding: row.outstanding,
      reconstituted: row.reconstituted,
      recordDate: row.record_date,
      securityClass: row.security_class,
      stripped: row.stripped,
      /** Null rather than a divide-by-zero for a security with no par on file. */
      strippedShareOfSize:
         row.outstanding === 0 ? null : (row.stripped / row.outstanding) * 100,
   }));

export type TStrippedSecurity = z.infer<typeof ZStrippedSecurity>;

/** One month's aggregate: the whole strippable market on that statement. */
/**
 * One line of Treasury's Monthly Statement of the Public Debt.
 *
 * FOUR THINGS ABOUT THIS TABLE PRODUCE NORMAL-LOOKING WRONG ANSWERS, all
 * measured on the local store (4,659 rows, 308 monthly statements from
 * 2001-01-31 to 2026-08-31) rather than inferred from the shape:
 *
 * 1. `securityClass === "_"` IS A TOTAL, NOT A CLASS — 924 of the 4,659 rows.
 *    Their `securityType` is one of Total Marketable, Total Nonmarketable,
 *    Total Public Debt Outstanding or Total Treasury Securities Outstanding.
 *    Summing `total` across every row double counts: read the detail rows for
 *    a breakdown, or the total rows for a headline, and NEVER both. `isTotal`
 *    below exists so a caller cannot forget which it is holding.
 *
 * 2. THE DETAIL ROWS DO NOT TIE TO TREASURY'S OWN TOTAL EXACTLY. At 2026-08-31
 *    they do, to the cent — the six marketable classes sum to
 *    31,828,001,463,612.64 against a Total Marketable row of the same figure,
 *    reproduced here rather than taken on report. Across all 308 statements
 *    they do not: 25 marketable months differ by more than a dollar, worst
 *    $1,000,000, and the gaps repeat as round figures (exactly $20,000 on
 *    eleven consecutive months from 2001-04 to 2002-03), which is a reporting
 *    artefact in Treasury's own file rather than a dropped row on our side.
 *    Worst relative error 3.32e-7, so it is invisible on a page and fatal to
 *    an equality check. Any tie-out here must be a relative tolerance.
 *
 * 3. TIPS AT 2004-06-30 IS A RENAME, NOT A NEW SERIES. Inflation-Indexed Notes
 *    ($152.78bn) plus Inflation-Indexed Bonds ($46.95bn) end at 2004-05-31 on
 *    $199.73bn; Treasury Inflation-Protected Securities begins the next
 *    statement on $200.39bn. One continuous history under three labels, so a
 *    naive group-by shows TIPS starting in 2004 beside two series that died.
 *    `canonicalDebtClass` folds the three into one.
 *
 * 4. THE HEADLINE TOTAL'S LABEL CHANGES FOR THE FIRST TWO MONTHS. 2001-01-31
 *    and 2001-02-28 are Total Treasury Securities Outstanding; every statement
 *    after is Total Public Debt Outstanding. Keyed on the label that is a
 *    two-month hole at the start of a 25-year series, which reads as missing
 *    data — so `isHeadlineTotal` tests for either.
 *
 * A fifth trap applies only to a join this app does not do: `debt_summary` and
 * `security_outstanding` use DIFFERENT class vocabularies (Bills against Bills
 * Maturity Value, Treasury Inflation-Protected Securities against
 * Inflation-Protected Securities), so joining them on class silently drops
 * bills and TIPS. Noted here because the join looks obvious.
 *
 * Traps 1, 3 and 4 were measured by the treasury_exploration session and
 * reproduced here against the same store before being relied on; trap 2 is
 * their correction of their own first report, and the reason the tolerance
 * wording above is not "ties exactly".
 */
export const ZDebtSummaryLine = z
   .object({
      debt_held_public: z.number(),
      intragovernmental: z.number(),
      record_date: zIsoDate,
      security_class: z.string(),
      security_type: z.string().min(1),
      total: z.number(),
   })
   .transform((row) => ({
      debtHeldPublic: row.debt_held_public,
      intragovernmental: row.intragovernmental,
      /** Trap 4: either label, because it changed after two statements. */
      isHeadlineTotal:
         row.security_type === "Total Public Debt Outstanding" ||
         row.security_type === "Total Treasury Securities Outstanding",
      /** Trap 1. The one field that keeps a total out of a breakdown. */
      isTotal: row.security_class === "_",
      recordDate: row.record_date,
      securityClass: row.security_class,
      securityType: row.security_type,
      total: row.total,
   }));

export type TDebtSummaryLine = z.infer<typeof ZDebtSummaryLine>;

/**
 * Trap 3: the two pre-2004 linker labels fold into the current one.
 *
 * Applied to a breakdown of a single statement this changes nothing — no month
 * carries both vocabularies. It matters for any series over time, and it is
 * here rather than at the one call site so the next series cannot omit it.
 */
const DEBT_CLASS_RENAMES: Record<string, string> = {
   "Inflation-Indexed Bonds": "Treasury Inflation-Protected Securities",
   "Inflation-Indexed Notes": "Treasury Inflation-Protected Securities",
};

export const canonicalDebtClass = (securityClass: string) =>
   DEBT_CLASS_RENAMES[securityClass] ?? securityClass;

/**
 * Counts and amounts of savings bonds by series, for ONE report.
 *
 * `savingsBondStock()` pins `record_date` to the table maximum, so this is the
 * latest statement and not a history — about a dozen rows out of the 1,260 the
 * table holds. Worth stating because the row count invites the opposite
 * assumption, and the series begins 2019-01-31, seven years against the debt
 * summary's twenty-five, so the two do not belong on one axis.
 */
export const ZSavingsBondStock = z
   .object({
      issued: z.number(),
      matured: z.number(),
      matured_unredeemed: z.number(),
      outstanding: z.number(),
      record_date: zIsoDate,
      redeemed: z.number(),
      series: z.string().min(1),
      series_description: z.string(),
   })
   .transform((row) => ({
      issued: row.issued,
      matured: row.matured,
      maturedUnredeemed: row.matured_unredeemed,
      outstanding: row.outstanding,
      recordDate: row.record_date,
      redeemed: row.redeemed,
      series: row.series,
      seriesDescription: row.series_description,
   }));

export type TSavingsBondStock = z.infer<typeof ZSavingsBondStock>;

/**
 * One month of sales through TreasuryDirect, by security type.
 *
 * Retail demand rather than auction demand: this is the only public series
 * that shows a household reacting to a rate. `securityClass` is empty on the
 * marketable line, which the report does not break out.
 */
export const ZTreasuryDirectSale = z
   .object({
      gross_sales: z.number(),
      net_sales: z.number(),
      record_date: zIsoDate,
      returned_sales: z.number(),
      securities_sold: z.number(),
      security_class: z.string(),
      security_type: z.string().min(1),
   })
   .transform((row) => ({
      grossSales: row.gross_sales,
      netSales: row.net_sales,
      recordDate: row.record_date,
      returnedSales: row.returned_sales,
      securitiesSold: row.securities_sold,
      securityClass: row.security_class,
      securityType: row.security_type,
   }));

export type TTreasuryDirectSale = z.infer<typeof ZTreasuryDirectSale>;

/**
 * Relative tolerance for the detail-against-total tie-out. See trap 2.
 *
 * 1e-6 passes all 308 statements with room — the worst observed relative gap is
 * 3.32e-7 — while a dropped detail row would be orders of magnitude larger: the
 * smallest marketable class at the latest statement is Federal Financing Bank
 * at $3.6bn, which is 1.1e-4 of the total, a hundred times this threshold.
 */
export const DEBT_SUMMARY_TIE_TOLERANCE = 1e-6;

export const ZStrippedStatement = z
   .object({
      outstanding: z.number(),
      reconstituted: z.number(),
      record_date: zIsoDate,
      securities: z.number().int(),
      stripped: z.number(),
   })
   .transform((row) => ({
      outstanding: row.outstanding,
      reconstituted: row.reconstituted,
      recordDate: row.record_date,
      securityCount: row.securities,
      stripped: row.stripped,
      strippedSharePercent:
         row.outstanding === 0 ? null : (row.stripped / row.outstanding) * 100,
   }));

export type TStrippedStatement = z.infer<typeof ZStrippedStatement>;

/* ─── Indices ────────────────────────────────────────────────────────────── */

/**
 * The eleven published indices, keyed by the code the data uses.
 *
 * `broad` is the parent; the five band codes partition it by maturity; AGG is
 * the whole marketable market and the remaining four are instrument families.
 * The ticker is what a fund document would name, and the code is the wire
 * format — both are given because they differ and both appear in practice.
 */
/**
 * TICKER SCHEME: SR-UST-<RETURN TYPE>-<SCOPE>.
 *
 * The TR segment is a VARIANT MARKER, not decoration, and that is why the five
 * instrument-family tickers were renamed into it on 2026-09-26. Dylan confirmed
 * a price-return variant is possible, which makes the short forms — SR-UST-AGG
 * and its four siblings — ambiguous rather than merely inconsistent: they named
 * a scope and left the measurement unstated. A price-return sibling would be
 * SR-UST-PR-AGG and the two must be distinguishable in the identifier, because
 * a total-return and a price-return index over the same bonds differ by the
 * whole coupon stream.
 *
 * This is the shape established families use. Bloomberg runs LUATTRUU for total
 * return against LUATPRUU for price return over one base — the return type is
 * inside the ticker, not left to a field on a page.
 *
 * `formerTicker` records what an index published under before. A rename is not
 * a removal: the old strings were crawled, listed in llms-treasury.txt and
 * emitted as schema.org identifiers for months, so they are retained as a
 * second identifier and an existing citation still resolves to the same series.
 *
 * ⚠️ A RETIRED TICKER IS NEVER REASSIGNED. When the price-return family
 * arrives it takes SR-UST-PR-AGG. It must NOT take the bare SR-UST-AGG, even
 * though that string is free now, because an old citation of SR-UST-AGG would
 * then resolve — silently, with no error anywhere — to a series whose returns
 * exclude coupons, which at the long end is several percent a year. A citation
 * that fails to resolve is a broken link somebody notices; one that resolves to
 * the wrong series is a wrong number nobody notices. Enforced in
 * tests/indexDisplayNames.test.ts.
 *
 * ONLY FIVE NAMES WERE EVER RETIRED. The broad index and all five maturity
 * bands were always SR-UST-TR*; bare SR-UST and SR-UST-0103 never named
 * anything, so claiming an alias for them would assert a history that did not
 * happen and invite citations to strings that never existed.
 */
export const INDEX_META = {
   "0103": {
      covers: "1 to 3 years",
      name: "1-3 Year",
      ticker: "SR-UST-TR-0103",
   },
   "0307": {
      covers: "3 to 7 years",
      name: "3-7 Year",
      ticker: "SR-UST-TR-0307",
   },
   "0710": {
      covers: "7 to 10 years",
      name: "7-10 Year",
      ticker: "SR-UST-TR-0710",
   },
   "1020": {
      covers: "10 to 20 years",
      name: "10-20 Year",
      ticker: "SR-UST-TR-1020",
   },
   "20PL": {
      covers: "20 years and over",
      name: "20+ Year",
      ticker: "SR-UST-TR-20PL",
   },
   AGG: {
      covers:
         "The whole marketable market: bills, coupons, linkers and floaters",
      name: "US Treasury Aggregate",
      ticker: "SR-UST-TR-AGG",
      formerTicker: "SR-UST-AGG",
   },
   BILL: {
      covers: "1 to 3 month bills",
      name: "1-3 Month Bill",
      ticker: "SR-UST-TR-BILL",
      formerTicker: "SR-UST-BILL",
   },
   FRN: {
      covers: "Floating rate notes",
      // "Floating Rate", not "Floating Rate Notes": the display name appends
      // "US Treasury Index", and "Floating Rate Notes US Treasury Index" reads
      // as two nouns fighting. Matches the chart tooltip, which was shortened
      // to "Floating Rate" for the same reason.
      name: "Floating Rate",
      ticker: "SR-UST-TR-FRN",
      formerTicker: "SR-UST-FRN",
   },
   SHRT: {
      covers: "1 to 12 months, bills and aged coupons together",
      name: "1-12 Month",
      ticker: "SR-UST-TR-SHRT",
      formerTicker: "SR-UST-SHRT",
   },
   TIPS: {
      covers: "Inflation-linked, one year and over",
      name: "Inflation-Linked",
      ticker: "SR-UST-TR-TIPS",
      formerTicker: "SR-UST-TIPS",
   },
   broad: {
      covers: "Nominal notes and bonds, one year and over",
      /**
       * "US Treasury", NOT "US Treasury Index".
       *
       * `name` is the SCOPE — what the index covers — and every other entry is
       * one: "1-3 Year", "Inflation-Linked", "US Treasury Aggregate". This one
       * carried "Index" as well, so the hub table listed ten scopes and one
       * title, and its row read "US Treasury Index" while the page it links to
       * is titled "Safe Rate US Treasury Total Return Index" — a row
       * contradicting its own destination.
       *
       * indexDisplayName is unaffected: it appends " Total Return Index" where
       * there is no trailing " Index" and substitutes where there is, so both
       * spellings produce "Safe Rate US Treasury Total Return Index".
       */
      name: "US Treasury",
      ticker: "SR-UST-TR",
   },
} as const;

export type TIndexCode = keyof typeof INDEX_META;

/**
 * The citable name of an index, as opposed to its short label.
 *
 * `INDEX_META[code].name` is a LABEL for a column header: "1-3 Year" is
 * unambiguous next to ten siblings and meaningless on its own. A citation, a
 * schema.org `Dataset` name and a markdown page title all travel away from that
 * context, and "1-3 Year" quoted alone names nothing and credits nobody. This
 * is the form that survives the trip.
 *
 * The conditional is not cosmetic: three of the eleven already carry "US
 * Treasury" in their label, and appending it again produces "Safe Rate US
 * Treasury Index US Treasury Index".
 */
/**
 * The index's name as a heading, without the owner or the ticker.
 *
 * `INDEX_META[code].name` is a LABEL sized for a column header. "1-3 Year" is
 * unambiguous next to ten siblings and says nothing on its own -- it does not
 * even say it is an index, let alone of what. A page title is read alone.
 *
 * THE OWNER IS PART OF THE NAME, not chrome around it. Every commercial
 * benchmark is named this way -- S&P 500, FTSE 100, Bloomberg Aggregate --
 * because an index is a branded product and the brand is what makes it one.
 * "7-10 Year US Treasury Index" is generic enough that anyone could claim it;
 * prefixed, it is ours in the heading, in a screenshot, and in a quotation that
 * carries none of this page with it.
 *
 * THE TICKER IS NOT HERE because the pages using this show it in the eyebrow
 * directly above the heading. `indexCitableName` adds it for the contexts that
 * travel -- the <title>, the Dataset node, the markdown twins -- where nothing
 * else on the page comes along.
 *
 * The conditional is not cosmetic: three of the eleven already carry "US
 * Treasury" in their label, and appending it again yields "US Treasury Index
 * US Treasury Index".
 */
/**
 * "TOTAL RETURN" IS IN THE NAME BECAUSE IT IS THE CLAIM THE TICKER ALREADY
 * MAKES. Every ticker is SR-UST-**TR**-nnnn, and the name said only "US
 * Treasury Index" — so the one property that decides whether a level is
 * comparable to anything was carried by two letters inside an identifier and
 * nowhere in the words. A price-return and a total-return index over the same
 * bonds diverge by the whole coupon stream, which over eighteen years is most
 * of the number, and a reader comparing ours against a price index without
 * knowing which is which is not making a small error.
 *
 * It is also the industry's own convention: Bloomberg and ICE both put it in
 * the name rather than leaving it to a field on a page, because the name is
 * what travels into a citation, a fund document and a search result with none
 * of the page around it.
 */
const NAME_SUFFIX = "US Treasury Total Return Index";

/**
 * The ticker this index used to publish under, if it changed.
 *
 * A typed accessor rather than an `in` check at each call site: INDEX_META is
 * `as const` and only five of the eleven entries carry the field, so reading it
 * inline widens to `unknown` and every caller has to cast. One narrowing, here.
 */
export const indexFormerTicker = (code: TIndexCode): string | undefined => {
   // Narrowed through Record rather than a struct type: INDEX_META is `as const`
   // and its union has entries with the field and entries without, which is not
   // assignable to an optional-property type in either direction.
   const meta = INDEX_META[code] as Record<string, string>;
   return meta.formerTicker;
};

export const indexDisplayName = (code: TIndexCode) => {
   const meta = INDEX_META[code];
   // ⚠️ TWO NAMES ALREADY BEGIN "US Treasury" AND THEY ARE DIFFERENT INDICES.
   // `broad` is "US Treasury Index" and AGG is "US Treasury Aggregate".
   // Collapsing either to a fixed suffix drops the word that distinguishes
   // them, which is how both briefly published as "Safe Rate US Treasury Total
   // Return Index" — one name for two indices, in page titles, citations,
   // schema.org nodes and the header of every downloaded CSV. So "Total Return"
   // is INSERTED before the existing "Index" where there is one, and appended
   // where there is not, rather than replacing the name. See the collision test.
   const stem = meta.name.startsWith("US Treasury")
      ? meta.name.endsWith(" Index")
         ? meta.name.replace(/ Index$/, " Total Return Index")
         : `${meta.name} Total Return Index`
      : `${meta.name} ${NAME_SUFFIX}`;
   return `Safe Rate ${stem}`;
};

/**
 * The index's name where it has to stand entirely alone.
 *
 * Owner and ticker included, for a citation, a schema.org `Dataset` name or a
 * markdown title -- all of which are read with none of this page around them.
 */
export const indexCitableName = (code: TIndexCode) =>
   `${indexDisplayName(code)} (${INDEX_META[code].ticker})`;

/**
 * Display order: the parent first, then the maturity bands ascending, then the
 * instrument families.
 *
 * EXPLICIT, BECAUSE `Object.keys(INDEX_META)` IS NOT THE DECLARATION ORDER.
 * JavaScript hoists integer-like keys to the front of a plain object, and
 * "1020" is a canonical array index while "0103" (leading zero) is not — so
 * Object.keys returns 1020 first and the bands come out scrambled. Sorting on
 * that put the 10-20 year band above the 1-3 year band on the page.
 */
export const INDEX_DISPLAY_ORDER: readonly TIndexCode[] = [
   "broad",
   "0103",
   "0307",
   "0710",
   "1020",
   "20PL",
   "BILL",
   "SHRT",
   "TIPS",
   "AGG",
   "FRN",
];

export const isIndexCode = (value: string): value is TIndexCode =>
   Object.hasOwn(INDEX_META, value);

/**
 * The URL slug for each index, which is NOT its code.
 *
 * THE CODE IS UPSTREAM'S KEY AND IT MADE A BAD URL. Six of the eleven are
 * uppercase, so `/treasury/indices/TIPS` resolved and `/treasury/indices/tips`
 * 404ed, and people lowercase a URL by habit. The directory also ran three
 * conventions at once: numeric (`0103`), uppercase abbreviation (`AGG`), and a
 * lowercase word (`broad`). None of the three told a reader what the page was.
 *
 * MOVED NOW BECAUSE IT IS FREE. The treasury sitemap has not been submitted to
 * Google or IndexNow, so no ranking has accumulated against the old paths and
 * the 301s exist for correctness rather than to carry equity across. The same
 * move once these are indexed costs real money. This is the same reasoning that
 * moved the dated pages from /treasury/curves/:slug to /treasury/rates/:slug.
 *
 * THE CODE IS STILL THE KEY EVERYWHERE ELSE. Upstream's RPC, the constituent
 * files and `INDEX_META` are all keyed by code, and that boundary belongs to
 * another repo. This maps at the edge and nowhere deeper.
 *
 * `nominal` AND `aggregate` NAME AN ACTUAL DIFFERENCE. "Broad" and "aggregate"
 * sound like the same thing; the broad index is nominal notes and bonds of a
 * year and over, while the aggregate is everything marketable including bills,
 * linkers and floaters. The old pair of slugs hid that. These two state it.
 */
export const INDEX_SLUG: Record<TIndexCode, string> = {
   "0103": "1-3-year",
   "0307": "3-7-year",
   "0710": "7-10-year",
   "1020": "10-20-year",
   "20PL": "20-year-plus",
   AGG: "aggregate",
   BILL: "1-3-month-bill",
   FRN: "floating-rate",
   SHRT: "1-12-month",
   TIPS: "tips",
   broad: "nominal",
};

/**
 * The path to an index page.
 *
 * EVERY CALLER BUILDS ITS URL THROUGH THIS, including the constituents pages,
 * which append "/constituents". Thirteen call sites used to interpolate the
 * code directly, and a slug layer that half the site knows about is worse than
 * no slug layer: the half that does not know produces 404s the half that does
 * links to.
 */
export const indexPath = (code: TIndexCode) =>
   `/treasury/indices/${INDEX_SLUG[code]}`;

/**
 * The path for a code that arrived over the wire, or null when we do not know it.
 *
 * UPSTREAM'S CODES ARE STRINGS AND OURS IS A CLOSED UNION. `INDEX_SLUG` on a
 * code we have never seen yields `undefined`, and interpolating that produces
 * `/treasury/indices/undefined` — a link that looks deliberate, 404s, and would
 * have gone into the sitemap. Callers that hold a wire string use this and skip
 * the ones it declines.
 *
 * The old code was ALSO wrong here and less obviously: it published
 * `/treasury/indices/<unknown code>`, which 404ed for the same reason the page
 * could not resolve it. Nothing renders an unknown code today — the hub reads
 * `INDEX_META[code].name` and would throw first — so this is the honest
 * behaviour rather than a new restriction.
 */
export const indexPathForWireCode = (code: string) =>
   isIndexCode(code) ? indexPath(code) : null;

const CODE_BY_SLUG = new Map(
   Object.entries(INDEX_SLUG).map(([code, slug]) => [slug, code as TIndexCode]),
);

/** The index a slug names, or null. The current spelling only. */
export const indexCodeFromSlug = (slug: string) =>
   CODE_BY_SLUG.get(slug) ?? null;

const CODE_BY_LEGACY = new Map(
   Object.keys(INDEX_META).map((code) => [
      code.toLowerCase(),
      code as TIndexCode,
   ]),
);

/**
 * The index an OLD url segment names, for the 301 and nothing else.
 *
 * Case-insensitive on purpose. The old paths were mixed case and the lowercase
 * form 404ed, so `/treasury/indices/tips` was a dead end before this existed.
 * It now redirects rather than 404s, which is what it should always have done.
 */
export const indexCodeFromLegacySegment = (segment: string) =>
   CODE_BY_LEGACY.get(segment.toLowerCase()) ?? null;

/** Methodology v1.0 takes effect at this rebalance. Everything before is back-tested. */
export const INDEX_V1_EFFECTIVE = "2026-09-30";

/**
 * One index at one rebalance.
 *
 * EVERY DATE IS A MONTH END, and there is no daily level. The indices rebalance
 * monthly on the last trading day, so a level is a month-end figure while every
 * curve and price on this site is a daily close. That gap is permanent and
 * correct rather than staleness: as of the 2026-08-31 level, prices ran to
 * 2026-09-09, and the next level appears at the September rebalance. A page
 * putting the two side by side has to say which is which.
 *
 * `monthReturn` IS A DECIMAL, not a percent — 0.0032828 is a month's total
 * return. It chains exactly: verified independently across 2,280 month
 * transitions and all eleven indices, `level[i-1] * (1 + monthReturn[i])`
 * equals `level[i]` to zero. So the two can be presented together with no
 * reconciliation note.
 *
 * `methodology` is "0.1" everywhere today. A v0.1 level is BACK-TESTED —
 * computed after the fact by applying the rules to historical data — and
 * carries the hindsight that implies. v1.0 takes effect at the
 * 2026-09-30 rebalance, at which point levels are struck on the day. The
 * rulebook is identical; the status is not.
 */
/**
 * One index valued on one DAY, as upstream returns it.
 *
 * VALUED DAILY, NOT REBALANCED DAILY, and the whole schema turns on that.
 * Constituents and weights are struck at a month-end rebalance and held; a
 * daily row is that same fixed portfolio priced on a later day. So nothing
 * about eligibility or weighting changed, and a day that IS a rebalance
 * reproduces the published monthly level exactly — verified upstream across 22
 * rebalance-days at a worst relative gap of 0.
 *
 * `return_since_rebalance` IS A PARTIAL PERIOD AND IS NOT `month_return`. It
 * runs from `rebalance_date` to `date`, grows through the month, and RESETS at
 * the next rebalance. Chaining it across a month boundary double counts. For a
 * daily or period return, difference `level` instead.
 *
 * IT ARRIVES AS A FRACTION, AND SO DOES `month_return`. Both wire columns are
 * fractions; `month_return` of 0.0064958 is a 0.65% month. Multiplied by 100
 * on the way in, exactly as `ZIndexLevel` does, so every field this app hands
 * to a page is a percent and the two are named alike.
 *
 * A CORRECTION KEPT HERE BECAUSE THE WRONG VERSION WAS ALSO WRITTEN DOWN. This
 * comment previously claimed the two columns disagreed by a factor of 100, with
 * a measurement table under it, and the claim was false. The measurement
 * compared `monthReturnPercent` -- which `ZIndexLevel` has ALREADY multiplied
 * by 100 -- against a raw wire value. Reconstructing the anchor from the daily
 * level then "confirmed" a unit difference that is what you would see if both
 * columns were fractions, which they are. The conclusion (use the fraction,
 * convert on the way in) was right for the wrong reason, and a wrong reason
 * with a table under it reads as verified.
 *
 * `provisional` is 1 for any valuation inside an OPEN holding period, which is
 * nearly every row: the period has not closed and the day's own prices can
 * still be restated by the source. It read 0 everywhere until saferate-treasury
 * ee7f346 -- the test was a month-end CALENDAR whose last entry is the last
 * priced day of a month that may have weeks left to run, so the newest day of
 * every run, the only row anyone looks at, was classified as closed. It now
 * asks whether that index has a published monthly level for the day, which is
 * the real question and is per-index rather than per-calendar. A page showing
 * these rows has to say so.
 */
export const ZIndexLevelDaily = z
   .object({
      code: z.string(),
      date: zIsoDate,
      level: z.number(),
      provisional: zSqliteBoolean,
      rebalance_date: zIsoDate,
      return_since_rebalance: z.number(),
   })
   .transform((row) => ({
      code: row.code,
      date: row.date,
      /** True while the holding period is still open and prices can be restated. */
      isProvisional: row.provisional,
      level: row.level,
      /** The month-end whose constituents and weights this day is priced on. */
      rebalanceDate: row.rebalance_date,
      /**
       * PARTIAL: rebalance_date to date. Never chain across a rebalance --
       * difference `level` for any period return.
       *
       * Converted to percent here so it matches `monthReturnPercent` on
       * `ZIndexLevel`. Naming one field for its wire unit and its sibling for
       * its display unit, in the same file, is its own trap.
       */
      returnSinceRebalancePercent: row.return_since_rebalance * 100,
   }));

export type TIndexLevelDaily = z.infer<typeof ZIndexLevelDaily>;

export const ZIndexLevel = z
   .object({
      code: z.string(),
      constituents: z.number().int(),
      date: zIsoDate,
      level: z.number(),
      methodology: z.string(),
      month_return: z.number(),
   })
   .transform((row) => ({
      code: row.code,
      constituentCount: row.constituents,
      date: row.date,
      /**
       * Read off the ROW, not inferred from the date. The series is about to
       * carry two versions — v1.0 takes effect at the 2026-09-30 rebalance —
       * and a date comparison would silently mislabel any row upstream stamps
       * differently. Any 0.x version is a back-test.
       */
      isBackTested: row.methodology.startsWith("0."),
      level: row.level,
      methodologyVersion: row.methodology,
      /** Percent, converted from the decimal the table stores. */
      monthReturnPercent: row.month_return * 100,
   }));

export type TIndexLevel = z.infer<typeof ZIndexLevel>;

/**
 * How one index band tracked the fund that follows it.
 *
 * THIS IS THE PUBLISHABLE COMPARISON, and the stronger one. It is built from
 * public market prices and contains nobody's index values: 215 monthly
 * observations per band against 5 annual observations for the licensed
 * comparison, and seven more years of history. It is not a fallback.
 *
 * `expectedBp` IS NOT AN EXPENSE RATIO. A fee is annual and this gap is
 * monthly, and GOVT cut its fee from 0.15% to 0.05% in 2018 — so a single
 * expense ratio would be wrong for most of the history. This is the fee
 * actually in force across each month, time-weighted over the window, already
 * in the units of the number beside it.
 *
 * A FUND IS NOT ITS INDEX. It trails by its fee and wanders either side on
 * premium and discount, so the number to read is the centre of two hundred
 * months rather than any single one. That caveat is the difference between a
 * comparison and a claim.
 */
/**
 * One index's characteristics on one valuation day, per DURATION BASIS.
 *
 * ⚠️ AN ARRAY, AND NEVER ONE ROW. The Aggregate holds nominal bonds, linkers
 * and floaters at once and returns three entries — 90.0%, 7.1% and 2.9% of its
 * market value — because those are sensitivities to three DIFFERENT variables.
 * A blended duration across them is a sensitivity to nothing. Code that assumes
 * one row per index works for ten of the eleven and silently drops two thirds
 * of the twelfth.
 *
 * `spreadDuration` is the one that matters on a floating row and it is not
 * interchangeable with `modifiedDuration`: the floater index reads 0.0012
 * years of rate duration against 0.9151 of spread duration, because its coupon
 * resets. Publishing the first alone understates the risk; publishing the
 * second as though it were rate duration overstates rate sensitivity by three
 * orders of magnitude. Non-floating rows carry 0 rather than null, so render it
 * where the basis is floating and nowhere else.
 */
export const ZIndexAnalytics = z
   .object({
      average_maturity: z.number(),
      average_price: z.number(),
      basis_share: z.number(),
      constituents: z.number().int(),
      convexity: z.number(),
      coupon_rate: z.number(),
      date: zIsoDate,
      duration_basis: z.string(),
      // KEY RATE DURATIONS, twelve points across the curve. Each is the
      // sensitivity to a shift at THAT tenor alone, so the shape says where the
      // index's rate risk actually sits — which a single modified duration
      // cannot: two indices with the same duration can be concentrated at five
      // years and spread across thirty.
      krd_01y: z.number(),
      krd_02y: z.number(),
      krd_03m: z.number(),
      krd_03y: z.number(),
      krd_05y: z.number(),
      krd_06m: z.number(),
      krd_07y: z.number(),
      krd_10y: z.number(),
      krd_15y: z.number(),
      krd_20y: z.number(),
      krd_25y: z.number(),
      krd_30y: z.number(),
      market_value: z.number(),
      modified_duration: z.number(),
      par_amount: z.number(),
      /**
       * ⚠️ THE PERIOD START, WHERE index_constituents.date IS THE PERIOD END.
       * The two tables label the same period by OPPOSITE endpoints, which makes
       * a naive comparison of their counts one period out and looks exactly like
       * a data bug. Analytics anchored at 2026-08-31 describe the portfolio
       * struck THEN and running to 2026-09-30; the constituent file named
       * 2026-08-31 describes the portfolio struck a month EARLIER. Verified
       * upstream by CUSIP set, not by count: zero differences across all eleven
       * indices against the file named one month after the anchor.
       */
      rebalance_date: zIsoDate,
      spread_duration: z.number(),
      yield_to_maturity: z.number(),
   })
   .transform((row) => ({
      averageMaturity: row.average_maturity,
      averagePrice: row.average_price,
      /** Percent, converted from the fraction the table stores. */
      basisSharePercent: row.basis_share * 100,
      constituentCount: row.constituents,
      /**
       * ⚠️ DIVIDED BY 100, WHICH IS THE REPORTING CONVENTION AND NOT A FUDGE.
       *
       * Upstream stores the raw textbook quantity, (1/P) d2P/dy2 in years
       * squared, and it is correct: pricing a 30-year 4.75% at 5% by hand and
       * taking a central second difference reproduces its 358.2180 to
       * finite-difference truncation. S&P, Bloomberg and ICE all publish that
       * number divided by 100.
       *
       * The divisor is what lets the second-order term be written with yield in
       * PERCENTAGE POINTS rather than decimals: half x 358.21 x 0.01^2 and
       * half x 3.5821 x 1^2 are the same 1.79% of price for a 100bp move.
       *
       * It is scaled HERE, at the one boundary this app converts units at —
       * beside couponPercent, indexRatePercent and four others — so every
       * surface downstream agrees by construction. The index page, the security
       * pages, the calculator, both markdown exports and the MCP examples all
       * read this field, and scaling at any one of them would have put our own
       * site on two conventions under one name.
       *
       * The stored value stays raw. A database should hold the definitional
       * quantity; the scale a reader expects is a presentation decision.
       *
       * WHY IT CHANGED: published as 65.69 against S&P's 0.56 on a comparable
       * index, our figure read as a hundredfold error to Dylan, who knows this
       * data better than any reader will. Being right is not the same as being
       * readable, and a correct number that looks wrong on every comparison a
       * prospect makes is not doing its job.
       */
      convexity: row.convexity / 100,
      couponRatePercent: row.coupon_rate,
      date: row.date,
      durationBasis: row.duration_basis,
      /**
       * IN CURVE ORDER, NOT ALPHABETICAL, and built here so no caller has to
       * know that "03m" sorts before "01y" numerically but after it on a curve.
       * The profile is only meaningful read left to right along the maturity
       * axis; sorted any other way it is twelve unrelated numbers.
       */
      // SHAPED FOR KeyRateProfile, the component the security pages already use.
      // `label` is what the axis reads, `value` is the duration contribution and
      // `years` is the tenor's position on the curve. Matching the existing
      // component rather than drawing a second chart means one treatment of the
      // same quantity across the site, and the one that has already been looked
      // at and approved.
      keyRateDurations: [
         { label: "3m", value: row.krd_03m, years: 0.25 },
         { label: "6m", value: row.krd_06m, years: 0.5 },
         { label: "1y", value: row.krd_01y, years: 1 },
         { label: "2y", value: row.krd_02y, years: 2 },
         { label: "3y", value: row.krd_03y, years: 3 },
         { label: "5y", value: row.krd_05y, years: 5 },
         { label: "7y", value: row.krd_07y, years: 7 },
         { label: "10y", value: row.krd_10y, years: 10 },
         { label: "15y", value: row.krd_15y, years: 15 },
         { label: "20y", value: row.krd_20y, years: 20 },
         { label: "25y", value: row.krd_25y, years: 25 },
         { label: "30y", value: row.krd_30y, years: 30 },
      ],
      marketValue: row.market_value,
      modifiedDuration: row.modified_duration,
      parAmount: row.par_amount,
      rebalanceDate: row.rebalance_date,
      spreadDuration: row.spread_duration,
      /** Already percent upstream, unlike the returns below. */
      yieldToMaturityPercent: row.yield_to_maturity,
   }));

export type TIndexAnalytics = z.infer<typeof ZIndexAnalytics>;

/**
 * Period returns for one index, to the newest valuation day.
 *
 * ⚠️ DECIMALS UPSTREAM, PERCENT HERE. -0.0315707 is -3.1571%, and rendering the
 * raw figure would publish an index down three percent as down three hundredths
 * of one. Same boundary the rest of this file crosses: rates in are decimals,
 * yields out are percent.
 *
 * `qtd` and `ytd` are NULL where the index has no level before the period
 * boundary, rather than quietly measuring from inception — which would be a
 * different quantity under the same name. BILL, TIPS and FRN all start later
 * than the coupon families, so a young series near a boundary is absent rather
 * than zero and must render that way.
 */
export const ZIndexReturns = z
   .object({
      asOf: zIsoDate,
      code: z.string(),
      mtd: z.number().nullable(),
      qtd: z.number().nullable(),
      ytd: z.number().nullable(),
   })
   .transform((row) => ({
      asOf: row.asOf,
      code: row.code,
      mtdPercent: row.mtd === null ? null : row.mtd * 100,
      qtdPercent: row.qtd === null ? null : row.qtd * 100,
      ytdPercent: row.ytd === null ? null : row.ytd * 100,
   }));

export type TIndexReturns = z.infer<typeof ZIndexReturns>;

export const ZFundComparison = z
   .object({
      code: z.string(),
      expected_bp: z.number(),
      first_date: zIsoDate,
      mean_bp: z.number(),
      median_bp: z.number(),
      months: z.number().int(),
      std_dev_bp: z.number(),
      ticker: z.string(),
      worst_at: zIsoDate,
      worst_bp: z.number(),
   })
   .transform((row) => ({
      code: row.code,
      expectedBp: row.expected_bp,
      firstDate: row.first_date,
      meanBp: row.mean_bp,
      medianBp: row.median_bp,
      months: row.months,
      stdDevBp: row.std_dev_bp,
      ticker: row.ticker,
      worstAt: row.worst_at,
      worstBp: row.worst_bp,
   }));

export type TFundComparison = z.infer<typeof ZFundComparison>;

/**
 * Indices whose constituents are published.
 *
 * ALL ELEVEN, as of 2026-09-10. This was nine: TIPS and FRN holdings had never
 * been emitted, so those two indices had levels nobody could reproduce, and
 * their pages said so rather than offering a link that 404s. Upstream has since
 * published both, along with every historical rebalance rather than only the
 * current month — 212,093 holdings across 215 rebalances, verified per code in
 * the store on 2026-09-10.
 *
 * FRN starts 2014-12-31 rather than 2008-10-31, because floating-rate notes did
 * not exist until November 2014. That is 141 rebalances against the others' 215
 * and is correct, not a gap. Nothing here hardcodes a date range: the page asks
 * getConstituentDates which rebalances resolve, so a code's own coverage is
 * whatever upstream reports for it.
 *
 * The list is kept rather than deleted because it is the gate on the
 * constituents route and its link, and a code with no holdings must still
 * degrade to an acknowledged gap rather than a broken link.
 */
export const INDICES_WITH_CONSTITUENTS: readonly TIndexCode[] = [
   "broad",
   "0103",
   "0307",
   "0710",
   "1020",
   "20PL",
   "BILL",
   "SHRT",
   "AGG",
   "TIPS",
   "FRN",
];

export const hasConstituents = (code: TIndexCode) =>
   INDICES_WITH_CONSTITUENTS.includes(code);

/**
 * One holding in one index at one rebalance — the CSV a reader downloads,
 * column for column.
 *
 * THE THREE DEDUCTIONS ARE ORDERED AND THE ORDER IS A METHODOLOGY CLAIM.
 * `parAuctioned` less `parBoughtBack` less `parHeldInSoma` equals `floatPar`,
 * applied in that sequence rather than merged, because a buyback destroys the
 * debt while the Federal Reserve only parks it. Merging them would restore
 * retired par the moment quantitative tightening reversed. The page renders it
 * as a chain rather than four independent columns for that reason.
 *
 * `contributionToIndexReturn` is the field the page exists for: the
 * contributions SUM TO THE MONTH'S RETURN, so a reader with a spreadsheet can
 * check a published level rather than take it on trust. The sum is computed in
 * the page from the rows fetched, not read from anywhere.
 */
/**
 * The seventeen columns BOTH constituent tables carry, shared rather than
 * transcribed twice.
 *
 * `index_constituents` and `index_constituents_open` are the same eighteen
 * columns except for how they name their dates: the closed table has one
 * `date`, the open one has `rebalance_date` and `as_of_date`. Writing the rest
 * out twice would leave two copies of a decimal-to-percent conversion that must
 * agree, and this repository has now shipped that exact bug twice — a coupon
 * field holding a spread, and an index name collapsing two indices into one.
 * Neither was visible in the file that contained it; both needed two things
 * compared.
 */
const zConstituentColumns = z.object({
   code: z.string(),
   contribution_to_index_return: z.number(),
   coupon_pct: z.number(),
   coupons_received: z.number(),
   cusip: z.string(),
   end_dirty: z.number(),
   float_par: z.number(),
   less_par_bought_back: z.number(),
   less_par_held_in_soma: z.number(),
   market_value: z.number(),
   maturity: zIsoDate,
   par_auctioned: z.number(),
   security_return: z.number(),
   start_accrued: z.number(),
   start_clean_bid: z.number(),
   start_dirty: z.number(),
   weight: z.number(),
});

/**
 * The shared columns in this app's spelling. Dates are added by each caller,
 * because naming them is the ONE thing the two tables genuinely do differently.
 */
const constituentColumns = (row: z.infer<typeof zConstituentColumns>) => ({
   code: row.code,
   /** Decimal upstream; percent here, matching monthReturnPercent. */
   contributionPercent: row.contribution_to_index_return * 100,
   couponPercent: row.coupon_pct,
   couponsReceived: row.coupons_received,
   cusip: row.cusip,
   endDirty: row.end_dirty,
   floatPar: row.float_par,
   marketValue: row.market_value,
   maturity: row.maturity,
   parAuctioned: row.par_auctioned,
   parBoughtBack: row.less_par_bought_back,
   parHeldInSoma: row.less_par_held_in_soma,
   securityReturnPercent: row.security_return * 100,
   startAccrued: row.start_accrued,
   startCleanBid: row.start_clean_bid,
   startDirty: row.start_dirty,
   weightPercent: row.weight * 100,
});

export const ZIndexConstituent = zConstituentColumns
   .extend({ date: zIsoDate })
   .transform((row) => ({ ...constituentColumns(row), date: row.date }));

export type TIndexConstituent = z.infer<typeof ZIndexConstituent>;

/**
 * One holding of the period that is STILL RUNNING.
 *
 * THE TWIN OF ZIndexConstituent, AND THE DIFFERENCE IS NOT COSMETIC. That one
 * describes a closed period: members struck at one rebalance, held to the next,
 * whose contributions sum to a published monthly return that will never change.
 * This one describes the period still open — the members struck at the most
 * recent rebalance, with what each has earned SO FAR. Its contributions sum to
 * the month-to-date return and they move every trading day.
 *
 * TWO DATES, BOTH NAMED, because naming one is what produced a page showing one
 * month's holdings under another month's count. `rebalanceDate` is when the
 * membership and weights were struck; `asOfDate` is the day they are priced
 * through, and it is NOT necessarily the newest day the index has a level for —
 * the open snapshot has run a day behind the daily levels. Anything rendered
 * from these rows must carry `asOfDate`, never the page's own valuation date.
 */
export const ZOpenConstituent = zConstituentColumns
   .extend({ as_of_date: zIsoDate, rebalance_date: zIsoDate })
   .transform((row) => ({
      ...constituentColumns(row),
      asOfDate: row.as_of_date,
      rebalanceDate: row.rebalance_date,
   }));

export type TOpenConstituent = z.infer<typeof ZOpenConstituent>;

/**
 * The open period as upstream sends it: an envelope naming both dates, then the
 * members.
 *
 * ⚠️ UPSTREAM'S `holdings` COUNT IS DELIBERATELY DROPPED. It is
 * `constituents.length` computed on the other side of a network call, and a
 * count carried separately from the list it counts is precisely the shape that
 * put 298 and 299 on the same page under the same date. If the two ever
 * disagreed there would be no way to tell from here which was right, so only
 * the list crosses this boundary and everything downstream counts it.
 *
 * Sorted heaviest first here rather than at each call site, matching
 * getIndexConstituents.
 */
export const ZOpenConstituents = z
   .object({
      as_of_date: zIsoDate,
      code: z.string(),
      constituents: z.array(ZOpenConstituent),
      rebalance_date: zIsoDate,
   })
   .transform((reply) => ({
      asOfDate: reply.as_of_date,
      code: reply.code,
      rows: [...reply.constituents].sort(
         (left, right) => right.weightPercent - left.weightPercent,
      ),
      rebalanceDate: reply.rebalance_date,
   }));

export type TOpenConstituents = z.infer<typeof ZOpenConstituents>;

/**
 * Why the open snapshot is absent, when it is.
 *
 * TWO ABSENCES THAT LOOK IDENTICAL FROM A NULL. Never written means the
 * producer has not run for this index yet — an ordinary cold state, and the
 * page's existing "published when the period closes" sentence is true of it.
 * Superseded means we HOLD a snapshot and upstream is refusing to serve it,
 * because a newer rebalance has retired the membership it describes. That is
 * a stalled pipeline, and the closed-period fallback shown without saying so
 * is a page that looks completely healthy while the holdings it shows are the
 * wrong ones.
 *
 * `state` IS DERIVED HERE WHEN UPSTREAM DOES NOT SEND IT. The HTTP route
 * returns it; the RPC method returns `held` and `supersededBy` only. Deriving
 * from those two rather than requiring the field keeps one reader working
 * against both, and the rule is upstream's own: no `held` means never written.
 *
 * ⚠️ `current` ALONGSIDE A NULL SNAPSHOT IS A DEFECT, not a state to render
 * away. It means upstream considers the snapshot live and still served nothing,
 * which the producer's coverage guard is supposed to make impossible. The page
 * says so plainly rather than falling back to the never-written sentence — an
 * impossible state quietly rendered as an ordinary one is how the last three of
 * these survived.
 */
export const ZOpenConstituentsStatus = z
   .object({
      held: zIsoDate.nullable().optional(),
      state: z.enum(["current", "superseded", "never-written"]).optional(),
      supersededBy: zIsoDate.nullable().optional(),
   })
   .transform((row) => {
      const held = row.held ?? null;
      const supersededBy = row.supersededBy ?? null;
      return {
         held,
         state:
            row.state ??
            (held === null
               ? ("never-written" as const)
               : supersededBy === null
                 ? ("current" as const)
                 : ("superseded" as const)),
         supersededBy,
      };
   });

export type TOpenConstituentsStatus = z.infer<typeof ZOpenConstituentsStatus>;

/**
 * Which sentence the holdings fallback should carry.
 *
 * ⚠️ EXTRACTED SO IT CAN BE EXECUTED. The three branches live in JSX inside a
 * 1,800-line route, and the `superseded` one CANNOT REACH PRODUCTION DATA
 * before it matters: nothing has superseded anything until September closes, so
 * the branch would go live having never once run. That is the argument this
 * repository made for the cross-repo ticker check and it applies to its own
 * rendering — a path whose first execution is the morning it is needed is not
 * shipped, it is hoped for.
 *
 * `current` WITH NO SNAPSHOT IS ITS OWN ANSWER, not a fall-through. Upstream
 * saying the list is live while returning nothing is a defect on one side or
 * the other, and the one thing it must not do is borrow the never-written
 * sentence, which would present a broken read as an ordinary cold start.
 *
 * A null status means upstream cannot answer — the method is not deployed, or
 * the call failed — and the honest sentence is the one the page carried before
 * any of this existed.
 */
export const openHoldingsNotice = (
   status: TOpenConstituentsStatus | null,
): "never-written" | "superseded" | "unread" => {
   if (status === null) return "never-written";
   if (status.state === "superseded" && status.supersededBy !== null) {
      return "superseded";
   }
   // Superseded without naming what superseded it is upstream contradicting
   // itself. It is still not a cold start, so it must not read as one.
   if (status.state === "superseded") return "unread";
   if (status.state === "current") return "unread";
   return "never-written";
};
