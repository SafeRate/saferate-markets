import { describe, expect, test } from "bun:test";
import {
   openHoldingsNotice,
   ZOpenConstituentsStatus,
} from "@saferate/treasury-client/types";

/**
 * ⚠️ THE SUPERSEDED BRANCH CANNOT REACH PRODUCTION DATA BEFORE IT MATTERS.
 *
 * Nothing has superseded anything: the snapshot is held at 2026-08-31 and the
 * newest published month-end is 2026-08-31. The state first becomes reachable
 * when September closes on 2026-09-30, which is the morning it has to be right.
 * A path whose first execution is the morning it is needed is not shipped, it
 * is hoped for — the argument this repo made for the cross-repo ticker check,
 * applied to its own rendering.
 *
 * So the branch is executed here instead, for every state including the one
 * that is supposed to be impossible.
 */

const parse = (reply: unknown) => ZOpenConstituentsStatus.parse(reply);

describe("reading the status reply", () => {
   test("the three live shapes, verified against production 2026-09-28", () => {
      // Copied from the deployed endpoint, not invented.
      expect(
         parse({ held: "2026-08-31", state: "current", supersededBy: null }),
      ).toEqual({ held: "2026-08-31", state: "current", supersededBy: null });
      expect(
         parse({ held: null, state: "never-written", supersededBy: null }),
      ).toEqual({ held: null, state: "never-written", supersededBy: null });
   });

   /**
    * ⚠️ RPC SENDS NO `state`. The HTTP route returns it; the RPC method returns
    * `held` and `supersededBy` only, and the consumer reads over RPC. If the
    * derivation were wrong, every page would take the HTTP-shaped path in tests
    * and the RPC-shaped one in production.
    */
   test("state is derived when upstream omits it, by upstream's own rule", () => {
      expect(parse({ held: "2026-08-31", supersededBy: null }).state).toBe(
         "current",
      );
      expect(
         parse({ held: "2026-08-31", supersededBy: "2026-09-30" }).state,
      ).toBe("superseded");
      expect(parse({ held: null, supersededBy: null }).state).toBe(
         "never-written",
      );
   });

   test("a sent state wins over the derived one", () => {
      // If upstream's rule and ours ever diverge, upstream's is the contract.
      expect(
         parse({ held: "2026-08-31", state: "superseded", supersededBy: null })
            .state,
      ).toBe("superseded");
   });
});

describe("which sentence the fallback carries", () => {
   /**
    * THE FAILURE THIS WHOLE EXCHANGE IS ABOUT. A superseded snapshot rendered
    * with the never-written sentence is a page that reads as completely healthy
    * while showing the wrong month's holdings to someone deciding whether to
    * benchmark against us.
    */
   test("superseded never borrows the never-written sentence", () => {
      const notice = openHoldingsNotice(
         parse({ held: "2026-08-31", supersededBy: "2026-09-30" }),
      );
      expect(notice).toBe("superseded");
      expect(notice).not.toBe("never-written");
   });

   test("never written keeps the sentence the page always had", () => {
      expect(
         openHoldingsNotice(parse({ held: null, supersededBy: null })),
      ).toBe("never-written");
   });

   /**
    * ⚠️ "CURRENT" ALONGSIDE NO SNAPSHOT IS A DEFECT, and must not be rendered
    * as an ordinary cold start. The producer's coverage guard is meant to make
    * it impossible; so was every other thing on this page that happened anyway.
    */
   test("live-but-absent gets its own words, not the cold-start ones", () => {
      expect(
         openHoldingsNotice(parse({ held: "2026-08-31", supersededBy: null })),
      ).toBe("unread");
   });

   /**
    * Upstream contradicting itself: superseded, but not saying by what. Still
    * not a cold start, so it must not read as one — and the superseded copy
    * names a date it would not have.
    */
   test("superseded without a superseding date falls to unread, not never-written", () => {
      expect(
         openHoldingsNotice(parse({ held: "2026-08-31", state: "superseded" })),
      ).toBe("unread");
   });

   /**
    * Upstream cannot answer — method not deployed, or the call failed. The
    * honest sentence is the one the page carried before any of this existed,
    * and this is the state on every deploy until upstream ships the method.
    */
   test("no status at all keeps the original sentence", () => {
      expect(openHoldingsNotice(null)).toBe("never-written");
   });

   /** All three outcomes are reachable, or a branch is dead and untested. */
   test("every notice is produced by some real reply", () => {
      const produced = new Set(
         [
            null,
            parse({ held: null, supersededBy: null }),
            parse({ held: "2026-08-31", supersededBy: null }),
            parse({ held: "2026-08-31", supersededBy: "2026-09-30" }),
         ].map(openHoldingsNotice),
      );
      expect([...produced].sort()).toEqual([
         "never-written",
         "superseded",
         "unread",
      ]);
   });
});
