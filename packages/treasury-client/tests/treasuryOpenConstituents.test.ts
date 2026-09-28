import { describe, expect, test } from "bun:test";
import {
   hasConstituents,
   INDEX_DISPLAY_ORDER,
   INDICES_WITH_CONSTITUENTS,
   ZIndexConstituent,
   ZOpenConstituent,
   ZOpenConstituents,
} from "@saferate/treasury-client/types";

/**
 * THE OPEN PERIOD AND THE CLOSED ONE ARE THE SAME EIGHTEEN COLUMNS except for
 * how they name their dates, and the whole risk in publishing both is that the
 * two spellings drift. A decimal that becomes a percent in one and stays a
 * decimal in the other is a hundred-fold error that renders as a plausible
 * number on both pages, which is the only kind this codebase has ever shipped.
 *
 * These tests compare the two rather than checking either on its own. Each one
 * names the wrong state it would catch.
 */

/** One raw upstream row, in the shared columns' own spelling. */
const rawColumns = {
   code: "broad",
   // Decimals upstream. -0.0154 is -1.54%, and the conversion is the thing
   // most likely to be written once and forgotten in the twin.
   contribution_to_index_return: -0.00019858,
   coupon_pct: 4.625,
   coupons_received: 0,
   cusip: "91282CMM0",
   end_dirty: 99.812345,
   float_par: 61_000_000_000,
   less_par_bought_back: 1_000_000_000,
   less_par_held_in_soma: 5_000_000_000,
   market_value: 60_885_000_000,
   maturity: "2035-02-15",
   par_auctioned: 67_000_000_000,
   security_return: -0.024047,
   start_accrued: 0.201087,
   start_clean_bid: 100.05,
   start_dirty: 100.251087,
   weight: 0.008256,
};

describe("open and closed constituents", () => {
   /**
    * ⚠️ THE DRIFT CHECK, and the reason these schemas share a base rather than
    * being transcribed twice. Would catch: a percent conversion applied on one
    * side only, a column renamed in one spelling, a field dropped from one.
    */
   test("every shared column parses identically on both sides", () => {
      const closed = ZIndexConstituent.parse({
         ...rawColumns,
         date: "2026-08-31",
      });
      const open = ZOpenConstituent.parse({
         ...rawColumns,
         as_of_date: "2026-09-23",
         rebalance_date: "2026-08-31",
      });

      const { date: _closedDate, ...closedShared } = closed;
      const {
         asOfDate: _asOf,
         rebalanceDate: _rebalance,
         ...openShared
      } = open;

      expect(openShared).toEqual(closedShared);
      // And the shared part is not accidentally empty, which would make the
      // comparison above pass while comparing nothing — the failure mode this
      // repository has produced more than any other.
      expect(Object.keys(openShared).length).toBe(17);
   });

   test("decimals become percents, and only where they should", () => {
      const open = ZOpenConstituent.parse({
         ...rawColumns,
         as_of_date: "2026-09-23",
         rebalance_date: "2026-08-31",
      });
      expect(open.weightPercent).toBeCloseTo(0.8256, 10);
      expect(open.securityReturnPercent).toBeCloseTo(-2.4047, 10);
      expect(open.contributionPercent).toBeCloseTo(-0.019858, 10);
      // Already a percent upstream. Multiplying it would read as a 462% coupon,
      // which is exactly the shape of the floater bug shipped in #125.
      expect(open.couponPercent).toBe(4.625);
   });

   /**
    * Would catch: the two dates swapped. They are both ISO strings a few weeks
    * apart, so nothing about the types or the rendering distinguishes them —
    * only that the rebalance precedes the as-of date.
    */
   test("the rebalance opens the period and the as-of date prices it", () => {
      const open = ZOpenConstituent.parse({
         ...rawColumns,
         as_of_date: "2026-09-23",
         rebalance_date: "2026-08-31",
      });
      expect(open.rebalanceDate).toBe("2026-08-31");
      expect(open.asOfDate).toBe("2026-09-23");
      expect(open.rebalanceDate < open.asOfDate).toBe(true);
   });
});

describe("the open envelope", () => {
   const reply = {
      as_of_date: "2026-09-23",
      basis: "total return, month to date since rebalance_date",
      code: "broad",
      constituents: [
         {
            ...rawColumns,
            as_of_date: "2026-09-23",
            cusip: "912810TM0",
            rebalance_date: "2026-08-31",
            weight: 0.001,
         },
         {
            ...rawColumns,
            as_of_date: "2026-09-23",
            rebalance_date: "2026-08-31",
            weight: 0.008256,
         },
         {
            ...rawColumns,
            as_of_date: "2026-09-23",
            cusip: "91282CKQ3",
            rebalance_date: "2026-08-31",
            weight: 0.004,
         },
      ],
      // Upstream sends this. It must not survive the boundary — see below.
      holdings: 299,
      rebalance_date: "2026-08-31",
   };

   test("rows come back heaviest first", () => {
      const parsed = ZOpenConstituents.parse(reply);
      expect(parsed.rows.map((row) => row.cusip)).toEqual([
         "91282CMM0",
         "91282CKQ3",
         "912810TM0",
      ]);
   });

   /**
    * ⚠️ THE COUNT UPSTREAM SENDS IS DROPPED ON PURPOSE, and this is the test
    * that has to outlive the reason.
    *
    * The payload carries `holdings: 299` beside a `constituents` array. Those
    * are the same fact computed on two sides of a network call, and a page that
    * renders one while listing the other can show a count that does not match
    * its own list — which is precisely what put 298 and 299 on this page under
    * one date and took three rounds to unpick. Here the reply claims 299 and
    * carries three rows; nothing downstream may be able to say 299.
    */
   test("the upstream count does not cross the boundary", () => {
      const parsed = ZOpenConstituents.parse(reply);
      expect(Object.keys(parsed)).not.toContain("holdings");
      expect(parsed.rows.length).toBe(3);
      expect(JSON.stringify(parsed)).not.toContain("299");
   });

   test("both dates are carried on the envelope, not just one", () => {
      const parsed = ZOpenConstituents.parse(reply);
      expect(parsed.rebalanceDate).toBe("2026-08-31");
      expect(parsed.asOfDate).toBe("2026-09-23");
   });
});

/**
 * ⚠️ THE STATE THAT MADE THE PROSE STALE, pinned so it cannot recur silently.
 *
 * Two pages carry a paragraph for an index that publishes levels and no
 * holdings. Both said "the other nine" — correct until 2026-09-10, when TIPS
 * and FRN were published and the list beneath them grew to eleven. The
 * sentences stayed wrong for seventeen days, and nothing could have caught it:
 * no index lacks holdings, so neither paragraph renders, so no page, no
 * typecheck and no screenshot could disagree with it.
 *
 * Unreachable prose is the one thing review does not cover. The counts are now
 * read from the list, and this test pins the condition that hid the drift.
 */
describe("which indices publish holdings", () => {
   test("every index publishes constituents, so the absence prose is unreachable", () => {
      const missing = INDEX_DISPLAY_ORDER.filter(
         (code) => !hasConstituents(code),
      );
      expect(missing).toEqual([]);
   });

   /**
    * If the test above ever fails, this is the one that says what to do: an
    * index has arrived without holdings, both paragraphs are now reachable, and
    * they must name a count that matches the list rather than a typed-in number.
    */
   test("the count those paragraphs render comes from the list", () => {
      expect(INDICES_WITH_CONSTITUENTS.length).toBe(INDEX_DISPLAY_ORDER.length);
      // Nothing outside the eleven, which would make the rendered count exceed
      // the number of indices that exist.
      for (const code of INDICES_WITH_CONSTITUENTS) {
         expect(INDEX_DISPLAY_ORDER).toContain(code);
      }
   });
});
