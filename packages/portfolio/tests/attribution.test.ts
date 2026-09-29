import { describe, expect, test } from "bun:test";
import notePrices from "../../../apps/api/tests/fixtures/securities/nominal-prices.json";
import {
	attributeLedger,
	attributionOver,
	decomposeHolding,
	fitFactors,
} from "../src/attribution";
import { zeroRate } from "../src/curve";
import {
	couponDates,
	isBusinessDay,
	settlementFor,
	yearFraction,
} from "../src/dates";
import { buildLedger, type TSecurityTerms } from "../src/ledger";
import { nominalPricer } from "../src/pricers";
import curves from "./fixtures/zero-curves.json";

/**
 * Attribution on the PUBLISHED zero curves for 24, 25 and 28 Sep 2026 (fit
 * parameters and zero rates from /v1/curves/zero) and the real closes of the
 * 10-year note 91282CMM0.
 */

const [sep24, sep25, sep28] = curves;
const NOTE: TSecurityTerms = {
	cusip: "91282CMM0",
	family: "note",
	couponRate: 0.04625,
	maturityDate: "2035-02-15",
	frequency: 2,
};
const pricer = nominalPricer(NOTE);

describe("the curve is the published fit", () => {
	for (const day of curves)
		test(`zero rates on ${day.date} reproduce from its parameters`, () => {
			for (const point of day.zero)
				expect(zeroRate(day.params, point.tenorYears)).toBeCloseTo(
					point.zeroRate,
					9,
				);
		});
});

/** The note's remaining cashflows from a settlement date, per 100. */
const cashflows = (from: string) => {
	const dates = couponDates({
		maturityDate: NOTE.maturityDate,
		from,
		frequency: 2,
	}).filter((d) => d > from);
	return {
		payments: dates.map((d) => 2.3125 + (d === NOTE.maturityDate ? 100 : 0)),
		paymentsYears: dates.map((d) => yearFraction(from, d)),
	};
};

describe("one step of one bond", () => {
	const s0 = settlementFor("2026-09-24");
	const s1 = settlementFor("2026-09-25");
	const step = {
		face: 1_000_000,
		...cashflows(s0),
		startDirty: pricer.dirty(96.375, "2026-09-24"),
		endDirty: pricer.dirty(96.53125, "2026-09-25"),
		startCurve: sep24.params,
		endCurve: sep25.params,
		periodYears: yearFraction(s0, s1),
	};
	const parts = decomposeHolding(step);

	test("the components add to the bond's dollar return exactly", () => {
		const sum =
			parts.carry +
			parts.rolldown +
			parts.curveShift +
			parts.curveTwist +
			parts.curveButterfly +
			parts.curveShape +
			parts.selection;
		expect(sum).toBeCloseTo(parts.total, 9);
		expect(parts.total).toBeCloseTo(
			(1_000_000 / 100) * (step.endDirty - step.startDirty),
			6,
		);
	});

	test("carry is the riskless return: the same per dollar for any bond", () => {
		const other = decomposeHolding({
			...step,
			face: 250_000,
			startDirty: step.startDirty + 3,
		});
		expect(other.carry / (2_500 * (step.startDirty + 3))).toBeCloseTo(
			parts.carry / (10_000 * step.startDirty),
			12,
		);
	});

	test("an unchanged curve and a bond priced on it leave only carry and roll-down", () => {
		const { payments, paymentsYears } = step;
		const df = (t: number) => Math.exp((-zeroRate(sep24.params, t) / 100) * t);
		const onCurve = payments.reduce((s, p, i) => s + p * df(paymentsYears[i]), 0);
		const aged = payments.reduce(
			(s, p, i) => s + p * df(paymentsYears[i] - step.periodYears),
			0,
		);
		const flat = decomposeHolding({
			...step,
			startDirty: onCurve,
			endDirty: aged,
			endCurve: sep24.params,
		});
		for (const k of [
			"curveShift",
			"curveTwist",
			"curveButterfly",
			"curveShape",
			"selection",
		] as const)
			expect(Math.abs(flat[k])).toBeLessThan(1e-6);
	});

	test("a parallel move is all level shift", () => {
		const up = { ...sep24.params, theta0: sep24.params.theta0 + 0.001 };
		const f = fitFactors(sep24.params, up);
		expect(f.levelBp).toBeCloseTo(10, 9);
		expect(f.slopeBp).toBeCloseTo(0, 9);
		expect(f.curvatureBp).toBeCloseTo(0, 9);
		const moved = decomposeHolding({ ...step, endCurve: up });
		expect(
			Math.abs(moved.curveTwist) +
				Math.abs(moved.curveButterfly) +
				Math.abs(moved.curveShape),
		).toBeLessThan(1e-6);
		expect(moved.curveShift).toBeLessThan(0);
	});

	test("on the real 25 to 28 Sep selloff the fitted factors explain the move", () => {
		// 2Y +7.5bp, 10Y +7.2bp: mostly a level shift.
		const f = fitFactors(sep25.params, sep28.params);
		expect(f.levelBp).toBeGreaterThan(4);
		const s25 = settlementFor("2026-09-25");
		const move = decomposeHolding({
			...step,
			...cashflows(s25),
			startDirty: pricer.dirty(96.53125, "2026-09-25"),
			endDirty: pricer.dirty(96.0625, "2026-09-28"),
			startCurve: sep25.params,
			endCurve: sep28.params,
			periodYears: yearFraction(s25, settlementFor("2026-09-28")),
		});
		const curveTotal =
			move.curveShift + move.curveTwist + move.curveButterfly + move.curveShape;
		expect(curveTotal).toBeLessThan(0);
		expect(Math.abs(move.curveShape)).toBeLessThan(Math.abs(curveTotal) * 0.25);
	});
});

describe("a ledger, attributed and linked", () => {
	const buy = {
		idTransaction: "t1",
		cusip: NOTE.cusip,
		side: "buy" as const,
		tradeDate: "2026-09-23",
		settleDate: "2026-09-24",
		faceAmount: 1_000_000,
		cleanPrice: 96.75, // 1/16 under the 96.8125 close: a small trading gain
	};
	const terms = new Map([[NOTE.cusip, NOTE]]);
	const marks = new Map([
		[
			NOTE.cusip,
			[...notePrices]
				.sort((a, b) => a.date.localeCompare(b.date))
				.map((p) => ({ date: p.date, close: p.close })),
		],
	]);
	const ledger = buildLedger({
		trades: [buy],
		terms,
		marks,
		calendar: ["2026-09-23", "2026-09-24", "2026-09-25"],
		asOf: "2026-09-25",
		income: "distribute",
	});
	const days = attributeLedger({
		ledger,
		trades: [buy],
		terms,
		pricers: new Map([[NOTE.cusip, pricer]]),
		marks,
		curves: new Map([
			["2026-09-23", sep24.params],
			["2026-09-24", sep24.params],
			["2026-09-25", sep25.params],
		]),
	});
	const period = attributionOver(days, null, "2026-09-25");

	test("the linked components add to the time-weighted return", () => {
		expect(period.totalReturn).not.toBeNull();
		expect(Math.abs(period.residual)).toBeLessThan(1e-9);
	});

	test("the purchase below the close is trading, in dollars and share", () => {
		const trading = period.components.find((c) => c.key === "trading");
		expect(trading?.dollars).toBeCloseTo(10_000 * (96.8125 - 96.75), 6);
		expect(trading?.contribution ?? 0).toBeGreaterThan(0);
	});

	test("dollars add to the ledger's own gain", () => {
		const gain = ledger.days.at(-1)?.marketValue ?? 0;
		const cost = -(ledger.cashflows.find((f) => f.kind === "buy")?.amount ?? 0);
		const explained = period.components.reduce((s, c) => s + c.dollars, 0);
		expect(explained).toBeCloseTo(gain - cost, 6);
	});
});

describe("a coupon inside a step", () => {
	/**
	 * 15 Aug 2026 is a Saturday, so the note's coupon falls inside the step
	 * from Friday's settlement to Monday's. Found 2026-09-29 by the testing
	 * portfolios: carried to the step's end at the curve's forwards, the coupon
	 * "earned" two days the ledger never pays, and every attribution spanning
	 * a coupon was left -0.05 bp unexplained. Counted as received, the parts add
	 * to the time-weighted return under every income policy.
	 */
	const calendar: string[] = [];
	for (
		let d = new Date("2026-08-03T00:00:00Z");
		d.toISOString().slice(0, 10) <= "2026-08-28";
		d.setUTCDate(d.getUTCDate() + 1)
	)
		if (isBusinessDay(d)) calendar.push(d.toISOString().slice(0, 10));
	const terms = new Map([[NOTE.cusip, NOTE]]);
	const marks = new Map([
		[NOTE.cusip, calendar.map((date, i) => ({ date, close: 97 + i / 100 }))],
	]);
	const trades = [
		{
			idTransaction: "t1",
			cusip: NOTE.cusip,
			side: "buy" as const,
			tradeDate: "2026-08-04",
			settleDate: "2026-08-05",
			faceAmount: 1_000_000,
			cleanPrice: 97.01,
		},
	];
	for (const income of ["cash", "reinvest", "distribute"] as const)
		test(`leaves nothing unexplained, income ${income}`, () => {
			const pricers = new Map([[NOTE.cusip, pricer]]);
			const ledger = buildLedger({
				trades,
				terms,
				marks,
				calendar,
				asOf: "2026-08-28",
				income,
				cashRate: () => 0.04,
				pricers,
			});
			const days = attributeLedger({
				ledger,
				trades,
				terms,
				pricers,
				marks,
				curves: new Map(calendar.map((d) => [d, sep24.params])),
			});
			const period = attributionOver(days, null, "2026-08-28");
			expect(ledger.cashflows.some((f) => f.kind === "coupon")).toBe(true);
			expect(Math.abs(period.residual)).toBeLessThan(1e-9);
		});
});
