import { describe, expect, test } from "bun:test";
import frnRows from "../../../apps/api/tests/fixtures/securities/frn-frn-analytics.json";
import tipsRows from "../../../apps/api/tests/fixtures/securities/tips-tips-analytics.json";
import { settlementFor } from "../src/dates";
import {
	frnPricer,
	indexRatioAt,
	nominalPricer,
	tipsPricer,
} from "../src/pricers";

/**
 * The TIPS and FRN pricers held to PRODUCTION analytics rows: the 10-year TIPS
 * 91282CNS6 (1 7/8%, 15 Jul 2035) on 31 Jul, 1 Aug and 4 Aug 2025, and the
 * 2-year FRN 91282CPG0 (spread 0.19%, 31 Oct 2027) on its first three days.
 */

const TIPS = { couponRate: 0.01875, maturityDate: "2035-07-15", frequency: 2 };
const tips = tipsPricer(
	TIPS,
	tipsRows.map((r) => ({ date: r.date, indexRatio: r.index_ratio })),
);

describe("TIPS", () => {
	for (const row of tipsRows) {
		test(`dollars per 100 on ${row.date} = stored real dirty x stored ratio`, () => {
			expect(tips.dirty(row.real_clean_price, row.date)).toBeCloseTo(
				row.real_dirty_price * row.index_ratio,
				10,
			);
		});
		test(`accrued on ${row.date} is the stored real accrual x the ratio`, () => {
			expect(tips.accrued(settlementFor(row.date))).toBeCloseTo(
				row.accrued_real * row.index_ratio,
				12,
			);
		});
	}

	test("the ratio is linear within a month: a day between stored days is exact", () => {
		// Stored at settlements 1, 4 and 5 Aug; 2 Aug is a third of the way from 1 to 4.
		const at = indexRatioAt(
			tipsRows.map((r) => ({ date: settlementFor(r.date), ratio: r.index_ratio })),
		);
		const expected =
			tipsRows[0].index_ratio +
			(tipsRows[1].index_ratio - tipsRows[0].index_ratio) / 3;
		expect(at("2025-08-02")).toBeCloseTo(expected, 9);
		// And the 5 Aug point lies on the same line: the whole month is one line.
		const slope = (tipsRows[1].index_ratio - tipsRows[0].index_ratio) / 3;
		expect(tipsRows[2].index_ratio - tipsRows[1].index_ratio).toBeCloseTo(
			slope,
			8,
		);
	});

	test("a coupon pays the real coupon on inflation-adjusted principal", () => {
		const ratio =
			indexRatioAt(
				tipsRows.map((r) => ({
					date: settlementFor(r.date),
					ratio: r.index_ratio,
				})),
			)("2026-01-15") ?? 0;
		expect(tips.coupon("2026-01-15")).toBeCloseTo(0.9375 * ratio, 12);
	});

	test("principal repaid is floored at par (the deflation floor)", () => {
		const deflated = tipsPricer(TIPS, [
			{ date: "2035-07-12", indexRatio: 0.98 },
			{ date: "2035-07-13", indexRatio: 0.98 },
		]);
		expect(deflated.redemption()).toBe(100);
		expect(tips.redemption()).toBeGreaterThan(100);
	});

	test("anything past the last stored day is an estimate", () => {
		expect(tips.isEstimate("2025-08-05")).toBe(false);
		expect(tips.isEstimate("2026-01-15")).toBe(true);
	});
});

describe("FRN", () => {
	const frn = frnPricer(
		{ maturityDate: "2027-10-31" },
		frnRows.map((r) => ({
			date: r.date,
			accrued: r.accrued_interest,
			indexRate: r.index_rate,
			spread: r.quoted_spread,
		})),
	);

	for (const row of frnRows) {
		test(`accrued at the ${row.date} settlement is the stored accrual`, () => {
			expect(frn.accrued(settlementFor(row.date))).toBeCloseTo(
				row.accrued_interest,
				12,
			);
			expect(frn.dirty(row.clean_price, row.date)).toBeCloseTo(
				row.dirty_price,
				10,
			);
		});
	}

	test("between stored days it accrues at the last stored rate, actual/360", () => {
		// 5 Nov settlement: 4 Nov's accrual plus a day at (3.852% + 0.19%).
		const last = frnRows[2];
		expect(frn.accrued("2025-11-06")).toBeCloseTo(
			last.accrued_interest + ((last.index_rate + last.quoted_spread) * 100) / 360,
			12,
		);
	});

	test("pays quarterly on the maturity's day of the month", () => {
		expect(frn.couponDates("2025-11-01").slice(0, 4)).toEqual([
			"2025-10-31",
			"2026-01-31",
			"2026-04-30",
			"2026-07-31",
		]);
	});

	test("the first coupon is the whole period's accrual, and nothing is accrued on a coupon date", () => {
		expect(frn.coupon("2026-01-31")).toBeCloseTo(
			frn.accrued("2026-01-30") +
				((frnRows[2].index_rate + frnRows[2].quoted_spread) * 100) / 360,
			10,
		);
		expect(frn.accrued("2026-01-31")).toBe(0);
		expect(frn.isEstimate("2026-01-31")).toBe(true);
	});
});

describe("nominal, unchanged", () => {
	test("a note's pricer is the coupon formula", () => {
		const note = nominalPricer({
			couponRate: 0.04625,
			maturityDate: "2035-02-15",
			frequency: 2,
		});
		expect(note.coupon("2027-02-15")).toBe(2.3125);
		expect(note.dirty(96.53125, "2026-09-25")).toBeCloseTo(97.08423913043478, 12);
		expect(note.isEstimate("2030-01-01")).toBe(false);
	});
});

describe("the ledger on a TIPS", () => {
	test("accepted once it has a pricer; the coupon is paid on inflation-adjusted principal", async () => {
		const { buildLedger, checkTrades } = await import("../src/ledger");
		const terms = new Map([
			["91282CNS6", { cusip: "91282CNS6", family: "tips" as const, ...TIPS }],
		]);
		const buy = {
			idTransaction: "t1",
			cusip: "91282CNS6",
			side: "buy" as const,
			tradeDate: "2025-07-31",
			settleDate: "2025-08-01",
			faceAmount: 1_000_000,
			cleanPrice: 99.0625,
		};
		expect(checkTrades([buy], terms)[0]?.kind).toBe("unsupported_family");
		const pricers = new Map([["91282CNS6", tips]]);
		expect(checkTrades([buy], terms, new Set(pricers.keys()))).toEqual([]);

		const calendar = [
			"2025-07-31",
			"2025-08-01",
			"2025-08-04",
			"2026-01-14",
			"2026-01-15",
			"2026-01-16",
		];
		const ledger = buildLedger({
			trades: [buy],
			terms,
			pricers,
			marks: new Map([
				[
					"91282CNS6",
					tipsRows.map((r) => ({ date: r.date, close: r.real_clean_price })),
				],
			]),
			calendar,
			asOf: "2026-01-16",
			income: "distribute",
		});
		// Cost: 10,000 x stored real dirty x stored ratio.
		expect(ledger.cashflows[0].amount).toBeCloseTo(
			-10_000 * tipsRows[0].real_dirty_price * tipsRows[0].index_ratio,
			6,
		);
		const coupon = ledger.cashflows.find((f) => f.kind === "coupon");
		expect(coupon?.date).toBe("2026-01-15");
		expect(coupon?.amount).toBeCloseTo(10_000 * tips.coupon("2026-01-15"), 8);
		expect(coupon?.amount ?? 0).toBeGreaterThan(9_375);
	});
});
