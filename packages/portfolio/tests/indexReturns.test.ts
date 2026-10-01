import { describe, expect, test } from "bun:test";
import { fromBase, trailingReturns } from "../src/indexReturns";

/** A daily series from 2008-10-01 compounding 0.01% a day, struck from 100 on 2008-09-30. */
const days: string[] = [];
for (
	let d = new Date("2008-10-01T00:00:00Z");
	d <= new Date("2026-09-30T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + 1)
) {
	if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
		days.push(d.toISOString().slice(0, 10));
}
const daily = days.map((date, i) => {
	const level = 100 * 1.0001 ** (i + 1);
	return {
		date,
		level,
		rebalanceDate: "2008-09-30",
		returnSinceRebalancePercent: (level / 100 - 1) * 100,
	};
});

describe("index returns from daily levels", () => {
	test("the base is read off the first row and is 100", () => {
		const series = fromBase(daily);
		expect(series[0].date).toBe("2008-09-30");
		expect(series[0].level).toBeCloseTo(100, 9);
	});

	test("since inception chains from the base, not the first published day", () => {
		const r = trailingReturns(fromBase(daily));
		const inception = r?.periods.find((p) => p.key === "inception");
		expect(inception?.cumulative).toBeCloseTo(
			(daily.at(-1)?.level ?? 0) / 100 - 1,
			9,
		);
		// From the first row instead, a day's return would be missing.
		const fromFirstRow = trailingReturns(
			daily.map(({ date, level }) => ({ date, level })),
		);
		expect(
			fromFirstRow?.periods.find((p) => p.key === "inception")?.cumulative,
		).toBeLessThan(inception?.cumulative ?? 0);
	});

	test("periods end on the newest valuation and start at the last level on or before their start", () => {
		const r = trailingReturns(fromBase(daily));
		expect(r?.end).toBe("2026-09-30");
		const mtd = r?.periods.find((p) => p.key === "mtd");
		expect(mtd?.start).toBe("2026-08-31");
		const i31 = days.indexOf("2026-08-31");
		const iEnd = days.length - 1;
		expect(mtd?.cumulative).toBeCloseTo(1.0001 ** (iEnd - i31) - 1, 9);
	});

	test("a period longer than the series is null, not the series' return", () => {
		const young = fromBase(
			daily
				.filter((d) => d.date >= "2024-01-02")
				.map((d, i) => ({
					...d,
					level: 100 * 1.0001 ** (i + 1),
					rebalanceDate: "2023-12-29",
					returnSinceRebalancePercent: (1.0001 ** (i + 1) - 1) * 100,
				})),
		);
		const r = trailingReturns(young);
		expect(r?.periods.find((p) => p.key === "5y")?.cumulative).toBeNull();
		expect(r?.periods.find((p) => p.key === "1y")?.cumulative).not.toBeNull();
	});
});
