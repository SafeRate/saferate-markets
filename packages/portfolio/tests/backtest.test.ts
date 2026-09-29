import { describe, expect, test } from "bun:test";
import {
	rebalanceSchedule,
	runBacktest,
	slotsFor,
	type TBacktestData,
} from "../src/backtest";
import { LOT_PRESETS } from "../src/builder";
import { isBusinessDay, toDate, toIso } from "../src/dates";
import type { TSecurityTerms } from "../src/ledger";

/**
 * A synthetic market where the answer is known: 4% notes maturing every
 * 15 May from 2025 to 2056, priced at par every day, and cash earning 4%.
 * Whatever a strategy holds, it earns 4% a year, so a backtest that returns
 * anything else has lost or invented money. A second market drops every price
 * 10% on one day, which must show as a drawdown.
 */

const days = (from: string, to: string) => {
	const out: string[] = [];
	for (let d = toDate(from); toIso(d) <= to; d.setUTCDate(d.getUTCDate() + 1))
		if (isBusinessDay(d)) out.push(toIso(d));
	return out;
};
const START = "2024-01-02";
const END = "2026-09-28";
const calendar = days(START, END);
const notes: TSecurityTerms[] = Array.from({ length: 32 }, (_, i) => ({
	cusip: `91282C${String(100 + i)}`,
	family: "note",
	couponRate: 0.04,
	maturityDate: `${2025 + i}-05-15`,
	frequency: 2,
}));

const market = (priceOn: (date: string) => number): TBacktestData => ({
	calendar,
	cashRate: () => 0.04,
	universeOn: async (date) => {
		const day = calendar.find((d) => d >= date);
		if (day === undefined) return null;
		return {
			date: day,
			securities: notes
				.filter((n) => n.maturityDate > day)
				.map((n) => ({
					cusip: n.cusip,
					family: "note" as const,
					couponPercent: 4,
					maturityDate: n.maturityDate,
					price: priceOn(day),
				})),
		};
	},
	securities: async (cusips) => ({
		terms: new Map(
			notes.filter((n) => cusips.includes(n.cusip)).map((n) => [n.cusip, n]),
		),
		marks: new Map(
			cusips.map((c) => [
				c,
				calendar.map((date) => ({ date, close: priceOn(date) })),
			]),
		),
	}),
});

const run = (
	data: TBacktestData,
	over: Partial<Parameters<typeof runBacktest>[0]> = {},
) =>
	runBacktest({
		strategy: "ladder",
		horizonYears: 10,
		start: START,
		end: END,
		frequency: "annual",
		initial: 1_000_000,
		costPer100: 0,
		lots: LOT_PRESETS.retail,
		data,
		...over,
	});

describe("the schedule", () => {
	test("starts on the start date, then the first of each period", () => {
		expect(rebalanceSchedule("2024-01-17", "2024-12-31", "quarterly")).toEqual([
			"2024-01-17",
			"2024-04-01",
			"2024-07-01",
			"2024-10-01",
		]);
	});
});

describe("at par with cash at 4%", () => {
	test("a ladder earns 4% a year, with no money added and no drawdown", async () => {
		const r = await run(market(() => 100));
		if (!r.ok) throw new Error(r.message);
		expect(r.annualised).toBeGreaterThan(0.038);
		expect(r.annualised).toBeLessThan(0.042);
		expect(Math.abs(r.externalCash)).toBeLessThan(1);
		expect(r.maxDrawdown).toBeGreaterThan(-0.001);
		expect(r.rebalances.length).toBe(3);
		expect(r.rebalances[0].held).toBe(10);
	});

	for (const frequency of ["monthly", "quarterly"] as const)
		test(`rebalanced ${frequency}, still 4% and self-financing`, async () => {
			const r = await run(
				market(() => 100),
				{ frequency, strategy: "intermediate" },
			);
			if (!r.ok) throw new Error(r.message);
			expect(r.annualised).toBeGreaterThan(0.038);
			expect(r.annualised).toBeLessThan(0.042);
			expect(Math.abs(r.externalCash)).toBeLessThan(1);
		});

	test("a trading cost comes off the return", async () => {
		const free = await run(
			market(() => 100),
			{ frequency: "quarterly" },
		);
		const costly = await run(
			market(() => 100),
			{
				frequency: "quarterly",
				costPer100: 1 / 32,
			},
		);
		if (!free.ok || !costly.ok) throw new Error("no result");
		expect(costly.cumulative).toBeLessThan(free.cumulative);
		expect(Math.abs(costly.externalCash)).toBeLessThan(1);
	});
});

test("a template the market cannot fill says so", async () => {
	// The barbell wants bills and bonds; this market has neither.
	const r = await run(
		market(() => 100),
		{ strategy: "barbell" },
	);
	expect(r.ok).toBe(false);
});

describe("a 10% fall on one day", () => {
	test("shows as a drawdown of about the fall, and the book is still self-financing", async () => {
		const r = await run(market((d) => (d >= "2025-06-02" ? 90 : 100)));
		if (!r.ok) throw new Error(r.message);
		expect(r.maxDrawdown).toBeLessThan(-0.08);
		expect(r.maxDrawdown).toBeGreaterThan(-0.11);
		expect(Math.abs(r.externalCash)).toBeLessThan(1);
	});
});

describe("managed by slots", () => {
	test("a ladder holds to maturity: turnover stays low when nothing moves", async () => {
		// Rebuilt from scratch every quarter, the first version turned real
		// ladders over 400% a year: "one year from now" names a new bond each
		// quarter. Held to maturity, it only buys the rung that matured.
		const r = await run(
			market(() => 100),
			{ frequency: "quarterly" },
		);
		if (!r.ok) throw new Error(r.message);
		expect(r.turnover ?? 1).toBeLessThan(0.15);
	});

	test("slot bounds: hold to maturity for a ladder, sell below the sector for long", () => {
		const ladder = slotsFor("ladder", 10, null);
		expect(ladder[0].lo).toBe(0);
		expect(ladder[0].hi).toBeCloseTo(1.5, 9);
		expect(ladder.at(-1)?.hi).toBeCloseTo(10.5, 9);
		const long = slotsFor("long", 10, null);
		expect(long[0].lo).toBeCloseTo(9.5, 9);
		const barbell = slotsFor("barbell", 10, null);
		const bills = barbell.filter((s) => s.families.includes("bill"));
		const bonds = barbell.filter((s) => s.families.includes("bond"));
		expect(bills[0].lo).toBe(0);
		expect(bonds[0].lo).toBeCloseTo(19.5, 9);
	});

	test("a bullet's rungs are fixed dates: past ones drop out", () => {
		expect(slotsFor("bullet", 10, [9.5, 10, 10.5]).length).toBe(3);
		expect(slotsFor("bullet", 10, [-0.2, 0.3, 0.8]).length).toBe(2);
	});
});
