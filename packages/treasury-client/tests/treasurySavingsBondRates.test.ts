import { describe, expect, test } from "bun:test";
import type { TTreasuryEnv } from "@saferate/treasury-client/client";
import { getSavingsBondRates } from "@saferate/treasury-client/client";
import { ZSavingsBondRate } from "@saferate/treasury-client/types";

// Rows copied verbatim from savings_bond_rates in the local treasury store on
// 2026-09-09. RATES ARE DECIMALS in this table, unlike every curve table, which
// stores percent: composite_rate 0.0425503 is 4.255%.
const ROWS = [
   {
      composite_rate: 0.0427924,
      fixed_rate: 0.013000000000000001,
      period_start: "2024-05-01",
      semiannual_inflation_rate: 0.0148,
      series: "I",
   },
   {
      composite_rate: 0.031114,
      fixed_rate: 0.012,
      period_start: "2024-11-01",
      semiannual_inflation_rate: 0.0095,
      series: "I",
   },
   {
      composite_rate: 0.0403404,
      fixed_rate: 0.009000000000000001,
      period_start: "2025-11-01",
      semiannual_inflation_rate: 0.015600000000000001,
      series: "I",
   },
   {
      composite_rate: 0.0425503,
      fixed_rate: 0.009000000000000001,
      period_start: "2026-05-01",
      semiannual_inflation_rate: 0.0167,
      series: "I",
   },
   {
      composite_rate: 0.024,
      fixed_rate: 0.024,
      period_start: "2026-05-01",
      semiannual_inflation_rate: null,
      series: "EE",
   },
] as const;

const envReturning = (rows: unknown) =>
   ({
      TREASURY: { savingsBondRates: async () => rows },
   }) as unknown as TTreasuryEnv;

describe("ZSavingsBondRate", () => {
   test("converts decimals to percent", () => {
      const rate = ZSavingsBondRate.parse(ROWS[3]);

      // 0.0425503 -> 4.255%. Rendering the decimal would show "0.04%".
      expect(rate.compositePercent).toBeCloseTo(4.255, 3);
      expect(rate.fixedPercent).toBeCloseTo(0.9, 3);
      expect(rate.semiannualInflationPercent).toBeCloseTo(1.67, 2);
   });

   test("Series EE has no inflation component, and null is correct there", () => {
      const rate = ZSavingsBondRate.parse(ROWS[4]);

      // An EE rate is fixed for the life of the bond. Null means "not part of
      // this instrument", not "missing".
      expect(rate.semiannualInflationPercent).toBeNull();
      expect(rate.compositePercent).toBeCloseTo(2.4, 3);
      expect(rate.fixedPercent).toBeCloseTo(2.4, 3);
   });

   test("the composite is not the sum of its parts", () => {
      const rate = ZSavingsBondRate.parse(ROWS[3]);
      const fixed = rate.fixedPercent / 100;
      const inflation = (rate.semiannualInflationPercent ?? 0) / 100;

      // fixed + 2*infl + fixed*infl, because the inflation rate is semiannual
      // and compounds against the fixed rate. Naive addition gives 2.57%
      // against the real 4.255%.
      const composite = fixed + 2 * inflation + fixed * inflation;
      expect(composite * 100).toBeCloseTo(rate.compositePercent, 3);
      expect((fixed + inflation) * 100).not.toBeCloseTo(
         rate.compositePercent,
         1,
      );
   });
});

describe("getSavingsBondRates", () => {
   test("picks the most recent period that has already STARTED", async () => {
      // Treasury announces a period before it begins, so the newest row is not
      // necessarily the current one.
      const result = await getSavingsBondRates({
         env: envReturning(ROWS),
         on: "2026-09-01",
      });

      expect(result?.i?.periodStart).toBe("2026-05-01");
      expect(result?.i?.compositePercent).toBeCloseTo(4.255, 3);
      expect(result?.ee?.compositePercent).toBeCloseTo(2.4, 3);
   });

   test("a valuation date before a period ignores that period", async () => {
      const result = await getSavingsBondRates({
         env: envReturning(ROWS),
         on: "2026-01-15",
      });

      // 2026-05-01 has not started yet on that date.
      expect(result?.i?.periodStart).toBe("2025-11-01");
      expect(result?.i?.compositePercent).toBeCloseTo(4.034, 3);
      // EE's only row starts 2026-05-01, so there is no current EE rate.
      expect(result?.ee).toBeNull();
   });

   test("separates the two series rather than mixing them", async () => {
      const result = await getSavingsBondRates({
         env: envReturning(ROWS),
         on: "2026-09-01",
      });

      expect(result?.iHistory).toHaveLength(4);
      for (const rate of result?.iHistory ?? []) {
         expect(rate.series).toBe("I");
      }
   });

   test("an unrecognised series is ignored rather than throwing", async () => {
      // `series` is a plain string on purpose: a third series appearing upstream
      // should not take the rates page down.
      const result = await getSavingsBondRates({
         env: envReturning([
            ...ROWS,
            {
               composite_rate: 0.05,
               fixed_rate: 0.05,
               period_start: "2026-05-01",
               semiannual_inflation_rate: null,
               series: "HH",
            },
         ]),
         on: "2026-09-01",
      });

      expect(result?.i?.periodStart).toBe("2026-05-01");
      expect(result?.ee?.compositePercent).toBeCloseTo(2.4, 3);
   });

   test("no binding degrades to null rather than throwing", async () => {
      const result = await getSavingsBondRates({
         env: {} as unknown as TTreasuryEnv,
         on: "2026-09-01",
      });
      expect(result).toBeNull();
   });
});
