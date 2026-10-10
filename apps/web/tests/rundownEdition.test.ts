import { describe, expect, test } from "bun:test";
import { editionOf, priceDateFor } from "../app/services/dailyRundown.server";

/** A rundown is dated by the morning it goes out; its page finds the close. */

const fitted = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"];
const env = {
	TREASURY: {
		parYieldSeries: async ({ from, to }: { from: string; to: string }) =>
			fitted
				.filter((d) => d >= from && d <= to)
				.map((date) => ({ date, tenor_years: 10, par_yield: 5 })),
	},
} as never;

describe("the rundown's edition date", () => {
	test("is the next weekday after the close, holidays included", () => {
		expect(editionOf("2026-10-08")).toBe("2026-10-09"); // Thu → Fri
		expect(editionOf("2026-10-09")).toBe("2026-10-12"); // Fri → Mon (Columbus Day)
	});

	test("maps back to the close it covers, and to none on a weekend", async () => {
		expect(await priceDateFor(env, "2026-10-09")).toBe("2026-10-08");
		expect(await priceDateFor(env, "2026-10-12")).toBe("2026-10-09");
		expect(await priceDateFor(env, "2026-10-10")).toBeNull(); // Saturday
		expect(await priceDateFor(env, "2026-10-14")).toBeNull(); // 10-13 not fitted
	});
});
