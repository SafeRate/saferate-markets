import { describe, expect, test } from "bun:test";
import { isBusinessDay, toDate, toIso } from "../src/dates";
import {
	buildLedger,
	checkTrades,
	type TSecurityTerms,
	type TTrade,
} from "../src/ledger";
import {
	chainReturns,
	moneyWeightedReturn,
	periodStart,
	positionsAt,
	projectedIncome,
	realisedPriceGains,
	summarise,
} from "../src/returns";
import { accruedPer100 } from "../src/dates";

/**
 * Worked examples, each checkable by hand. The note is the real 10-year
 * 91282CMM0 (4 5/8%, matures 2035-02-15), whose accrual tests/dates.test.ts
 * holds to production analytics; the prices are chosen to make the arithmetic
 * visible.
 */

const NOTE: TSecurityTerms = {
	cusip: "91282CMM0",
	family: "note",
	couponRate: 0.04625,
	maturityDate: "2035-02-15",
	frequency: 2,
};
const BILL: TSecurityTerms = {
	cusip: "912797UJ4",
	family: "bill",
	couponRate: 0,
	maturityDate: "2026-10-01",
	frequency: 2,
};
const TERMS = new Map([
	[NOTE.cusip, NOTE],
	[BILL.cusip, BILL],
]);

const businessDays = (from: string, to: string) => {
	const days: string[] = [];
	for (
		let d = toDate(from);
		d <= toDate(to);
		d = new Date(d.getTime() + 86_400_000)
	)
		if (isBusinessDay(d)) days.push(toIso(d));
	return days;
};
const CALENDAR = businessDays("2026-08-03", "2026-10-09");
const flat = (close: number, overrides: Record<string, number> = {}) =>
	CALENDAR.map((date) => ({ date, close: overrides[date] ?? close }));

let n = 0;
const trade = (t: Omit<TTrade, "idTransaction">): TTrade => {
	n += 1;
	return { idTransaction: `t${n}`, ...t };
};
const accrued = (s: TSecurityTerms, settlementDate: string) =>
	accruedPer100({
		couponRate: s.couponRate,
		maturityDate: s.maturityDate,
		settlementDate,
		frequency: s.frequency,
	});

const run = (
	trades: TTrade[],
	marks: Map<string, { date: string; close: number }[]>,
	asOf: string,
) => buildLedger({ trades, terms: TERMS, marks, calendar: CALENDAR, asOf });

describe("buy and hold, no coupon in the window", () => {
	const buy = trade({
		cusip: NOTE.cusip,
		side: "buy",
		tradeDate: "2026-08-20",
		settleDate: "2026-08-21",
		faceAmount: 1_000_000,
		cleanPrice: 96,
	});
	const ledger = run(
		[buy],
		new Map([[NOTE.cusip, flat(96, { "2026-09-25": 96.53125 })]]),
		"2026-09-25",
	);

	test("the purchase costs clean plus accrued: 10,000 x (96 + 2.3125 x 6/184)", () => {
		expect(ledger.cashflows[0].amount).toBeCloseTo(
			-10_000 * (96 + (2.3125 * 6) / 184),
			8,
		);
	});

	test("with no flows after the buy, the time-weighted return is value over cost", () => {
		const cost = -ledger.cashflows[0].amount;
		const end = ledger.days.at(-1)?.marketValue ?? 0;
		expect(chainReturns(ledger.days, null, "2026-09-25").cumulative).toBeCloseTo(
			end / cost - 1,
			12,
		);
		// End value: 10,000 x (96.53125 + accrued to 28 Sep, 2.3125 x 44/184).
		expect(end).toBeCloseTo(10_000 * (96.53125 + (2.3125 * 44) / 184), 8);
	});

	test("so the money-weighted return annualises the same growth", () => {
		const cost = -ledger.cashflows[0].amount;
		const end = ledger.days.at(-1)?.marketValue ?? 0;
		const mwr =
			moneyWeightedReturn(
				[{ date: "2026-08-21", amount: -cost }],
				"2026-09-25",
				end,
			) ?? 0;
		expect((1 + mwr) ** (35 / 365.25)).toBeCloseTo(end / cost, 10);
	});
});

describe("a coupon, and who is entitled to it", () => {
	// 15 Aug 2026 is a Saturday. Friday 14 Aug settles Monday 17 Aug, so the
	// coupon lands in Friday's window (13 Aug settlement 14 Aug, 17 Aug].
	const buyEarly = trade({
		cusip: NOTE.cusip,
		side: "buy",
		tradeDate: "2026-08-10",
		settleDate: "2026-08-11",
		faceAmount: 1_000_000,
		cleanPrice: 96,
	});
	const marks = new Map([[NOTE.cusip, flat(96)]]);

	test("a holder going into the window is paid 1,000,000 x 4.625% / 2, booked Friday", () => {
		const ledger = run([buyEarly], marks, "2026-08-31");
		const coupon = ledger.cashflows.find((f) => f.kind === "coupon");
		expect(coupon).toEqual({
			date: "2026-08-15",
			bookedOn: "2026-08-14",
			cusip: NOTE.cusip,
			kind: "coupon",
			amount: 23_125,
			faceAmount: 1_000_000,
		});
	});

	test("a buyer settling after the coupon (trade Fri 14 Aug) is not", () => {
		const late = trade({
			cusip: NOTE.cusip,
			side: "buy",
			tradeDate: "2026-08-14",
			settleDate: "2026-08-17",
			faceAmount: 1_000_000,
			cleanPrice: 96,
		});
		expect(
			run([late], marks, "2026-08-31").cashflows.some((f) => f.kind === "coupon"),
		).toBe(false);
	});

	test("a seller settling after it still is, and the sale carries no accrued", () => {
		const sell = trade({
			cusip: NOTE.cusip,
			side: "sell",
			tradeDate: "2026-08-14",
			settleDate: "2026-08-17",
			faceAmount: 1_000_000,
			cleanPrice: 96,
		});
		const ledger = run([buyEarly, sell], marks, "2026-08-31");
		expect(ledger.cashflows.filter((f) => f.kind === "coupon")).toHaveLength(1);
		// Settles 17 Aug, two days into the new period: 2.3125 x 2/184 accrued.
		expect(ledger.cashflows.find((f) => f.kind === "sell")?.amount).toBeCloseTo(
			10_000 * (96 + (2.3125 * 2) / 184),
			8,
		);
		expect(ledger.holdings.size).toBe(0);
	});
});

describe("selling", () => {
	const buy1 = trade({
		cusip: NOTE.cusip,
		side: "buy",
		tradeDate: "2026-08-20",
		settleDate: "2026-08-21",
		faceAmount: 1_000_000,
		cleanPrice: 95,
	});
	const buy2 = trade({
		cusip: NOTE.cusip,
		side: "buy",
		tradeDate: "2026-09-01",
		settleDate: "2026-09-02",
		faceAmount: 1_000_000,
		cleanPrice: 97,
	});
	const sell = trade({
		cusip: NOTE.cusip,
		side: "sell",
		tradeDate: "2026-09-15",
		settleDate: "2026-09-16",
		faceAmount: 1_500_000,
		cleanPrice: 96.5,
	});
	const marks = new Map([[NOTE.cusip, flat(96.5)]]);
	const ledger = run([buy1, buy2, sell], marks, "2026-09-25");

	test("a partial sale leaves the rest held", () => {
		expect(ledger.holdings.get(NOTE.cusip)).toBe(500_000);
	});

	test("realised gain is FIFO: 1m at +1.5 then 0.5m at -0.5", () => {
		const gain =
			realisedPriceGains([buy1, buy2, sell], ledger, "2026-09-25").get(
				NOTE.cusip,
			) ?? 0;
		expect(gain).toBeCloseTo(15_000 - 2_500, 8);
	});

	test("what is held carries the cost of the lot it came from", () => {
		const [position] = positionsAt({
			ledger,
			trades: [buy1, buy2, sell],
			terms: TERMS,
			lastMarks: new Map([[NOTE.cusip, { date: "2026-09-25", close: 96.5 }]]),
			asOf: "2026-09-25",
			accrued,
		});
		expect(position.averageCleanCost).toBe(97);
		expect(position.unrealisedPriceGain).toBeCloseTo(-2_500, 8);
	});

	test("selling more than is held is refused, naming the date and amounts", () => {
		const tooMuch = trade({
			cusip: NOTE.cusip,
			side: "sell",
			tradeDate: "2026-08-25",
			settleDate: "2026-08-26",
			faceAmount: 2_000_000,
			cleanPrice: 96,
		});
		expect(checkTrades([buy1, tooMuch], TERMS)).toEqual([
			{
				kind: "oversold",
				cusip: NOTE.cusip,
				tradeDate: "2026-08-25",
				heldFace: 1_000_000,
				soldFace: 2_000_000,
			},
		]);
	});

	test("dollars made add up: value + everything received - everything paid", () => {
		const s = summarise(ledger, "2026-09-25");
		expect(s.totalGain).toBeCloseTo(s.marketValue + s.received - s.invested, 8);
	});
});

describe("maturity", () => {
	test("a bill is redeemed at par on maturity and leaves the portfolio", () => {
		const buy = trade({
			cusip: BILL.cusip,
			side: "buy",
			tradeDate: "2026-09-01",
			settleDate: "2026-09-02",
			faceAmount: 100_000,
			cleanPrice: 99.7,
		});
		const ledger = run([buy], new Map([[BILL.cusip, flat(99.9)]]), "2026-10-09");
		const redemption = ledger.cashflows.find((f) => f.kind === "redemption");
		// Matures Thu 1 Oct; Wed 30 Sep settles 1 Oct, so it is booked then.
		expect(redemption).toMatchObject({
			date: "2026-10-01",
			bookedOn: "2026-09-30",
			amount: 100_000,
		});
		expect(ledger.holdings.size).toBe(0);
		expect(ledger.days.at(-1)?.marketValue).toBe(0);
		// Realises 100 against the 99.7 paid: 300.
		expect(
			realisedPriceGains([buy], ledger, "2026-10-09").get(BILL.cusip),
		).toBeCloseTo(300, 8);
	});

	test("a trade settling on or after maturity is refused", () => {
		const late = trade({
			cusip: BILL.cusip,
			side: "buy",
			tradeDate: "2026-09-30",
			settleDate: "2026-10-01",
			faceAmount: 100_000,
			cleanPrice: 99.99,
		});
		expect(checkTrades([late], TERMS)[0].kind).toBe("trade_after_maturity");
	});
});

describe("unsupported kinds are refused, not mispriced", () => {
	test("a TIPS", () => {
		const tips: TSecurityTerms = {
			cusip: "91282CNS6",
			family: "tips",
			couponRate: 0.01875,
			maturityDate: "2035-07-15",
			frequency: 2,
		};
		const buy = trade({
			cusip: tips.cusip,
			side: "buy",
			tradeDate: "2026-09-01",
			settleDate: "2026-09-02",
			faceAmount: 1000,
			cleanPrice: 93,
		});
		expect(checkTrades([buy], new Map([[tips.cusip, tips]]))[0]).toEqual({
			kind: "unsupported_family",
			cusip: tips.cusip,
			family: "tips",
		});
	});
});

describe("stale marks are recorded, not hidden", () => {
	test("a day with no close is marked at the previous close and listed", () => {
		const buy = trade({
			cusip: NOTE.cusip,
			side: "buy",
			tradeDate: "2026-09-01",
			settleDate: "2026-09-02",
			faceAmount: 1_000_000,
			cleanPrice: 96,
		});
		const gappy = flat(96).filter((m) => m.date !== "2026-09-10");
		const ledger = run([buy], new Map([[NOTE.cusip, gappy]]), "2026-09-15");
		expect(ledger.staleMarks).toEqual([
			{ cusip: NOTE.cusip, date: "2026-09-10" },
		]);
	});
});

describe("projected income", () => {
	test("every coupon to maturity plus principal, for what is still held", () => {
		const flows = projectedIncome({
			holdings: new Map([[NOTE.cusip, 1_000_000]]),
			terms: TERMS,
			asOf: "2026-09-25",
		});
		expect(flows[0]).toEqual({
			date: "2027-02-15",
			cusip: NOTE.cusip,
			kind: "coupon",
			amount: 23_125,
		});
		expect(flows.filter((f) => f.kind === "coupon")).toHaveLength(17);
		expect(flows.at(-1)).toEqual({
			date: "2035-02-15",
			cusip: NOTE.cusip,
			kind: "redemption",
			amount: 1_000_000,
		});
	});
});

describe("periods", () => {
	test("each opens at the prior period's close", () => {
		expect(periodStart("mtd", "2026-09-25")).toBe("2026-08-31");
		expect(periodStart("qtd", "2026-09-25")).toBe("2026-06-30");
		expect(periodStart("qtd", "2026-10-02")).toBe("2026-09-30");
		expect(periodStart("ytd", "2026-09-25")).toBe("2025-12-31");
		expect(periodStart("1y", "2026-09-25")).toBe("2025-09-25");
	});

	test("a period that opened before the portfolio is flagged, not passed off as full", () => {
		const buy = trade({
			cusip: NOTE.cusip,
			side: "buy",
			tradeDate: "2026-09-01",
			settleDate: "2026-09-02",
			faceAmount: 1_000_000,
			cleanPrice: 96,
		});
		const ledger = run([buy], new Map([[NOTE.cusip, flat(96)]]), "2026-09-25");
		expect(
			chainReturns(ledger.days, "2025-12-31", "2026-09-25").isFullPeriod,
		).toBe(false);
		expect(
			chainReturns(ledger.days, "2026-09-10", "2026-09-25").isFullPeriod,
		).toBe(true);
	});
});
