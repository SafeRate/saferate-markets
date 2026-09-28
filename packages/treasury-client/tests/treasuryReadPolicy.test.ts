import { describe, expect, test } from "bun:test";
import {
   isTreasuryRefusal,
   treasuryRead,
   treasuryRefusalCode,
   treasuryRefusalMessage,
} from "@saferate/treasury-client/client";

// The retry policy for the TREASURY service binding, which no page can exercise
// today: every argument this app sends upstream is zod-validated before the
// call, so a refusal is unreachable until the savings-bond pages land. Tested
// synthetically because getting it wrong is invisible and expensive — a
// deterministic refusal served as a 503 tells a crawler to come back for a page
// that can never work.
//
// HOW THE CODE ACTUALLY ARRIVES, measured against the deployed worker on
// 2026-09-09. Upstream throws TreasuryServiceError with name "no_valuation";
// what reaches this isolate is a plain Error with name "Error" and the code
// folded onto the FRONT OF THE MESSAGE:
//
//   Error: no_valuation: no answer for that pair of dates…
//
// So neither `error.code` nor `error.name` carries it. The `asRpcArrives`
// helper below is the real shape, and the tests using it are the ones that were
// failing in the browser while every name-based test passed.

/** A refusal as it would look if `name` survived. Kept: it still must work. */
const refusal = (name: string) => {
   const error = new Error(`upstream refused: ${name}`);
   error.name = name;
   return error;
};

/** A refusal as Workers RPC ACTUALLY delivers it. Name lost, code prefixed. */
const asRpcArrives = (code: string, text: string) =>
   new Error(`${code}: ${text}`);

/**
 * ⚠️ AND THE SHAPE MOVED AGAIN. Re-measured 2026-09-17 against
 * treasury-api-staging, from the MCP worker, calling eeBond for a 1994 bond:
 *
 *   name    "Error"
 *   message "no answer for that pair of dates. An EE bond issued before May…"
 *   stack   "no_valuation: no answer for that pair of dates…"
 *
 * The code is no longer on the front of the MESSAGE, as `asRpcArrives` above
 * records it — it is only on the front of the STACK.
 *
 * ⚠️ AND THE TRIGGER IS THIS WORKER'S OWN `compatibility_date`, proven by
 * deploying one worker against one upstream twice and changing only that:
 *
 *   2025-04-04  message "no_valuation: …"   <- what THIS app gets today
 *   2026-05-07  message "no answer …"       <- stack-only
 *
 * So both helpers below are live shapes, not an old one and a new one. This app
 * sits on 2025-04-04, so `asRpcArrives` is what it actually receives and its
 * treasury pages work. THE DAY SOMEONE BUMPS THIS APP'S COMPATIBILITY DATE it
 * silently starts receiving the other shape instead, and without the stack
 * branch in treasuryRefusalCode every refusal page becomes a 503. That bump is
 * ordinary housekeeping and nobody would think to re-test savings bonds after
 * it, which is exactly why both shapes are pinned here.
 *
 * The cost of missing it: the refusal is retried and then served as a 503, so
 * "this bond predates the rate tables" becomes "come back later" — on a page
 * that can never work.
 */
const asRpcArrivesStackOnly = (code: string, text: string) => {
   const error = new Error(text);
   error.stack = `${code}: ${text}\n    at TreasuryService.eeBond (index.js:31572:13)`;
   return error;
};

describe("isTreasuryRefusal", () => {
   test("recognises all six upstream refusal codes", () => {
      for (const name of [
         "bad_date",
         "bad_limit",
         "bad_principal",
         "bad_range",
         "no_valuation",
         "unknown_family",
      ]) {
         expect(isTreasuryRefusal(refusal(name))).toBe(true);
      }
   });

   test("recognises a refusal carried only in the stack", () => {
      // The live shape as of 2026-09-17. Before the stack fallback existed this
      // returned false and the refusal became a retried 503.
      const error = asRpcArrivesStackOnly(
         "no_valuation",
         "no answer for that pair of dates. An EE bond issued before May 1995 is outside the rate tables, or the valuation precedes the purchase.",
      );
      expect(isTreasuryRefusal(error)).toBe(true);
      expect(treasuryRefusalCode(error)).toBe("no_valuation");
      // The message is already reader-facing in this shape — nothing to strip.
      expect(treasuryRefusalMessage(error)).toBe(
         "no answer for that pair of dates. An EE bond issued before May 1995 is outside the rate tables, or the valuation precedes the purchase.",
      );
   });

   test("recognises every refusal code in the stack-only shape", () => {
      for (const code of [
         "bad_date",
         "bad_limit",
         "bad_principal",
         "bad_range",
         "no_valuation",
         "unknown_family",
         "unknown_index",
      ]) {
         expect(isTreasuryRefusal(asRpcArrivesStackOnly(code, "why"))).toBe(
            true,
         );
      }
   });

   test("does not mistake a stack mentioning a code for a refusal", () => {
      // The prefix is anchored, so a code appearing further down a stack — in a
      // function name, say — must not promote a transport failure to a refusal.
      const error = new Error("Network connection lost");
      error.stack =
         "Error: Network connection lost\n    at no_valuation (index.js:1:1)";
      expect(isTreasuryRefusal(error)).toBe(false);
   });

   test("treats an ordinary failure as retryable, not as a refusal", () => {
      expect(isTreasuryRefusal(new Error("Network connection lost"))).toBe(
         false,
      );
      expect(isTreasuryRefusal(new Error("D1_ERROR: overloaded"))).toBe(false);
      // A cold-starting or missing upstream worker — the local-dev case.
      expect(
         isTreasuryRefusal(new Error('Worker "treasury-api" not found')),
      ).toBe(false);
   });

   test("recognises a refusal in the shape RPC ACTUALLY delivers", () => {
      // The regression this exists for: name is "Error", so a name-only check
      // classified this as a transport failure, retried it, and served a 503 for
      // a bond that can never be valued.
      const arrived = asRpcArrives(
         "no_valuation",
         "no answer for that pair of dates. An EE bond issued before May 1995 is outside the rate tables.",
      );

      expect(arrived.name).toBe("Error");
      expect(isTreasuryRefusal(arrived)).toBe(true);
      expect(treasuryRefusalCode(arrived)).toBe("no_valuation");
   });

   test("strips the code prefix from the reader-facing message", () => {
      const arrived = asRpcArrives(
         "bad_principal",
         "principal must be positive.",
      );

      // The reader sees the sentence, not "bad_principal: the sentence".
      expect(treasuryRefusalMessage(arrived)).toBe(
         "principal must be positive.",
      );
      expect(treasuryRefusalMessage(arrived)).not.toContain("bad_principal");
   });

   test("recognises every code in the delivered shape, not just one", () => {
      // Must match `TServiceErrorCode` upstream. `unknown_index` was added with
      // the index methods without announcement; a code missing from the local
      // list silently becomes a retried 503 rather than failing loudly, so this
      // list is worth re-checking whenever upstream adds methods.
      for (const code of [
         "bad_date",
         "bad_limit",
         "bad_principal",
         "bad_range",
         "no_valuation",
         "unknown_family",
         "unknown_index",
      ]) {
         expect(treasuryRefusalCode(asRpcArrives(code, "because."))).toBe(code);
      }
   });

   test("a code-like word MID-message is not a refusal", () => {
      // The prefix is anchored, so prose that merely mentions a code — an
      // upstream stack trace, say — is still treated as a transport failure.
      const notRefusal = new Error(
         "connection reset while handling no_valuation: retrying",
      );
      expect(isTreasuryRefusal(notRefusal)).toBe(false);
   });

   test("does not key off a `code` property, which RPC drops", () => {
      // This is the trap the upstream author warned about: an error carrying
      // the code ONLY as an own property arrives with name "Error".
      const withCodeOnly = Object.assign(new Error("nope"), {
         code: "no_valuation",
      });

      expect(isTreasuryRefusal(withCodeOnly)).toBe(false);
      expect(treasuryRefusalCode(withCodeOnly)).toBeNull();
   });

   test("is not fooled by a non-Error carrying a matching name", () => {
      expect(isTreasuryRefusal({ name: "bad_date" })).toBe(false);
      expect(isTreasuryRefusal("bad_date")).toBe(false);
      expect(isTreasuryRefusal(null)).toBe(false);
   });
});

describe("treasuryRead", () => {
   test("returns the value without retrying when the call succeeds", async () => {
      let attempts = 0;
      const result = await treasuryRead(async () => {
         attempts += 1;
         return "curve";
      }, "test");

      expect(result).toBe("curve");
      expect(attempts).toBe(1);
   });

   test("retries a transport failure once and then succeeds", async () => {
      let attempts = 0;
      const result = await treasuryRead(async () => {
         attempts += 1;
         if (attempts === 1) throw new Error("Network connection lost");
         return "curve";
      }, "test");

      expect(result).toBe("curve");
      expect(attempts).toBe(2);
   });

   test("a persistent transport failure becomes a 503, not a 500", async () => {
      let attempts = 0;
      const thrown = await treasuryRead(async () => {
         attempts += 1;
         throw new Error("D1_ERROR: overloaded");
      }, "test").catch((error: unknown) => error);

      // 503 tells a crawler to come back; 500 tells it the page is broken.
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(503);
      expect(attempts).toBe(2);
   });

   test("a refusal is re-thrown untouched and NEVER retried", async () => {
      let attempts = 0;
      const thrown = await treasuryRead(async () => {
         attempts += 1;
         throw asRpcArrives(
            "no_valuation",
            "no answer for that pair of dates.",
         );
      }, "test").catch((error: unknown) => error);

      // The original Error, so the call site can map it to a 422 rather than
      // having it flattened into "the upstream did not answer".
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(Response);
      expect(treasuryRefusalCode(thrown)).toBe("no_valuation");
      expect(attempts).toBe(1);
   });

   test("a refusal on the retry is also re-thrown rather than becoming a 503", async () => {
      // Transport failure first, refusal second. Contrived, but it is the branch
      // where a missing check would silently convert a 422 into a 503.
      let attempts = 0;
      const thrown = await treasuryRead(async () => {
         attempts += 1;
         if (attempts === 1) throw new Error("Network connection lost");
         throw asRpcArrives("bad_principal", "principal must be positive.");
      }, "test").catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(Response);
      expect(treasuryRefusalCode(thrown)).toBe("bad_principal");
      expect(attempts).toBe(2);
   });
});

describe("treasuryRead and a method the deployed worker lacks", () => {
   // How a REAL binding reports it (measured 2026-09-28): the call throws this.
   const missing = () =>
      new TypeError(
         'The RPC receiver does not implement the method "indexReturns".',
      );

   test("is rethrown at once, not retried and not turned into a 503", async () => {
      let calls = 0;
      const read = treasuryRead(async () => {
         calls += 1;
         throw missing();
      }, "probe");
      await expect(read).rejects.toBeInstanceOf(TypeError);
      expect(calls).toBe(1);
   });

   test("an ordinary TypeError is still an outage", async () => {
      const read = treasuryRead(async () => {
         throw new TypeError("Cannot read properties of undefined");
      }, "probe");
      await expect(read).rejects.toBeInstanceOf(Response);
   });
});
