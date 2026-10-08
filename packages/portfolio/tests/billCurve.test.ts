import { expect, test } from "bun:test";
import {
	billDiscountFactor,
	billRate,
	breakevenReinvestmentRate,
	forwardBillRate,
	growthAt,
	rollAtForwards,
} from "../src/billCurve";

/* treasury's money_market_curves row for 2026-10-07, as stored. */
const curve = {
	beta0: 4.449264664880572,
	beta1: -0.6333078644376655,
	beta2: -1.8284199624204917e-8,
	lambda: 0.16512535903438963,
};
const stored = [
	[1 / 12, 3.951955084549289],
	[0.25, 4.1230017118201365],
	[0.5, 4.250239722335413],
	[0.75, 4.3113163287111815],
	[1, 4.34493457104122],
] as const;

test("the ported curve reproduces treasury's stored tenor rates", () => {
	for (const [years, rate] of stored)
		expect(billRate(curve, years)).toBeCloseTo(rate, 10);
});

test("rolling at the forwards matches holding one bill to the horizon", () => {
	for (const term of [4 / 52, 0.25, 0.5]) {
		const roll = rollAtForwards({ curve, termYears: term, horizonYears: 1 });
		expect(roll.growth).toBeCloseTo(1 / billDiscountFactor(curve, 1), 12);
	}
});

test("on an upward curve each forward is above today's rate, and rolling below them loses", () => {
	const roll = rollAtForwards({ curve, termYears: 0.25, horizonYears: 1 });
	expect(roll.steps.map((s) => s.startYears)).toEqual([0, 0.25, 0.5, 0.75]);
	expect(roll.steps[1].pricedRate).toBeGreaterThan(roll.steps[0].pricedRate);
	const lower = rollAtForwards({
		curve,
		termYears: 0.25,
		horizonYears: 1,
		shiftBp: -50,
	});
	expect(lower.ratePercent).toBeLessThan(roll.ratePercent);
	// The first roll is bought today, so a shift never touches it.
	expect(lower.steps[0].assumedRate).toBe(roll.steps[0].assumedRate);
});

test("the breakeven rate makes the roll and the one-year bill equal", () => {
	const breakeven = breakevenReinvestmentRate({
		curve,
		termYears: 0.25,
		horizonYears: 1,
	});
	const first = growthAt(forwardBillRate(curve, 0, 0.25), 0.25);
	expect(first * growthAt(breakeven, 0.75)).toBeCloseTo(
		1 / billDiscountFactor(curve, 1),
		12,
	);
	expect(breakeven).toBeGreaterThan(billRate(curve, 0.25));
});
