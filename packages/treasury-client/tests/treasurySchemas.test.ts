import { describe, expect, test } from "bun:test";
import {
   ZCurveFamily,
   ZCurveFitDiagnostics,
   ZLscCurveDay,
   ZMoneyMarketCurveDay,
   ZParCurveDay,
   ZZeroCurvePoint,
} from "@saferate/treasury-client/types";

// Row fixtures copied VERBATIM from the treasury D1 database on 2026-09-09
// (date 2026-09-01), so a column rename or type change upstream shows up here
// rather than as `undefined` rendered into a rate table on saferate.com.
//
// This matters more than a normal schema test because the treasury data arrives
// over an RPC service binding whose method signatures are transcribed by hand in
// app/lib/treasury.server.ts — TypeScript cannot see the upstream class, so
// nothing in this repo fails to compile when the shape moves. These parses are
// the only mechanical check that the contract still holds.

const ZERO_ROWS = [
   {
      date: "2026-09-01",
      tenor_years: 1,
      security_count: 339,
      iterations: 113,
      weighted_sum_squares: 0.3926340855268095,
      rmse_price_cents: 15.879417265181397,
      rmse_basis_points: 3.326462390823243,
      converged: 1,
      theta_0: -0.02455272425027209,
      theta_1: 0.06254859399202818,
      theta_2: 0.05582901726746151,
      theta_3: 0.23165230751306387,
      lambda_1: 2.1640271695618534,
      lambda_2: 16.25898172139747,
      zero_rate: 4.191008859279699,
      par_yield: 4.233530209279243,
      forward_rate: 4.450014135511421,
   },
   {
      date: "2026-09-01",
      tenor_years: 2,
      security_count: 339,
      iterations: 113,
      weighted_sum_squares: 0.3926340855268095,
      rmse_price_cents: 15.879417265181397,
      rmse_basis_points: 3.326462390823243,
      converged: 1,
      theta_0: -0.02455272425027209,
      theta_1: 0.06254859399202818,
      theta_2: 0.05582901726746151,
      theta_3: 0.23165230751306387,
      lambda_1: 2.1640271695618534,
      lambda_2: 16.25898172139747,
      zero_rate: 4.367857504330358,
      par_yield: 4.410864719724,
      forward_rate: 4.594295601001579,
   },
   {
      date: "2026-09-01",
      tenor_years: 3,
      security_count: 339,
      iterations: 113,
      weighted_sum_squares: 0.3926340855268095,
      rmse_price_cents: 15.879417265181397,
      rmse_basis_points: 3.326462390823243,
      converged: 1,
      theta_0: -0.02455272425027209,
      theta_1: 0.06254859399202818,
      theta_2: 0.05582901726746151,
      theta_3: 0.23165230751306387,
      lambda_1: 2.1640271695618534,
      lambda_2: 16.25898172139747,
      zero_rate: 4.4449338499620215,
      par_yield: 4.487727399772426,
      forward_rate: 4.597422289438224,
   },
   {
      date: "2026-09-01",
      tenor_years: 5,
      security_count: 339,
      iterations: 113,
      weighted_sum_squares: 0.3926340855268095,
      rmse_price_cents: 15.879417265181397,
      rmse_basis_points: 3.326462390823243,
      converged: 1,
      theta_0: -0.02455272425027209,
      theta_1: 0.06254859399202818,
      theta_2: 0.05582901726746151,
      theta_3: 0.23165230751306387,
      lambda_1: 2.1640271695618534,
      lambda_2: 16.25898172139747,
      zero_rate: 4.515382450031792,
      par_yield: 4.557243859528378,
      forward_rate: 4.682943082734753,
   },
   {
      date: "2026-09-01",
      tenor_years: 7,
      security_count: 339,
      iterations: 113,
      weighted_sum_squares: 0.3926340855268095,
      rmse_price_cents: 15.879417265181397,
      rmse_basis_points: 3.326462390823243,
      converged: 1,
      theta_0: -0.02455272425027209,
      theta_1: 0.06254859399202818,
      theta_2: 0.05582901726746151,
      theta_3: 0.23165230751306387,
      lambda_1: 2.1640271695618534,
      lambda_2: 16.25898172139747,
      zero_rate: 4.602601518674668,
      par_yield: 4.6381775678139325,
      forward_rate: 4.986319484186975,
   },
   {
      date: "2026-09-01",
      tenor_years: 10,
      security_count: 339,
      iterations: 113,
      weighted_sum_squares: 0.3926340855268095,
      rmse_price_cents: 15.879417265181397,
      rmse_basis_points: 3.326462390823243,
      converged: 1,
      theta_0: -0.02455272425027209,
      theta_1: 0.06254859399202818,
      theta_2: 0.05582901726746151,
      theta_3: 0.23165230751306387,
      lambda_1: 2.1640271695618534,
      lambda_2: 16.25898172139747,
      zero_rate: 4.80512512202591,
      par_yield: 4.814184520138858,
      forward_rate: 5.562743419057936,
   },
   {
      date: "2026-09-01",
      tenor_years: 15,
      security_count: 339,
      iterations: 113,
      weighted_sum_squares: 0.3926340855268095,
      rmse_price_cents: 15.879417265181397,
      rmse_basis_points: 3.326462390823243,
      converged: 1,
      theta_0: -0.02455272425027209,
      theta_1: 0.06254859399202818,
      theta_2: 0.05582901726746151,
      theta_3: 0.23165230751306387,
      lambda_1: 2.1640271695618534,
      lambda_2: 16.25898172139747,
      zero_rate: 5.165868737500277,
      par_yield: 5.101357657874717,
      forward_rate: 6.08373043485014,
   },
   {
      date: "2026-09-01",
      tenor_years: 20,
      security_count: 339,
      iterations: 113,
      weighted_sum_squares: 0.3926340855268095,
      rmse_price_cents: 15.879417265181397,
      rmse_basis_points: 3.326462390823243,
      converged: 1,
      theta_0: -0.02455272425027209,
      theta_1: 0.06254859399202818,
      theta_2: 0.05582901726746151,
      theta_3: 0.23165230751306387,
      lambda_1: 2.1640271695618534,
      lambda_2: 16.25898172139747,
      zero_rate: 5.38265058357691,
      par_yield: 5.2620987727368504,
      forward_rate: 5.878553964582237,
   },
   {
      date: "2026-09-01",
      tenor_years: 25,
      security_count: 339,
      iterations: 113,
      weighted_sum_squares: 0.3926340855268095,
      rmse_price_cents: 15.879417265181397,
      rmse_basis_points: 3.326462390823243,
      converged: 1,
      theta_0: -0.02455272425027209,
      theta_1: 0.06254859399202818,
      theta_2: 0.05582901726746151,
      theta_3: 0.23165230751306387,
      lambda_1: 2.1640271695618534,
      lambda_2: 16.25898172139747,
      zero_rate: 5.419484042710192,
      par_yield: 5.3038105583485,
      forward_rate: 5.199735003355801,
   },
   {
      date: "2026-09-01",
      tenor_years: 30,
      security_count: 339,
      iterations: 113,
      weighted_sum_squares: 0.3926340855268095,
      rmse_price_cents: 15.879417265181397,
      rmse_basis_points: 3.326462390823243,
      converged: 1,
      theta_0: -0.02455272425027209,
      theta_1: 0.06254859399202818,
      theta_2: 0.05582901726746151,
      theta_3: 0.23165230751306387,
      lambda_1: 2.1640271695618534,
      lambda_2: 16.25898172139747,
      zero_rate: 5.309490059220599,
      par_yield: 5.2687572027007,
      forward_rate: 4.298371460884747,
   },
] as const;

const PAR_ROW = {
   date: "2026-09-01",
   security_count: 339,
   iterations: 216,
   squared_error: 0.41348200325184997,
   rmse_basis_points: 3.492436003775524,
   max_residual_basis_points: 30.056245069705767,
   converged: 1,
   weighting: "price squared",
   theta_0: -0.004608708664050833,
   theta_1: 0.04291013793806068,
   theta_2: 0.04473500200222705,
   theta_3: 0.17275291739197537,
   lambda_1: 1.966561424411264,
   lambda_2: 16.033090932434202,
   rate_03m: 3.9632469166551823,
   rate_04m: 4.002186074522844,
   rate_06m: 4.0728162326579245,
   rate_12m: 4.23595921886368,
   rate_02y: 4.414148071618282,
   rate_03y: 4.489814150121751,
   rate_05y: 4.557256600129532,
   rate_07y: 4.6381412257528485,
   rate_10y: 4.8186609722434515,
   rate_15y: 5.127302100350841,
   rate_20y: 5.309297353830936,
   rate_25y: 5.3450136067468135,
   rate_30y: 5.265333800585726,
} as const;

const LSC_ROW = {
   date: "2026-09-01",
   security_count: 339,
   squared_error: 4.455188201075364,
   rmse_basis_points: 11.463920832668043,
   lambda: 1.3684,
   beta_0: 5.384734467273411,
   beta_1: -1.1451182822727084,
   beta_2: -1.6297315880371432,
   level: 5.384734467273411,
   slope: 1.1451182822727084,
   curvature: -1.6297315880371432,
   implied_short_rate: 4.239616185000703,
   rate_03m: 4.206206547690985,
   rate_06m: 4.191255805311121,
   rate_01y: 4.200830703245928,
   rate_02y: 4.304299652710085,
   rate_03y: 4.442322561967339,
   rate_05y: 4.687168472853276,
   rate_07y: 4.855330950803591,
   rate_10y: 5.006370913689139,
   rate_20y: 5.194880056659004,
   rate_30y: 5.25816431571792,
} as const;

const MONEY_MARKET_ROW = {
   date: "2026-09-01",
   convention: "bond equivalent",
   bill_count: 45,
   security_count: 45,
   iterations: 77,
   squared_error: 0.025847693038736387,
   rmse_basis_points: 2.3966501176404256,
   max_residual_basis_points: 7.0104479810515485,
   converged: 1,
   beta_0: 4.409200018285024,
   beta_1: -0.7167621878349498,
   beta_2: 2.3272050173512394e-8,
   lambda: 0.4340272488176029,
   implied_overnight: 3.6924378304500745,
   rate_01w: 3.708042700680529,
   rate_01m: 3.7570468069274208,
   rate_02m: 3.814010214933926,
   rate_03m: 3.864339537993918,
   rate_04m: 3.908903973899366,
   rate_06m: 3.9836252871678965,
   rate_09m: 4.068090893153671,
   rate_12m: 4.129171063596943,
} as const;

const SERIES_META_ROW = {
   series_id: "CPIAUCSL",
   title: "Consumer Price Index for All Urban Consumers: All Items in U.S. City Average",
   units: "Index 1982-1984=100",
   frequency: "Monthly",
   seasonal_adjustment: "Seasonally Adjusted",
   source: "US Bureau of Labor Statistics",
   licence: "public-domain",
   category: "inflation",
   observation_start: "1990-01-01",
   observation_end: "2026-07-01",
   observations: 438,
} as const;

describe("treasury row schemas", () => {
   test("parses every tenor of a real zero curve day", () => {
      const points = ZERO_ROWS.map((row) => ZZeroCurvePoint.parse(row));

      expect(points).toHaveLength(10);
      expect(points.map((point) => point.tenorYears)).toEqual([
         1, 2, 3, 5, 7, 10, 15, 20, 25, 30,
      ]);
      // Rates are PERCENT, not decimals. A curve parsed as decimals would put
      // every tenor under 0.1 and render as "0.053%".
      for (const point of points) {
         expect(point.zeroRate).toBeGreaterThan(0.5);
         expect(point.zeroRate).toBeLessThan(25);
      }
      expect(points[9].zeroRate).toBeCloseTo(5.309, 3);
   });

   test("reads the day's fit diagnostics off any zero curve row", () => {
      const diagnostics = ZCurveFitDiagnostics.parse(ZERO_ROWS[0]);

      expect(diagnostics.date).toBe("2026-09-01");
      expect(diagnostics.securityCount).toBe(339);
      expect(diagnostics.rmseBasisPoints).toBeCloseTo(3.326, 3);
      // SQLite has no boolean; `converged` is a 0/1 integer and must come back
      // as a real boolean or `hasConverged ? …` is true for both values.
      expect(diagnostics.hasConverged).toBe(true);
      expect(typeof diagnostics.hasConverged).toBe("boolean");
   });

   test("diagnostics are identical on every row of the same day", () => {
      // They are repeated per tenor upstream, which is what lets the page read
      // them off row 0 instead of issuing a second query.
      const first = ZCurveFitDiagnostics.parse(ZERO_ROWS[0]);
      for (const row of ZERO_ROWS) {
         expect(ZCurveFitDiagnostics.parse(row)).toEqual(first);
      }
   });

   test("parses a real par curve day into thirteen ordered tenors", () => {
      const par = ZParCurveDay.parse(PAR_ROW);

      expect(par.rates).toHaveLength(13);
      expect(par.rates.map((rate) => rate.label)).toEqual([
         "3M",
         "4M",
         "6M",
         "1Y",
         "2Y",
         "3Y",
         "5Y",
         "7Y",
         "10Y",
         "15Y",
         "20Y",
         "25Y",
         "30Y",
      ]);
      // Tenors must be strictly increasing, or the plot draws a line that
      // doubles back on itself.
      const tenors = par.rates.map((rate) => rate.tenorYears);
      expect(tenors).toEqual([...tenors].sort((left, right) => left - right));
      expect(par.rates[8].rate).toBeCloseTo(4.8187, 4);
      expect(par.hasConverged).toBe(true);
   });

   test("parses a real LSC day and exposes its three factors", () => {
      const lsc = ZLscCurveDay.parse(LSC_ROW);

      expect(lsc.rates).toHaveLength(10);
      // level/slope/curvature are the betas restated, and the page shows them
      // as the headline numbers, so they must line up.
      expect(lsc.level).toBeCloseTo(lsc.beta0, 10);
      expect(lsc.curvature).toBeCloseTo(lsc.beta2, 10);
      expect(lsc.slope).toBeCloseTo(-lsc.beta1, 10);
      expect(lsc.impliedShortRate).toBeCloseTo(4.2396, 4);
   });

   test("parses a real money market day", () => {
      const moneyMarket = ZMoneyMarketCurveDay.parse(MONEY_MARKET_ROW);

      expect(moneyMarket.rates).toHaveLength(8);
      expect(moneyMarket.billCount).toBe(45);
      // The conversion basis is load-bearing: bills are quoted on a discount
      // basis, so a page that omits this implies a comparability that is absent.
      expect(moneyMarket.convention).toBe("bond equivalent");
      expect(moneyMarket.impliedOvernight).toBeCloseTo(3.6924, 4);
      // Every tenor is under a year — this family does not reach the coupon
      // curve's domain.
      for (const rate of moneyMarket.rates) {
         expect(rate.tenorYears).toBeLessThanOrEqual(1);
      }
   });

   test("rejects a row whose rate column has been renamed", () => {
      const { rate_10y: _renamed, ...withoutTenYear } = PAR_ROW;

      // The point of parsing at the boundary: this must throw here rather than
      // render an empty cell where the ten-year par yield should be.
      expect(() => ZParCurveDay.parse(withoutTenYear)).toThrow();
   });

   test("rejects a converged flag that is neither 0 nor 1", () => {
      expect(() =>
         ZCurveFitDiagnostics.parse({ ...ZERO_ROWS[0], converged: true }),
      ).toThrow();
   });
});

describe("curve family enum", () => {
   test("accepts exactly the four published keys", () => {
      for (const family of ["zero", "nss", "diebold-li", "money-market"]) {
         expect(ZCurveFamily.safeParse(family).success).toBe(true);
      }
   });

   test("refuses the swap family", () => {
      // A USD swap curve IS fitted and stored upstream, but DTCC's terms permit
      // internal use and not redistribution. It is excluded from the API, from
      // the SQL export, and from this enum. If this test ever fails, someone has
      // added a route that publishes data Safe Rate has no right to publish.
      expect(ZCurveFamily.safeParse("swap").success).toBe(false);
      expect(ZCurveFamily.safeParse("swaps").success).toBe(false);
   });

   test("refuses a table name", () => {
      // The enum is closed so that no caller can name a table. Restricted
      // economic series live behind the same gate upstream.
      expect(ZCurveFamily.safeParse("economic_series").success).toBe(false);
      expect(ZCurveFamily.safeParse("zero_curves").success).toBe(false);
   });
});

describe("licensed series", () => {
   test("the five restricted ids are not in the publishable metadata fixture", () => {
      // VIXCLS, BAMLH0A0HYM2, UMCSENT, MORTGAGE30US and MORTGAGE15US belong to
      // CBOE, ICE, the University of Michigan and Freddie Mac. Serving them is
      // republication. The gate is upstream in SQL; this asserts the fixture we
      // reason about locally reflects that.
      const restricted = [
         "VIXCLS",
         "BAMLH0A0HYM2",
         "UMCSENT",
         "MORTGAGE30US",
         "MORTGAGE15US",
      ];
      expect(restricted).not.toContain(SERIES_META_ROW.series_id);
      expect(SERIES_META_ROW.licence).toBe("public-domain");
   });
});
