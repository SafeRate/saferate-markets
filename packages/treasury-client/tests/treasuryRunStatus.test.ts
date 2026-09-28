import { describe, expect, test } from "bun:test";
import type { TTreasuryEnv } from "@saferate/treasury-client/client";
import { getRunStatusOn } from "@saferate/treasury-client/client";
import { runQueueSlug, ZRunStatus } from "@saferate/treasury-client/types";

// The four colliding pairs on 2026-09-01, verified against the store on
// 2026-09-10. Before the ranking was keyed on instrument kind, one of each pair
// was invisible — a ten-year TIPS auctioned after a ten-year note took the
// note's benchmark slot. These four pairs are the whole reason the page exists.
const COLLIDING = [
   { kind: "Note", term: "10-Year", cusip: "91282CRF0" },
   { kind: "TIPS", term: "10-Year", cusip: "91282CRE3" },
   { kind: "Note", term: "5-Year", cusip: "91282CRK9" },
   { kind: "TIPS", term: "5-Year", cusip: "91282CQP9" },
   { kind: "Bond", term: "30-Year", cusip: "912810UW6" },
   { kind: "TIPS", term: "30-Year", cusip: "912810US5" },
   { kind: "Note", term: "2-Year", cusip: "91282CRH6" },
   { kind: "FRN", term: "2-Year", cusip: "91282CRD5" },
] as const;

const row = (cusip: string, kind: string, term: string, runRank: number) => ({
   basis: "issue",
   cusip,
   date: "2026-09-01",
   original_security_term: term,
   run_rank: runRank,
   security_kind: kind,
});

const BENCHMARKS = COLLIDING.map((one) =>
   row(one.cusip, one.kind, one.term, 0),
);

const envReturning = (rows: unknown) =>
   ({ TREASURY: { runStatusOn: async () => rows } }) as unknown as TTreasuryEnv;

const call = (rows: unknown) =>
   getRunStatusOn({ date: "2026-09-01", env: envReturning(rows) });

describe("ZRunStatus", () => {
   test("rank 0 is on the run and nothing else is", () => {
      expect(
         ZRunStatus.parse(row("91282CRF0", "Note", "10-Year", 0)).isOnTheRun,
      ).toBe(true);
      expect(
         ZRunStatus.parse(row("91282CRF0", "Note", "10-Year", 1)).isOnTheRun,
      ).toBe(false);
   });

   test("refuses a rank past the tracked ceiling", () => {
      // MAX_TRACKED_RUN_RANK is 10, so eleven issues are tracked. A rank of 11
      // would mean the ceiling moved upstream and the page's "not tracked
      // beyond ten issues" copy had gone stale.
      expect(() =>
         ZRunStatus.parse(row("91282CRF0", "Note", "10-Year", 11)),
      ).toThrow();
   });

   test("refuses an unrecognised instrument kind", () => {
      // The five are exhaustive. A sixth would mean a new instrument exists and
      // the page needs a label for it, which should fail loudly rather than
      // render a blank cell.
      expect(() =>
         ZRunStatus.parse(row("91282CRF0", "STRIP", "10-Year", 0)),
      ).toThrow();
   });
});

describe("runQueueSlug", () => {
   test("builds the search-phrase slug, term first", () => {
      expect(runQueueSlug("Note", "10-Year")).toBe("10-year-note");
      expect(runQueueSlug("Bond", "30-Year")).toBe("30-year-bond");
      expect(runQueueSlug("TIPS", "5-Year")).toBe("5-year-tips");
      expect(runQueueSlug("Bill", "26-Week")).toBe("26-week-bill");
      expect(runQueueSlug("FRN", "2-Year")).toBe("2-year-frn");
   });

   test("a colliding pair gets two DISTINCT slugs", () => {
      // The whole point. One slug for both would make the linker unreachable,
      // which is the bug the kind-aware ranking fixed in the data.
      expect(runQueueSlug("Note", "10-Year")).not.toBe(
         runQueueSlug("TIPS", "10-Year"),
      );
   });

   test("handles a multi-word term", () => {
      expect(runQueueSlug("Bond", "29-Year 9-Month")).toBe(
         "29-year-9-month-bond",
      );
   });
});

describe("getRunStatusOn", () => {
   test("groups the eight benchmarks into eight separate queues", async () => {
      const result = await call(BENCHMARKS);

      // Four terms, two instruments each — eight queues, not four.
      expect(result?.queues).toHaveLength(8);
      const terms = new Set(
         result?.queues.map((queue) => queue[0].originalSecurityTerm),
      );
      expect(terms.size).toBe(4);
   });

   test("a term with two kinds does not lose one of them", async () => {
      const result = await call(BENCHMARKS);
      const tenYear = result?.queues.filter(
         (queue) => queue[0].originalSecurityTerm === "10-Year",
      );

      expect(tenYear).toHaveLength(2);
      expect(new Set(tenYear?.map((queue) => queue[0].securityKind))).toEqual(
         new Set(["Note", "TIPS"]),
      );
   });

   test("orders each queue by rank so index 0 is the benchmark", async () => {
      const result = await call([
         row("OLDEST0002", "Note", "10-Year", 2),
         row("BENCHMARK1", "Note", "10-Year", 0),
         row("SECOND0001", "Note", "10-Year", 1),
      ]);

      expect(result?.queues[0].map((member) => member.cusip)).toEqual([
         "BENCHMARK1",
         "SECOND0001",
         "OLDEST0002",
      ]);
   });

   test("drops a queue whose benchmark has aged out", async () => {
      // A queue with no rank 0 is not a queue. Upstream removes a term entirely
      // once nothing has been auctioned into it rather than keeping a stale
      // benchmark, so rendering ranks 1+ alone would imply a current benchmark
      // that does not exist.
      const result = await call([
         row("STALE00001", "Note", "17-Year", 1),
         row("STALE00002", "Note", "17-Year", 2),
         row("BENCHMARK1", "Note", "10-Year", 0),
      ]);

      expect(result?.queues).toHaveLength(1);
      expect(result?.queues[0][0].originalSecurityTerm).toBe("10-Year");
   });

   test("defaults to the issue basis, and says so", async () => {
      // Issue and auction dates differ by a few days and can reorder two
      // securities around a month boundary, so the page states which was used.
      const result = await call(BENCHMARKS);
      expect(result?.basis).toBe("issue");
   });

   test("no rows yields no queues rather than throwing", async () => {
      const result = await call([]);
      expect(result?.queues).toEqual([]);
   });

   test("a missing binding degrades to null", async () => {
      expect(
         await getRunStatusOn({
            date: "2026-09-01",
            env: {} as unknown as TTreasuryEnv,
         }),
      ).toBeNull();
   });
});
