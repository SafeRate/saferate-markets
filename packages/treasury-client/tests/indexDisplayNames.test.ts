import { describe, expect, test } from "bun:test";
import {
   INDEX_DISPLAY_ORDER,
   INDEX_META,
   indexCitableName,
   indexDisplayName,
   indexFormerTicker,
} from "@saferate/treasury-client/types";

/**
 * ⚠️ THE TEST THAT WOULD HAVE CAUGHT IT. On 2026-09-26 "Total Return" was added
 * to the index names by collapsing any name already starting with "US Treasury"
 * to a fixed suffix. Two names start that way and they are different indices —
 * `broad` is "US Treasury Index" and AGG is "US Treasury Aggregate" — so both
 * published as "Safe Rate US Treasury Total Return Index". One name, two
 * indices, in page titles, citations, schema.org Dataset nodes and the header
 * of every downloaded CSV.
 *
 * It reached production because every surface rendered something plausible.
 * Nothing 404ed, nothing threw, and each page in isolation looked right — the
 * defect is only visible when two names are compared, which no page does and
 * no typecheck can.
 */

describe("index display names", () => {
   test("no two indices share a display name", () => {
      const byName = new Map<string, string[]>();
      for (const code of INDEX_DISPLAY_ORDER) {
         const name = indexDisplayName(code);
         byName.set(name, [...(byName.get(name) ?? []), code]);
      }
      const collisions = [...byName.entries()].filter(
         ([, codes]) => codes.length > 1,
      );
      expect(collisions).toEqual([]);
   });

   test("no two indices share a citable name", () => {
      const names = INDEX_DISPLAY_ORDER.map(indexCitableName);
      expect(new Set(names).size).toBe(names.length);
   });

   test("every name says total return", () => {
      for (const code of INDEX_DISPLAY_ORDER) {
         expect(indexDisplayName(code)).toContain("Total Return");
      }
   });

   /**
    * ⚠️ THIS TEST PREVIOUSLY PINNED AN INCONSISTENCY AND NOW ASSERTS ITS ABSENCE.
    * Six tickers said TR and five did not, while all eleven are total return
    * indices. It was pinned rather than asserted, so that changing it would be
    * deliberate — and when the five were renamed on 2026-09-26 this test failed,
    * which is the whole reason to pin a known-wrong state instead of ignoring it.
    */
   test("every ticker says TR, because every index is total return", () => {
      for (const code of INDEX_DISPLAY_ORDER) {
         expect(INDEX_META[code].ticker.startsWith("SR-UST-TR")).toBe(true);
      }
   });

   /**
    * A RENAME IS NOT A REMOVAL. The five instrument-family tickers were
    * published, crawled and listed in llms-treasury.txt under their old names,
    * so a citation carrying one has to keep resolving. The former string is
    * retained and emitted as a second schema.org identifier; dropping it is a
    * decision for when the old form has stopped appearing, which cannot be known
    * from here.
    */
   test("every renamed index still declares what it was called", () => {
      const renamed = ["AGG", "BILL", "FRN", "SHRT", "TIPS"] as const;
      for (const code of renamed) {
         const former = indexFormerTicker(code);
         expect(former).toBeDefined();
         expect(former).toBe(`SR-UST-${code}`);
         // The new name must actually differ from the old, or the alias is noise.
         expect(former).not.toBe(INDEX_META[code].ticker);
      }
      // And the six that never changed must NOT claim a former name.
      for (const code of INDEX_DISPLAY_ORDER) {
         if ((renamed as readonly string[]).includes(code)) continue;
         expect(indexFormerTicker(code)).toBeUndefined();
      }
   });

   /**
    * ⚠️ A RETIRED TICKER IS NEVER REASSIGNED, and this is the test that has to
    * outlive everyone who remembers why.
    *
    * When a price-return family arrives it takes SR-UST-PR-AGG. It must NOT
    * take the bare SR-UST-AGG, even though that string is now free, because an
    * old citation of SR-UST-AGG would then resolve — silently, with no error
    * anywhere — to a series whose returns exclude coupons. At the long end that
    * is several percent a year.
    *
    * A citation that fails to resolve is a broken link somebody notices. A
    * citation that resolves to the wrong series is a wrong number nobody
    * notices. This asserts the second can never happen by accident.
    */
   test("no current ticker reuses a retired one", () => {
      const retired = new Set(
         INDEX_DISPLAY_ORDER.map(indexFormerTicker).filter(
            (ticker): ticker is string => ticker !== undefined,
         ),
      );
      expect(retired.size).toBe(5);
      for (const code of INDEX_DISPLAY_ORDER) {
         expect(retired.has(INDEX_META[code].ticker)).toBe(false);
      }
   });

   /**
    * Only names that were ACTUALLY PUBLISHED AND RETIRED may claim to have been.
    * The broad index and all five maturity bands were always SR-UST-TR*; bare
    * SR-UST and SR-UST-0103 never named anything. Publishing an alias for those
    * would assert a history that did not happen and invite citations to strings
    * that never existed — the mirror of the reassignment risk above.
    */
   test("only the five instrument families were ever renamed", () => {
      const claiming = INDEX_DISPLAY_ORDER.filter(
         (code) => indexFormerTicker(code) !== undefined,
      );
      expect([...claiming].sort()).toEqual(
         ["AGG", "BILL", "FRN", "SHRT", "TIPS"].sort() as typeof claiming,
      );
   });

   test("every name still contains what distinguishes the index", () => {
      // The collision above was a DROPPED WORD, not a duplicated one, so
      // uniqueness alone would not have described the bug. AGG must keep
      // "Aggregate" whatever else changes around it.
      for (const code of INDEX_DISPLAY_ORDER) {
         const distinguishing = INDEX_META[code].name.replace(/ Index$/, "");
         expect(indexDisplayName(code)).toContain(distinguishing);
      }
   });

   test("names are prefixed with the owner", () => {
      for (const code of INDEX_DISPLAY_ORDER) {
         expect(indexDisplayName(code).startsWith("Safe Rate ")).toBe(true);
      }
   });
});
