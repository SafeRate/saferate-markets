import { describe, expect, test } from "bun:test";
import { ZTipsAnalytics } from "@saferate/treasury-client/types";

/**
 * 912810FD5 on 2026-09-08, copied verbatim from `tips_analytics`. Chosen
 * because its index ratio is the highest in the table at 2.0647, which is where
 * confusing the real price for the money price does the most visible damage.
 */
const ROW = {
   accrued_real: 1.455943,
   convexity: 2.7143,
   cusip: "912810FD5",
   date: "2026-09-08",
   dv01: 0.015845,
   index_ratio: 2.06469,
   indexed_principal: 206.468983,
   macaulay_duration: 1.546382,
   modified_duration: 1.529232,
   price_residual_cents: -18.09,
   real_clean_price: 102.15625,
   real_dirty_price: 103.612193,
   real_yield: 2.24306,
   residual_basis_points: 11.42,
   residual_z_score: 1.03,
};

describe("ZTipsAnalytics", () => {
   test("keeps the real yield in PERCENT, unlike the floater table's decimals", () => {
      // The asymmetry that is not guessable from column names: real_yield
      // 2.24306 is 2.24306%, while frn_analytics.discount_margin 0.000525 is
      // 5.25 bp. No conversion belongs here.
      expect(ZTipsAnalytics.parse(ROW).realYield).toBe(2.24306);
   });

   test("treats index_ratio as a multiplier and derives the money price from it", () => {
      const row = ZTipsAnalytics.parse(ROW);

      expect(row.indexRatio).toBe(2.06469);
      // The whole point: the real price is NOT what a holder pays. Upstream
      // named this the field most likely to be rendered wrong, so the
      // multiplication happens once, here.
      expect(row.realCleanPrice).toBe(102.15625);
      expect(row.moneyCleanPrice).toBeCloseTo(102.15625 * 2.06469, 9);
      expect(row.moneyCleanPrice).toBeGreaterThan(row.realCleanPrice);
   });

   test("does NOT clamp an index ratio below one", () => {
      // Deflation. 38 linkers have dipped below 1. The inflation floor applies
      // to the final redemption -- the greater of par and indexed principal --
      // not to the ratio along the way, so clamping would invent a protection
      // that does not exist yet.
      const row = ZTipsAnalytics.parse({
         ...ROW,
         index_ratio: 0.975,
         indexed_principal: 97.504,
      });

      expect(row.indexRatio).toBe(0.975);
      // And the money price falls below the real price, which is the correct
      // consequence rather than something to guard against.
      expect(row.moneyCleanPrice).toBeLessThan(row.realCleanPrice);
   });

   test("accepts the three fields upstream withholds near maturity", () => {
      // real_yield, residual_basis_points and residual_z_score are nullable as
      // of 2026-09-10, withheld together under a month to maturity. Declared
      // non-nullable, this row throws and takes the page down with it.
      const row = ZTipsAnalytics.parse({
         ...ROW,
         real_yield: null,
         residual_basis_points: null,
         residual_z_score: null,
      });

      expect(row.realYield).toBeNull();
      expect(row.residualBasisPoints).toBeNull();
      expect(row.residualZScore).toBeNull();
      // The cents residual and the durations survive, because none annualises.
      expect(row.priceResidualCents).toBe(-18.09);
      expect(row.modifiedDuration).toBe(1.529232);
   });

   test("distinguishes the real prices from the money price by name", () => {
      const row = ZTipsAnalytics.parse(ROW);

      // Every real figure is named real*, so a component cannot reach for a
      // bare `cleanPrice` and get real terms by accident.
      expect(row).toMatchObject({
         accruedReal: 1.455943,
         realDirtyPrice: 103.612193,
      });
      expect(row).not.toHaveProperty("cleanPrice");
   });
});
