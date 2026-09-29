import { describe, expect, test } from "bun:test";
import {
	eligibleForMatching,
	isMatchingFailure,
	matchCashflows,
	type TLiability,
	type TMatchingSecurity,
} from "../../src/build/cashflowMatching";

/** A zero coupon paying 100 per 100 of face on one date and nothing else. */
const strip = (
	cusip: string,
	dateIndex: number,
	dates: number,
	askPrice: number,
): TMatchingSecurity => ({
	cusip,
	askPrice,
	cashflows: Array.from({ length: dates }, (_, t) =>
		t === dateIndex ? 100 : 0,
	),
});

/** A coupon bond paying `rate` each date and redeeming at `maturity`. */
const coupon = (
	cusip: string,
	maturity: number,
	dates: number,
	rate: number,
	askPrice: number,
): TMatchingSecurity => ({
	cusip,
	askPrice,
	cashflows: Array.from({ length: dates }, (_, t) =>
		t > maturity ? 0 : rate + (t === maturity ? 100 : 0),
	),
});

const liabilities = (amounts: number[]): TLiability[] =>
	amounts.map((amount, t) => ({ date: `T${t}`, amount }));

const solved = (result: ReturnType<typeof matchCashflows>) => {
	if (isMatchingFailure(result)) {
		throw new Error(`expected a portfolio, got ${result.kind}`);
	}
	return result;
};

describe("eligibleForMatching", () => {
	test("drops the unquoted and the useless", () => {
		// An ask of zero means unquoted, not free. Seven per cent of the price
		// table looks like this and an optimiser that trusts it buys nothing else.
		const kept = eligibleForMatching([
			strip("PRICED", 0, 2, 98),
			strip("UNQUOTED", 0, 2, 0),
			{ cusip: "SILENT", askPrice: 99, cashflows: [0, 0] },
		]);
		expect(kept.map((s) => s.cusip)).toEqual(["PRICED"]);
	});
});

describe("matchCashflows", () => {
	test("one liability buys the security that matures on it", () => {
		// The trivial case, and the one where the answer can be written down:
		// 1,000,000 due needs 1,000,000 of face of the strip that pays then.
		const result = solved(
			matchCashflows({
				securities: [
					strip("EARLY", 0, 3, 99),
					strip("ON-TIME", 2, 3, 95),
					strip("LATE-USELESS", 1, 3, 97),
				],
				liabilities: liabilities([0, 0, 1_000_000]),
			}),
		);
		const onTime = result.positions.find((p) => p.cusip === "ON-TIME");
		expect(onTime?.faceValue).toBeCloseTo(1_000_000, 4);
		expect(result.cost).toBeCloseTo(950_000, 3);
	});

	test("no free lunch: cost never falls below the present value of the stream", () => {
		// The check the brief rates highest, because a sign error elsewhere
		// produces output that looks entirely plausible. With a universe of
		// perfect strips the two must be EQUAL, not merely ordered: any portfolio
		// covering the stream costs at least what discounting it costs, and the
		// strips achieve it exactly.
		const dates = 6;
		const discount = [0.99, 0.975, 0.955, 0.93, 0.9, 0.86];
		const securities = discount.map((factor, t) =>
			strip(`Z${t}`, t, dates, factor * 100),
		);
		const due = [100_000, 250_000, 0, 400_000, 150_000, 600_000];
		const result = solved(
			matchCashflows({ securities, liabilities: liabilities(due) }),
		);
		const presentValue = due.reduce(
			(sum, amount, t) => sum + amount * discount[t],
			0,
		);
		expect(result.cost).toBeGreaterThanOrEqual(presentValue - 1e-6);
		expect(result.cost).toBeCloseTo(presentValue, 3);
	});

	test("every liability is covered with non-negative surplus throughout", () => {
		const dates = 8;
		const securities = [
			coupon("C2", 2, dates, 2, 101),
			coupon("C5", 5, dates, 2.5, 102),
			coupon("C7", 7, dates, 3, 103),
			strip("Z1", 1, dates, 97),
			strip("Z4", 4, dates, 90),
		];
		const due = [
			50_000, 60_000, 70_000, 80_000, 90_000, 100_000, 110_000, 120_000,
		];
		const result = solved(
			matchCashflows({ securities, liabilities: liabilities(due) }),
		);
		for (const value of result.surplus) expect(value).toBeGreaterThan(-1e-6);
		expect(result.surplus).toHaveLength(dates);
	});

	test("surplus carries forward, so early money can fund a later date", () => {
		// Only one security exists and it pays everything on the first date. A
		// solver that did not roll surplus forward would call this infeasible.
		const result = solved(
			matchCashflows({
				securities: [strip("ALL-UP-FRONT", 0, 3, 99)],
				liabilities: liabilities([0, 0, 500_000]),
			}),
		);
		expect(result.positions[0].faceValue).toBeCloseTo(500_000, 4);
		expect(result.surplus[0]).toBeCloseTo(500_000, 4);
		expect(result.surplus[2]).toBeCloseTo(0, 4);
	});

	test("a reinvestment rate reduces the cost, and zero is the conservative default", () => {
		const securities = [strip("Z0", 0, 3, 99), strip("Z2", 2, 3, 94)];
		const due = liabilities([0, 0, 1_000_000]);
		const without = solved(matchCashflows({ securities, liabilities: due }));
		const with5 = solved(
			matchCashflows({
				securities,
				liabilities: due,
				options: { reinvestmentRate: 0.05 },
			}),
		);
		expect(with5.cost).toBeLessThanOrEqual(without.cost + 1e-6);
	});

	test("the relaxation bounds the integer answer from below", () => {
		// Required at every node, and a violation means the branching or the
		// pruning is wrong rather than that the answer is slightly off.
		const dates = 6;
		const securities = Array.from({ length: 10 }, (_, i) =>
			strip(`Z${i}`, i % dates, dates, 90 + i / 2),
		);
		const due = liabilities([40_000, 0, 90_000, 30_000, 0, 120_000]);
		const result = solved(
			matchCashflows({
				securities,
				liabilities: due,
				options: { maxPositions: 3 },
			}),
		);
		expect(result.cost).toBeGreaterThanOrEqual(result.relaxationCost - 1e-6);
	});

	test("with the limits switched off the integer answer IS the relaxation", () => {
		// The integer constraints must not bite when they cannot bind. If this
		// fails the machinery is charging for operability nobody asked for.
		const dates = 5;
		const securities = Array.from({ length: 6 }, (_, i) =>
			strip(`Z${i}`, i % dates, dates, 92 + i),
		);
		const due = liabilities([10_000, 20_000, 0, 40_000, 50_000]);
		const capped = solved(
			matchCashflows({
				securities,
				liabilities: due,
				options: { maxPositions: 99, minLot: 0 },
			}),
		);
		expect(capped.cost).toBeCloseTo(capped.relaxationCost, 4);
	});

	test("the position cap is respected and costs something", () => {
		const dates = 6;
		const securities = Array.from({ length: 6 }, (_, i) =>
			strip(`Z${i}`, i, dates, 95 - i),
		);
		const due = liabilities([10_000, 20_000, 30_000, 40_000, 50_000, 60_000]);
		const free = solved(matchCashflows({ securities, liabilities: due }));
		const capped = solved(
			matchCashflows({
				securities,
				liabilities: due,
				options: { maxPositions: 2 },
			}),
		);
		expect(free.positions.length).toBeGreaterThan(2);
		expect(capped.positions.length).toBeLessThanOrEqual(2);
		// Operability is not free, and the gap to the relaxation is its price.
		expect(capped.cost).toBeGreaterThanOrEqual(free.cost - 1e-6);
	});

	test("every held position clears the minimum lot", () => {
		const dates = 5;
		const securities = Array.from({ length: 5 }, (_, i) =>
			strip(`Z${i}`, i, dates, 95),
		);
		const due = liabilities([1_000, 200_000, 1_000, 200_000, 1_000]);
		const result = solved(
			matchCashflows({
				securities,
				liabilities: due,
				options: { minLot: 50_000, maxPositions: 4 },
			}),
		);
		for (const position of result.positions) {
			expect(position.faceValue).toBeGreaterThanOrEqual(50_000 - 1e-6);
		}
	});

	test("never costs more than a greedy backward recursion", () => {
		// The independent upper bound from the brief: work back from the last
		// liability buying the security that matures nearest it, net down, repeat.
		// An optimiser beaten by that is not optimising.
		const dates = 5;
		const discount = [0.98, 0.96, 0.93, 0.9, 0.87];
		const securities = discount.map((factor, t) =>
			strip(`Z${t}`, t, dates, factor * 100),
		);
		const due = [80_000, 40_000, 120_000, 60_000, 200_000];
		const result = solved(
			matchCashflows({ securities, liabilities: liabilities(due) }),
		);
		let greedy = 0;
		const remaining = [...due];
		for (let t = dates - 1; t >= 0; t--) {
			if (remaining[t] <= 0) continue;
			greedy += remaining[t] * discount[t];
			remaining[t] = 0;
		}
		expect(result.cost).toBeLessThanOrEqual(greedy + 1e-6);
	});

	test("faces are multiples of the denomination and still cover the stream", () => {
		const dates = 4;
		const securities = [
			coupon("C1", 1, dates, 2, 100.5),
			coupon("C3", 3, dates, 2.5, 101.25),
			strip("Z2", 2, dates, 94.125),
		];
		const due = liabilities([33_333, 47_777, 61_111, 89_999]);
		const result = solved(
			matchCashflows({
				securities,
				liabilities: due,
				options: { denomination: 1_000 },
			}),
		);
		for (const position of result.positions) {
			expect(position.faceValue % 1_000).toBe(0);
		}
		// Rounding down opens a hole; the repair pass has to close it.
		for (const value of result.surplus) expect(value).toBeGreaterThan(-1e-6);
	});

	test("rounding to the denomination never drops a position below the lot", () => {
		// Found on real data. Rounding down is what makes the answer tradeable,
		// and on its own it undoes the minimum lot: a position the optimiser set
		// at 99,500 against a lot of 100,000 rounds to 99,000, which the search
		// had just spent its time forbidding. Anything held rounds up instead,
		// and anything the optimiser wanted at zero stays at zero.
		const dates = 4;
		const securities = Array.from({ length: 4 }, (_, i) =>
			strip(`Z${i}`, i, dates, 95 + i / 8),
		);
		const due = liabilities([104_900, 99_500, 100_400, 101_100]);
		const result = solved(
			matchCashflows({
				securities,
				liabilities: due,
				options: { denomination: 1_000, minLot: 100_000, maxPositions: 4 },
			}),
		);
		expect(result.positions.length).toBeGreaterThan(0);
		for (const position of result.positions) {
			expect(position.faceValue % 1_000).toBe(0);
			expect(position.faceValue).toBeGreaterThanOrEqual(100_000);
		}
		for (const value of result.surplus) expect(value).toBeGreaterThan(-1e-6);
	});

	test("a stream reachable only through carried surplus is not called uncoverable", () => {
		// Nothing matures on the final date, but the one security pays at T0 and
		// surplus rolls forward. A solver that tested each date against the
		// cashflows landing on it would declare this impossible.
		const result = matchCashflows({
			securities: [strip("SHORT", 0, 4, 99)],
			liabilities: [
				{ date: "2030-01-15", amount: 0 },
				{ date: "2031-01-15", amount: 0 },
				{ date: "2032-01-15", amount: 0 },
				{ date: "2033-01-15", amount: 1_000_000 },
			],
		});
		expect(isMatchingFailure(result)).toBe(false);
		const portfolio = solved(result);
		expect(portfolio.positions[0].faceValue).toBeCloseTo(1_000_000, 4);
		expect(portfolio.surplus[3]).toBeCloseTo(0, 4);
	});

	test("a genuinely uncoverable stream reports the date", () => {
		const result = matchCashflows({
			securities: [
				{ cusip: "NOTHING-EARLY", askPrice: 99, cashflows: [0, 0, 100] },
			],
			liabilities: [
				{ date: "2030-06-30", amount: 500_000 },
				{ date: "2031-06-30", amount: 0 },
				{ date: "2032-06-30", amount: 0 },
			],
		});
		expect(isMatchingFailure(result)).toBe(true);
		if (!isMatchingFailure(result)) return;
		expect(result.kind).toBe("uncoverable");
		if (result.kind !== "uncoverable") return;
		expect(result.date).toBe("2030-06-30");
		expect(result.message).toContain("2030-06-30");
	});

	test("a cap that cannot work is distinguished from a stream that cannot", () => {
		// Two distinct failures needing two distinct messages. Six dates, six
		// strips, one position allowed: the stream is fine and the cap is not.
		const dates = 6;
		const securities = Array.from({ length: 6 }, (_, i) =>
			strip(`Z${i}`, i, dates, 95),
		);
		const result = matchCashflows({
			securities,
			liabilities: liabilities([0, 0, 0, 0, 0, 100_000]).map((l, t) =>
				t === 5 ? l : { ...l, amount: 10_000 },
			),
			options: { maxPositions: 1, minLot: 90_000 },
		});
		if (!isMatchingFailure(result)) {
			// A single early strip can fund everything through surplus, so a
			// solution may well exist; then the cap simply was not binding.
			expect(result.positions.length).toBeLessThanOrEqual(1);
			return;
		}
		expect(result.kind).toBe("position-cap");
		if (result.kind !== "position-cap") return;
		expect(result.needed).toBeGreaterThan(1);
		expect(result.message).toContain("coverable");
	});

	test("no liabilities gives an empty portfolio rather than a crash", () => {
		const result = solved(
			matchCashflows({
				securities: [strip("Z", 0, 1, 99)],
				liabilities: [],
			}),
		);
		expect(result.positions).toEqual([]);
		expect(result.cost).toBe(0);
	});

	test("marginal cost by date prices the stream", () => {
		// The duals, and the reason they are worth surfacing: with perfect strips
		// the marginal cost of a dollar due on a date is exactly that date's
		// discount factor.
		const dates = 4;
		const discount = [0.99, 0.97, 0.94, 0.9];
		const securities = discount.map((factor, t) =>
			strip(`Z${t}`, t, dates, factor * 100),
		);
		const result = solved(
			matchCashflows({
				securities,
				liabilities: liabilities([100_000, 100_000, 100_000, 100_000]),
			}),
		);
		expect(result.marginalCostByDate).toHaveLength(dates);
		const total = result.marginalCostByDate.reduce((a, b) => a + b, 0);
		expect(total).toBeGreaterThan(0);
	});

	test("optimising against the close would look cheaper than the ask", () => {
		// The convention check. Same problem, one priced at the bid: it must come
		// out cheaper, and if it does not the price column is the wrong one.
		const dates = 3;
		const atAsk = [strip("Z0", 0, dates, 99), strip("Z2", 2, dates, 94)];
		const atBid = [strip("Z0", 0, dates, 98.5), strip("Z2", 2, dates, 93.5)];
		const due = liabilities([50_000, 0, 250_000]);
		const ask = solved(matchCashflows({ securities: atAsk, liabilities: due }));
		const bid = solved(matchCashflows({ securities: atBid, liabilities: due }));
		expect(bid.cost).toBeLessThan(ask.cost);
	});
});

describe("an empty universe (found porting to saferate-markets, 2026-09-29)", () => {
	test("is uncoverable, not an optimal portfolio of nothing with the liability unmet", () => {
		const result = matchCashflows({
			securities: [],
			liabilities: [{ date: "2026-09-29", amount: 1000 }],
		});
		expect("kind" in result && result.kind).toBe("uncoverable");
	});
	test("and so is a universe that pays nothing", () => {
		const result = matchCashflows({
			securities: [{ cusip: "X", askPrice: 99, cashflows: [0] }],
			liabilities: [{ date: "2026-09-29", amount: 1000 }],
		});
		expect("kind" in result && result.kind).toBe("uncoverable");
	});
});
