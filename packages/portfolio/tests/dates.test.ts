import { describe, expect, test } from "bun:test";
import noteAnalytics from "../../../apps/api/tests/fixtures/securities/nominal-analytics.json";
import notePrices from "../../../apps/api/tests/fixtures/securities/nominal-prices.json";
import {
	accruedPer100,
	addMonths,
	couponDates,
	settlementFor,
	toDate,
	toIso,
} from "../src/dates";

describe("settlement", () => {
	test("T+1 skips the weekend: Friday 2026-09-25 settles Monday", () => {
		expect(settlementFor("2026-09-25")).toBe("2026-09-28");
	});
	test("and a federal holiday: Friday before Columbus Day settles Tuesday", () => {
		// Columbus Day 2026 is Monday 12 October.
		expect(settlementFor("2026-10-09")).toBe("2026-10-13");
	});
});

describe("coupon dates", () => {
	test("month ends are carried", () => {
		expect(toIso(addMonths(toDate("2026-08-31"), 6))).toBe("2027-02-28");
		expect(toIso(addMonths(toDate("2027-02-28"), 6))).toBe("2027-08-31");
	});
	test("walked back from maturity, oldest first, starting at or before `from`", () => {
		expect(
			couponDates({
				maturityDate: "2035-02-15",
				from: "2026-09-28",
				frequency: 2,
			}).slice(0, 3),
		).toEqual(["2026-08-15", "2027-02-15", "2027-08-15"]);
	});
});

describe("accrued interest matches production analytics exactly", () => {
	// Every stored row of the 10-year note 91282CMM0: the analytics accrue to
	// T+1 settlement of the price date, so ours must too.
	for (const row of noteAnalytics) {
		test(`91282CMM0 on ${row.date}`, () => {
			const price = notePrices.find((p) => p.date === row.date);
			const accrued = accruedPer100({
				couponRate: price?.rate ?? 0,
				maturityDate: "2035-02-15",
				settlementDate: settlementFor(row.date),
				frequency: 2,
			});
			expect(accrued).toBeCloseTo(row.accrued_interest, 12);
		});
	}

	test("zero at and after maturity, and for a bill", () => {
		expect(
			accruedPer100({
				couponRate: 0.04,
				maturityDate: "2030-01-15",
				settlementDate: "2030-01-15",
				frequency: 2,
			}),
		).toBe(0);
		expect(
			accruedPer100({
				couponRate: 0,
				maturityDate: "2030-01-15",
				settlementDate: "2029-06-01",
				frequency: 2,
			}),
		).toBe(0);
	});
});
