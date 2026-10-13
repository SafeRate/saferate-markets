import { describe, expect, test } from "bun:test";
import {
	editionOf,
	movedEditionFor,
	priceDateFor,
	weekEndFor,
} from "../app/services/dailyRundown.server";

/** A rundown is dated by the morning it goes out; its page finds the close. */

// Columbus Day (10-12) has no close.
const fitted = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-13"];
const env = {
	TREASURY: {
		parYieldSeries: async ({ from, to }: { from: string; to: string }) =>
			fitted
				.filter((d) => d >= from && d <= to)
				.map((date) => ({ date, tenor_years: 10, par_yield: 5 })),
	},
} as never;

describe("the rundown's edition date", () => {
	test("is the next business day after the close, holidays skipped", () => {
		expect(editionOf("2026-10-08")).toBe("2026-10-09"); // Thu → Fri
		// Fri → Tue: Columbus Day. Friday's prices went out Tuesday morning.
		expect(editionOf("2026-10-09")).toBe("2026-10-13");
		expect(editionOf("2026-11-10")).toBe("2026-11-12"); // Veterans Day
		expect(editionOf("2026-12-24")).toBe("2026-12-28"); // Christmas, Fri
	});

	test("maps back to the close it covers, and to none on a weekend", async () => {
		expect(await priceDateFor(env, "2026-10-09")).toBe("2026-10-08");
		expect(await priceDateFor(env, "2026-10-13")).toBe("2026-10-09");
		expect(await priceDateFor(env, "2026-10-14")).toBe("2026-10-13");
		expect(await priceDateFor(env, "2026-10-10")).toBeNull(); // Saturday
		expect(await priceDateFor(env, "2026-10-12")).toBeNull(); // holiday
		expect(await priceDateFor(env, "2026-10-15")).toBeNull(); // 10-14 not fitted
	});
});

describe("an edition dated before holidays were skipped", () => {
	test("moves to the business day its close is dated now", async () => {
		// Tuesday's email linked /2026-10-12; that close is now 10-13's.
		expect(await movedEditionFor(env, "2026-10-12")).toBe("2026-10-13");
		expect(await movedEditionFor(env, "2026-10-13")).toBeNull(); // not a holiday
		expect(await movedEditionFor(env, "2026-10-10")).toBeNull(); // Saturday
	});
});

describe("the week a rundown looks ahead to", () => {
	test("ends on this Friday, or next Friday in a Friday edition", () => {
		expect(weekEndFor("2026-10-12")).toBe("2026-10-16"); // Mon
		expect(weekEndFor("2026-10-15")).toBe("2026-10-16"); // Thu
		expect(weekEndFor("2026-10-16")).toBe("2026-10-23"); // Fri → next week
	});
});
