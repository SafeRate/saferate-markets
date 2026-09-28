import { describe, expect, test } from "bun:test";
import type { TTreasuryEnv } from "@saferate/treasury-client/client";
import { getZeroCurveSeries } from "@saferate/treasury-client/client";

// `curveSeries` returned a BARE ARRAY and is becoming `{ rows, truncated }`.
// At the time of writing the new shape is written upstream but neither
// committed nor deployed, so both treasury-api environments still answer with
// an array. Consumer accepts either, which is what removes the deploy-ordering
// constraint between the two workers — upstream and consumer can deploy in
// either order, and the two environments can move independently.
//
// These tests are the reason that stays true. Delete the legacy half of them
// only when the legacy path itself is deleted.

const ROW = {
   converged: 1,
   date: "2020-03-09",
   forward_rate: 0.9,
   lambda_1: 2.1,
   lambda_2: 16.2,
   par_yield: 0.55,
   rmse_basis_points: 3.3,
   rmse_price_cents: 15.8,
   security_count: 300,
   tenor_years: 10,
   theta_0: -0.02,
   theta_1: 0.06,
   theta_2: 0.05,
   theta_3: 0.23,
   zero_rate: 0.6,
};

/** A stub env carrying just the one RPC method under test. */
const envReturning = (reply: unknown) =>
   ({
      TREASURY: { curveSeries: async () => reply },
   }) as unknown as TTreasuryEnv;

const call = (reply: unknown) =>
   getZeroCurveSeries({
      env: envReturning(reply),
      from: "2020-03-01",
      to: "2020-03-31",
   });

describe("getZeroCurveSeries accepts both upstream reply shapes", () => {
   test("the LEGACY bare array parses", async () => {
      const points = await call([ROW]);

      expect(points).toHaveLength(1);
      expect(points[0].zeroRate).toBe(0.6);
      expect(points[0].tenorYears).toBe(10);
   });

   test("the NEW { rows, truncated } shape parses", async () => {
      const points = await call({ rows: [ROW], truncated: false });

      expect(points).toHaveLength(1);
      expect(points[0].zeroRate).toBe(0.6);
   });

   test("both shapes yield identical output for identical rows", async () => {
      // The whole point: the page cannot tell which worker version answered.
      expect(await call([ROW])).toEqual(
         await call({ rows: [ROW], truncated: false }),
      );
   });

   test("an empty reply is empty in either shape, not an error", async () => {
      expect(await call([])).toEqual([]);
      expect(await call({ rows: [], truncated: false })).toEqual([]);
   });
});

describe("truncation throws rather than rendering a short series", () => {
   test("the NEW shape throws on the flag, whatever the row count", async () => {
      // One row and truncated:true is not a realistic reply, which is exactly
      // why it is the right test: it proves the FLAG is what is read, not the
      // length.
      expect(call({ rows: [ROW], truncated: true })).rejects.toThrow(
         /truncated upstream/,
      );
   });

   test("the LEGACY shape infers truncation at the 20,000-row ceiling", async () => {
      // A bare array carries no flag, so the count is all there is. Ten rows
      // per day means this ceiling is only ~2,000 trading days, so a
      // full-history request used to come back holding the first eight years
      // and looking complete.
      const atCeiling = Array.from({ length: 20_000 }, () => ROW);

      expect(call(atCeiling)).rejects.toThrow(/truncated upstream/);
   });

   test("the LEGACY shape does NOT cry truncation just under the ceiling", async () => {
      const justUnder = Array.from({ length: 19_999 }, () => ROW);

      expect(await call(justUnder)).toHaveLength(19_999);
   });
});

describe("a missing binding degrades rather than throwing", () => {
   test("no TREASURY binding yields an empty series", async () => {
      // The local-dev case: SAFERATE_LOCAL_DB=1 turns remote bindings off.
      const points = await getZeroCurveSeries({
         env: {} as unknown as TTreasuryEnv,
         from: "2020-03-01",
         to: "2020-03-31",
      });

      expect(points).toEqual([]);
   });
});

describe("range validation happens before any RPC call", () => {
   test("a reversed range is refused locally", async () => {
      let wasCalled = false;
      const env = {
         TREASURY: {
            curveSeries: async () => {
               wasCalled = true;
               return [];
            },
         },
      } as unknown as TTreasuryEnv;

      expect(
         getZeroCurveSeries({ env, from: "2020-03-31", to: "2020-03-01" }),
      ).rejects.toThrow();
      expect(wasCalled).toBe(false);
   });

   test("a date before coverage is refused locally", async () => {
      expect(
         getZeroCurveSeries({
            env: envReturning([]),
            from: "2007-01-01",
            to: "2007-12-31",
         }),
      ).rejects.toThrow();
   });
});
