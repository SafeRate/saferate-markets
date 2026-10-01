import { describe, expect, test } from "bun:test";
import { explainNoOpenConstituents } from "../src/reads/indices";

const fakeTreasury = (methods: Record<string, unknown>) =>
	({ TREASURY: methods }) as never;

describe("explainNoOpenConstituents", () => {
	test("a superseded list says it is withheld, and when it rolls, not to wait for a run", async () => {
		const env = fakeTreasury({
			openConstituentsStatus: async () => ({
				state: "superseded",
				held: "2026-08-31",
				supersededBy: "2026-09-30",
			}),
		});
		const text = await explainNoOpenConstituents(env, "broad");
		expect(text).toContain("struck at the 2026-08-31 rebalance");
		expect(text).toContain("2026-09-30 rebalance has superseded");
		expect(text).not.toContain("written after each business day's run");
	});

	test("a list never written says the next run writes it", async () => {
		const env = fakeTreasury({
			openConstituentsStatus: async () => ({
				state: "never-written",
				held: null,
				supersededBy: null,
			}),
		});
		expect(await explainNoOpenConstituents(env, "BILL")).toContain(
			"has been written yet",
		);
	});

	test("an older treasury without the status call claims neither", async () => {
		const text = await explainNoOpenConstituents(fakeTreasury({}), "TIPS");
		expect(text).toBe(
			"The open-period list for TIPS is not available right now.",
		);
	});

	test("a status call that throws claims neither", async () => {
		const env = fakeTreasury({
			openConstituentsStatus: async () => {
				throw new Error("boom");
			},
		});
		expect(await explainNoOpenConstituents(env, "FRN")).toContain(
			"not available right now",
		);
	});
});
