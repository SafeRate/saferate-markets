import { describe, expect, test } from "bun:test";
import { ZFrnAnalytics } from "@saferate/treasury-client/types";

/**
 * A row copied verbatim from `frn_analytics` on 2026-09-10. The point of these
 * tests is the UNITS: every rate in this table is a decimal, while the linker
 * table beside it stores a percent, and nothing in the column names says so.
 * Rendering `discount_margin` as "0.00205%" instead of "20.5 bp" is a mistake
 * no typechecker or reviewer would catch.
 */
const ROW = {
   accrued_interest: 0.4257220907088676,
   clean_price: 99.993036,
   cusip: "91282CRD5",
   date: "2026-09-08",
   dirty_price: 100.41875809070888,
   discount_margin: 0.0005250001540380474,
   index_rate: 0.03806272721740206,
   margin_z_score: 0.7482695500911432,
   quoted_spread: 0.0005,
   rate_duration: 0.0005569613134216986,
   spread_dv01: 0.01842256016215771,
   spread_duration: 1.8345735908739766,
};

describe("ZFrnAnalytics", () => {
   test("converts the decimal rates once, at the boundary", () => {
      const row = ZFrnAnalytics.parse(ROW);

      // 0.0005250001540380474 decimal is 5.250001540380474 basis points, not
      // 0.000525 of anything. Asserted exactly rather than to a tolerance: the
      // conversion is one multiplication and should not lose a digit.
      expect(row.discountMarginBp).toBe(5.250001540380474);
      expect(row.quotedSpreadBp).toBe(5);
      // 0.03806 decimal is 3.806 percent.
      expect(row.indexRatePercent).toBeCloseTo(3.806272721740206, 12);
   });

   test("leaves prices, durations and DV01 in their stored units", () => {
      const row = ZFrnAnalytics.parse(ROW);

      // Per 100 of face, already. No conversion.
      expect(row.cleanPrice).toBe(99.993036);
      expect(row.dirtyPrice).toBe(100.41875809070888);
      expect(row.accruedInterest).toBe(0.4257220907088676);
      // Years, already.
      expect(row.spreadDurationYears).toBe(1.8345735908739766);
      expect(row.spreadDv01).toBe(0.01842256016215771);
   });

   test("keeps a near-zero rate duration rather than treating it as absent", () => {
      const row = ZFrnAnalytics.parse(ROW);

      // A floater resets, so it has almost no sensitivity to the LEVEL of
      // rates. That is the instrument. Anything that rounded this to zero or
      // read it as missing would be describing a fixed-rate note instead.
      expect(row.rateDurationYears).toBeGreaterThan(0);
      expect(row.rateDurationYears).toBeLessThan(0.01);
   });

   test("accepts a null margin z-score", () => {
      // Absent below twenty observations, and also absent on the newest day
      // while the scoring pass catches up — the page tells those apart.
      const row = ZFrnAnalytics.parse({ ...ROW, margin_z_score: null });

      expect(row.marginZScore).toBeNull();
   });

   test("carries a negative discount margin through with its sign", () => {
      // Margins go negative: -0.000024996 is -0.25 bp, a note trading through
      // its reference rate. An absolute value here would erase that.
      const row = ZFrnAnalytics.parse({
         ...ROW,
         discount_margin: -0.000024996,
      });

      expect(row.discountMarginBp).toBeCloseTo(-0.24996, 9);
   });
});
