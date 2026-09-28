import { describe, expect, test } from "bun:test";
import {
   REAL_CURVE_FIT_SUSPECT_BP,
   ZRealCurveDay,
} from "@saferate/treasury-client/types";

/** 2026-09-08, copied verbatim from `real_curves`. */
const ROW = {
   converged: 1 as const,
   date: "2026-09-08",
   max_price_error_cents: 83.16506324958084,
   rate_02y: 2.0784369038405197,
   rate_03y: 2.0357409224432628,
   rate_05y: 2.092190578825116,
   rate_07y: 2.234205028357758,
   rate_10y: 2.470845664226168,
   rate_20y: 2.9600536449930694,
   rate_30y: 3.031255459627382,
   rmse_basis_points: 5.914025026396889,
   tips_count: 45,
};

describe("ZRealCurveDay", () => {
   test("reshapes the wide row into seven ordered tenor points", () => {
      const day = ZRealCurveDay.parse(ROW);

      expect(day.rates.map((rate) => rate.tenorYears)).toEqual([
         2, 3, 5, 7, 10, 20, 30,
      ]);
      // No real curve inside two years: rarely enough short linkers to fit one.
      expect(day.rates[0].tenorYears).toBe(2);
   });

   test("keeps real yields in percent, needing no conversion", () => {
      const day = ZRealCurveDay.parse(ROW);

      expect(day.rates[4]).toEqual({
         label: "10Y",
         rate: 2.470845664226168,
         tenorYears: 10,
      });
   });

   test("carries the fit diagnostics the page publishes", () => {
      const day = ZRealCurveDay.parse(ROW);

      expect(day).toMatchObject({
         hasConverged: true,
         rmseBasisPoints: 5.914025026396889,
         tipsCount: 45,
      });
   });

   test("accepts a non-converged day rather than rejecting it", () => {
      // 103 of 4,507 days did not converge, against 16 for the par fit. Those
      // days are shown with a caveat, not withheld.
      expect(ZRealCurveDay.parse({ ...ROW, converged: 0 }).hasConverged).toBe(
         false,
      );
   });

   test("the suspect-fit threshold sits above the typical fit, not below it", () => {
      // 9bp is the measured p95 across 4,507 days and flags 4.9% of them. A
      // threshold under the median would cry wolf on most days, which is the
      // bug the per-family thresholds were introduced to fix.
      expect(REAL_CURVE_FIT_SUSPECT_BP).toBeGreaterThan(6.21);
      expect(ZRealCurveDay.parse(ROW).rmseBasisPoints).toBeLessThan(
         REAL_CURVE_FIT_SUSPECT_BP,
      );
   });
});
