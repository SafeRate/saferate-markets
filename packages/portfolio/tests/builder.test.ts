import { describe, expect, test } from "bun:test";
import {
	buildStrategy,
	matchLiabilities,
	planCashflows,
	planUniverse,
	planYield,
	STRATEGIES,
	TREASURY_DIRECT_LIMIT,
	treasuryDirectAlternative,
} from "../src/builder";
import { settlementFor } from "../src/dates";
import type { TFamily } from "../src/ledger";
import universeFile from "./fixtures/universe-2026-09-28.json";

/**
 * The builder on the REAL priced universe for 2026-09-28 (all 463 securities
 * from /v1/securities: 49 bills, 241 notes, 112 bonds, 53 TIPS, 8 FRNs).
 */

const SETTLE = settlementFor("2026-09-28");
const universe = planUniverse({
	securities: universeFile.securities.map((s) => ({
		cusip: s.cusip,
		family: s.family as TFamily | null,
		couponPercent: s.coupon_percent,
		maturityDate: s.maturity_date,
		price: s.price,
	})),
	settlementDate: SETTLE,
	markup: 0.125,
});

describe("the universe", () => {
	test("bills, notes and bonds only, priced at the close plus the markup, accrued added", () => {
		expect(
			universe.every(
				(s) => s.family === "bill" || s.family === "note" || s.family === "bond",
			),
		).toBe(true);
		const nominal = universeFile.securities.filter(
			(s) =>
				["bill", "note", "bond"].includes(s.family) &&
				s.maturity_date > SETTLE &&
				s.price > 0,
		);
		expect(universe.length).toBe(nominal.length);
		const note = universe.find((s) => s.cusip === "91282CMM0");
		expect(note?.planPrice).toBeCloseTo(96.0625 + 0.125, 12);
		expect(note?.dirtyPrice).toBeCloseTo(96.1875 + (2.3125 * 45) / 184, 10);
		expect(note?.payments.at(-1)).toEqual({
			date: "2035-02-15",
			amount: 102.3125,
		});
	});
});

describe("cash-flow matching", () => {
	// $1m a year for ten years, each 30 June.
	const liabilities = Array.from({ length: 10 }, (_, i) => ({
		date: `${2027 + i}-06-30`,
		amount: 1_000_000,
	}));

	test("covers every liability, fast, without a position cap", () => {
		const started = performance.now();
		const plan = matchLiabilities({ universe, liabilities });
		const elapsed = performance.now() - started;
		expect("kind" in plan).toBe(false);
		if ("kind" in plan) return;
		for (const row of plan.matching?.surplusByDate ?? [])
			expect(row.surplus).toBeGreaterThanOrEqual(-1e-6);
		// Cheaper than $10m of liabilities: the bonds earn their yield.
		expect(plan.cost).toBeLessThan(10_000_000);
		expect(plan.cost).toBeGreaterThan(7_000_000);
		// Face amounts are whole $100s.
		for (const p of plan.positions) expect(p.faceAmount % 100).toBe(0);
		console.info(
			`  matched 10 liabilities from ${universe.length} securities in ${elapsed.toFixed(0)}ms: ${plan.positions.length} positions, $${plan.cost.toFixed(0)}`,
		);
		expect(elapsed).toBeLessThan(10_000);
	});

	test("nothing maturing after the last liability is bought", () => {
		const plan = matchLiabilities({ universe, liabilities });
		if ("kind" in plan) throw new Error(plan.message);
		for (const p of plan.positions)
			expect(p.security.maturityDate <= "2036-06-30").toBe(true);
	});

	test("a liability due before anything pays is named, not silently dropped", () => {
		// Settlement is 29 Sep and everything held must mature after it, so nothing
		// can pay on the settlement date itself. (30 Sep is reachable: 2-year notes
		// mature at month end.)
		const plan = matchLiabilities({
			universe,
			liabilities: [{ date: "2026-09-29", amount: 1_000 }],
		});
		expect("kind" in plan && plan.kind).toBe("uncoverable");
		if ("kind" in plan) expect(plan.message).toContain("2026-09-29");
	});
});

describe("strategy templates", () => {
	for (const strategy of STRATEGIES)
		test(`${strategy.name}: spends the budget within rounding, on real securities`, () => {
			const plan = buildStrategy({
				strategy: strategy.key,
				universe,
				budget: 5_000_000,
				settlementDate: SETTLE,
				horizonYears: 10,
			});
			expect(plan.positions.length).toBeGreaterThan(0);
			expect(plan.cost).toBeLessThanOrEqual(5_000_000);
			expect(plan.cost).toBeGreaterThan(4_950_000);
			expect(strategy.pros.length).toBeGreaterThan(0);
			expect(strategy.cons.length).toBeGreaterThan(0);
		});

	test("a 10-year ladder has a maturity in each year", () => {
		const plan = buildStrategy({
			strategy: "ladder",
			universe,
			budget: 10_000_000,
			settlementDate: SETTLE,
			horizonYears: 10,
		});
		const years = new Set(
			plan.positions.map((p) => Number(p.security.maturityDate.slice(0, 4))),
		);
		expect(years.size).toBe(10);
	});

	test("a bill roll holds only bills, all maturing within a year", () => {
		const plan = buildStrategy({
			strategy: "billRoll",
			universe,
			budget: 1_000_000,
			settlementDate: SETTLE,
		});
		for (const p of plan.positions) {
			expect(p.security.family).toBe("bill");
			expect(p.security.maturityDate <= "2027-09-30").toBe(true);
		}
	});

	test("the plan's yield is sensible and its cashflows add up", () => {
		const plan = buildStrategy({
			strategy: "ladder",
			universe,
			budget: 10_000_000,
			settlementDate: SETTLE,
			horizonYears: 10,
		});
		const y = planYield(plan, SETTLE) ?? 0;
		expect(y).toBeGreaterThan(0.03);
		expect(y).toBeLessThan(0.07);
		const principal = planCashflows(plan).reduce((s, f) => s + f.amount, 0);
		expect(principal).toBeGreaterThan(plan.cost);
	});
});

describe("TreasuryDirect", () => {
	test("an existing CUSIP maps to the nearest auctioned term, and the $10m limit is flagged", () => {
		const plan = buildStrategy({
			strategy: "shortEnd",
			universe,
			budget: 45_000_000,
			settlementDate: SETTLE,
		});
		const twoYear = plan.positions.find((p) =>
			p.security.maturityDate.startsWith("2028"),
		);
		if (!twoYear) throw new Error("no 2-year rung");
		const alt = treasuryDirectAlternative(
			{
				faceAmount: twoYear.faceAmount,
				maturityDate: twoYear.security.maturityDate,
			},
			SETTLE,
		);
		expect(alt.term).toBe("2-year note");
		expect(alt.overLimit).toBe(twoYear.faceAmount > TREASURY_DIRECT_LIMIT);
		expect(alt.overLimit).toBe(true);
	});
});

import {
	customPlan,
	horizonMatch,
	immuniseLiabilities,
	keyRateProfile,
	planRisk,
	trackIndex,
} from "../src/builder";
import { zeroRate } from "../src/curve";
import { yearFraction } from "../src/dates";
import curves from "./fixtures/zero-curves.json";

const curve = curves[2].params; // the published 28 Sep 2026 fit
const liabilities = Array.from({ length: 20 }, (_, i) => ({
	date: `${2027 + i}-06-30`,
	amount: 500_000,
}));

/** Value of the plan's cashflows and of the liabilities on a shifted curve. */
const shifted = (bp: number) => ({
	...curve,
	theta0: curve.theta0 + bp / 10_000,
});
const pvOn = (flows: { years: number; amount: number }[], c: typeof curve) =>
	flows.reduce(
		(s, f) => s + f.amount * Math.exp((-zeroRate(c, f.years) / 100) * f.years),
		0,
	);

describe("immunisation", () => {
	const plan = immuniseLiabilities({
		universe,
		liabilities,
		curve,
		settlementDate: SETTLE,
	});
	const liabilityFlows = liabilities.map((l) => ({
		years: yearFraction(SETTLE, l.date),
		amount: l.amount,
	}));
	const assetFlows = plan.positions.flatMap((p) =>
		p.security.payments.map((pay) => ({
			years: yearFraction(SETTLE, pay.date),
			amount: (p.faceAmount / 100) * pay.amount,
		})),
	);

	test("funds the liabilities' present value with few positions", () => {
		const target = keyRateProfile(liabilityFlows, curve).presentValue;
		expect(plan.cost / target).toBeGreaterThan(0.97);
		expect(plan.cost / target).toBeLessThan(1.03);
		expect(plan.positions.length).toBeLessThanOrEqual(14);
		expect(Math.abs(plan.risk.durationResidual)).toBeLessThan(0.05);
	});

	test("the defining property: after a 50bp move the funding gap barely changes", () => {
		const gapAt = (bp: number) =>
			pvOn(assetFlows, shifted(bp)) - pvOn(liabilityFlows, shifted(bp));
		const drift = Math.abs(gapAt(50) - gapAt(0));
		// The liabilities themselves move by about 10% on 50bp; the gap by a fraction of a percent.
		const liabilityMove = Math.abs(
			pvOn(liabilityFlows, shifted(50)) - pvOn(liabilityFlows, curve),
		);
		expect(drift).toBeLessThan(liabilityMove * 0.03);
	});
});

describe("horizon matching", () => {
	test("cash-matches the first five years exactly and immunises the rest", () => {
		const plan = horizonMatch({
			universe,
			liabilities,
			curve,
			settlementDate: SETTLE,
			horizonYears: 5,
		});
		if ("kind" in plan) throw new Error(plan.message);
		const near = plan.matching?.surplusByDate ?? [];
		expect(near.length).toBe(5);
		for (const row of near) expect(row.surplus).toBeGreaterThanOrEqual(-1e-6);
		expect(plan.risk).not.toBeNull();
	});
});

describe("index tracking", () => {
	test("hits the index's duration for the budget with at most fourteen positions", () => {
		// A flat 6-year profile spread over 5 and 7 years, as a stand-in index.
		const krd = [0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0];
		const plan = trackIndex({
			universe,
			indexKeyRateDurations: krd,
			budget: 25_000_000,
			curve,
			settlementDate: SETTLE,
			indexName: "test",
		});
		expect(plan.positions.length).toBeLessThanOrEqual(14);
		expect(plan.cost).toBeGreaterThan(24_900_000);
		expect(plan.cost).toBeLessThanOrEqual(25_000_000);
		expect(planRisk(plan, curve, SETTLE).duration).toBeCloseTo(6, 0);
	});
});

describe("a custom portfolio", () => {
	test("costs what it is given and reports what it cannot use", () => {
		const plan = customPlan({
			universe,
			rows: [
				{ cusip: "91282CMM0", faceAmount: 1_000_000 },
				{ cusip: "91282CNS6", faceAmount: 100_000 }, // a TIPS: not in the nominal universe
			],
		});
		expect(plan.positions).toHaveLength(1);
		expect(plan.cost).toBeCloseTo(10_000 * (96.1875 + (2.3125 * 45) / 184), 6);
		expect(plan.notes[0]).toContain("91282CNS6");
	});
});

import { LOT_PRESETS } from "../src/builder";

describe("lot sizes", () => {
	const liabilities = Array.from({ length: 10 }, (_, i) => ({
		date: `${2027 + i}-06-30`,
		amount: 1_000_000,
	}));

	test("a minimum position is honoured, the plan still covers every date, and its cost is reported", () => {
		const loose = matchLiabilities({ universe, liabilities, denomination: 1000 });
		const strict = matchLiabilities({
			universe,
			liabilities,
			lots: { ...LOT_PRESETS.institutional, minimumPosition: 500_000 },
		});
		if ("kind" in loose || "kind" in strict) throw new Error("uncoverable");
		for (const p of strict.positions)
			expect(p.faceAmount).toBeGreaterThanOrEqual(500_000);
		for (const row of strict.matching?.surplusByDate ?? [])
			expect(row.surplus).toBeGreaterThanOrEqual(-1e-6);
		expect(strict.cost).toBeGreaterThanOrEqual(loose.cost - 1);
		if (strict.positions.length < loose.positions.length)
			expect(strict.notes.join(" ")).toContain("minimum position");
	});

	test("index tracking with $1m blocks holds nothing smaller", () => {
		const krd = [0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0];
		const plan = trackIndex({
			universe,
			indexKeyRateDurations: krd,
			budget: 25_000_000,
			curve,
			settlementDate: SETTLE,
			indexName: "test",
			lots: { ...LOT_PRESETS.institutional, minimumPosition: 1_000_000 },
		});
		for (const p of plan.positions)
			expect(p.faceAmount).toBeGreaterThanOrEqual(1_000_000);
		expect(Math.abs(planRisk(plan, curve, SETTLE).duration - 6)).toBeLessThan(
			0.3,
		);
	});

	test("the increment is the step: $100 at Apex, $1,000 at a retail broker", () => {
		for (const preset of [LOT_PRESETS.apex, LOT_PRESETS.retail]) {
			const plan = buildStrategy({
				strategy: "ladder",
				universe,
				budget: 1_000_000,
				settlementDate: SETTLE,
				lots: preset,
			});
			for (const p of plan.positions)
				expect(p.faceAmount % preset.increment).toBe(0);
		}
	});

	test("a ladder rung too small for the minimum is left in cash and said so", () => {
		const plan = buildStrategy({
			strategy: "ladder",
			universe,
			budget: 1_000_000,
			settlementDate: SETTLE,
			horizonYears: 10,
			lots: LOT_PRESETS.institutional,
		});
		expect(plan.positions).toHaveLength(0);
		expect(plan.notes[0]).toContain("left in cash");
	});
});
