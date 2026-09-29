// PORTED VERBATIM from saferate-treasury packages/utils/src/functions/portfolioStress.ts at 191d25a (2026-09-29).
// Change it there first, then here; tests/risk/portfolioStress.test.ts is ported with it.
/**
 * What a portfolio is worth under a curve that did not happen.
 *
 * `shockPortfolio` in `portfolioAnalytics.ts` answers this from durations, and
 * `simulateHistorical` builds its distribution the same way. Both are first
 * order with a convexity correction bolted on, which is the right trade for a
 * one-day move measured a hundred thousand times. It is the wrong trade for the
 * scenarios anybody actually asks about, because those are large by
 * construction: nobody stress tests a portfolio at five basis points.
 *
 * So everything here reprices. Each cashflow is discounted at its own shocked
 * zero rate, which costs a pass over the schedule and is exact at any size of
 * move, for any shape, including ones where duration and convexity disagree
 * about the answer.
 *
 * WHY THE SHOCK IS INTERPOLATED WITH THE KEY RATE TRIANGLES
 *
 * A scenario arrives as a shift at each of twelve key rates and has to become a
 * shift at every maturity a cashflow lands on. The interpolation used is
 * `keyRateBumpWeight`, the same triangular shape the key rate durations are
 * defined by, and that is not a detail. Any other interpolation would make a
 * scenario and its own first-order approximation describe *different* curve
 * moves, and the gap between them — which this module reports as the second
 * order term, meaning convexity — would silently include an interpolation
 * mismatch instead. Sharing the shape means `secondOrder` is convexity and
 * nothing else, and the tests assert the two agree in the limit of a small move.
 *
 * Because the triangles sum to one at every maturity, shifting all twelve key
 * rates by the same amount is exactly a parallel shift of the curve. That is
 * asserted too, and it is the cheapest check that the interpolation is intact.
 */

import type { TCurveParams as TNSSParameters } from "../curve";
import type { TPortfolioHolding } from "./keyRates";
import { KEY_RATES, keyRateBumpWeight } from "./keyRates";
import { zeroRate } from "../curve";

export type TStressScenario = {
	name: string;
	/**
	 * Shift at each key rate in basis points, in the order of `keyRates`.
	 *
	 * Shorter than the key rates is padded with zeros rather than rejected, so a
	 * scenario that only touches the front end can be written as a short array.
	 */
	shiftBasisPoints: number[];
};

/**
 * The zero rate at a maturity once a key rate scenario is applied, as a percent.
 *
 * The shift is spread across maturities by the key rate triangles, so at a key
 * rate itself the answer is exactly the base rate plus that key rate's shift.
 */
export const shockedZeroRate = ({
	curve,
	time,
	shiftBasisPoints,
	keyRates = KEY_RATES,
}: {
	curve: TNSSParameters;
	time: number;
	shiftBasisPoints: number[];
	keyRates?: readonly number[];
}): number => {
	let shift = 0;
	for (let k = 0; k < keyRates.length; k++) {
		const move = shiftBasisPoints[k] ?? 0;
		if (move !== 0) shift += move * keyRateBumpWeight(time, k, keyRates);
	}
	// Shifts arrive in basis points and `zeroRate` speaks percent.
	return zeroRate(curve, time) + shift / 100;
};

/**
 * Value the holdings by discounting every cashflow at its own shocked rate.
 *
 * `ageBy` shifts each cashflow's discount time, for valuing a book forward in
 * time as well as under a different curve. Cashflows that have fallen due by
 * then are excluded rather than discounted at a negative time; a caller that
 * wants them should add them back as cash, which is what the attribution
 * module does.
 */
export const repriceHoldings = ({
	holdings,
	curve,
	shiftBasisPoints = [],
	keyRates = KEY_RATES,
	ageBy = 0,
}: {
	holdings: TPortfolioHolding[];
	curve: TNSSParameters;
	shiftBasisPoints?: number[];
	keyRates?: readonly number[];
	ageBy?: number;
}): number => {
	let value = 0;
	for (const holding of holdings) {
		const scale = holding.faceValue / 100;
		for (let i = 0; i < holding.payments.length; i++) {
			const time = holding.paymentsExps[i] - ageBy;
			if (time <= 0) continue;
			const rate = shockedZeroRate({
				curve,
				time,
				shiftBasisPoints,
				keyRates,
			});
			value += scale * holding.payments[i] * Math.exp((-rate / 100) * time);
		}
	}
	return value;
};

export type TStressResult = {
	name: string;
	/** Repriced value of the book under the scenario, in dollars. */
	value: number;
	/** Value less the base value. Negative is a loss. */
	profitAndLoss: number;
	/** What key rate durations alone predict, in dollars. */
	firstOrder: number;
	/**
	 * Repriced less predicted, which for a long book is a gain either way.
	 *
	 * This is convexity and only convexity, because the scenario and the
	 * first-order estimate are built on the same interpolation. A book that is
	 * short convexity — sold options, or a barbell financed by a bullet — shows
	 * a negative number here, and that is the number the whole exercise exists
	 * to surface, since it is invisible in duration.
	 */
	secondOrder: number;
	/** Loss as a fraction of the base value; null if the book is worth nothing. */
	returnFraction: number | null;
};

/**
 * Reprice a book under every scenario, against its own base valuation.
 *
 * The base is the repriced value with no shift, not the observed market value,
 * and the difference matters. Using the market value would fold every
 * security's richness or cheapness into the first scenario's profit and loss,
 * where it would look like a curve effect. Relative value belongs in
 * attribution, not in a stress test.
 */
export const stressPortfolio = ({
	holdings,
	curve,
	scenarios,
	keyRateDurations,
	keyRates = KEY_RATES,
}: {
	holdings: TPortfolioHolding[];
	curve: TNSSParameters;
	scenarios: TStressScenario[];
	/**
	 * Book key rate durations for the first-order comparison. Omitted, they are
	 * derived by repricing the book against a one basis point bump at each key
	 * rate, which is exact and costs one pass per key rate.
	 */
	keyRateDurations?: number[];
	keyRates?: readonly number[];
}): { baseValue: number; results: TStressResult[] } => {
	const baseValue = repriceHoldings({ holdings, curve, keyRates });

	const durations =
		keyRateDurations ??
		keyRates.map((_, k) => {
			if (baseValue === 0) return 0;
			const bumped = repriceHoldings({
				holdings,
				curve,
				keyRates,
				shiftBasisPoints: keyRates.map((__, j) => (j === k ? 1 : 0)),
			});
			// A one basis point bump moves value by duration times value times
			// 1e-4, so the duration is the relative move scaled back up.
			return (-(bumped - baseValue) / baseValue) * 10000;
		});

	const results = scenarios.map((scenario) => {
		const value = repriceHoldings({
			holdings,
			curve,
			keyRates,
			shiftBasisPoints: scenario.shiftBasisPoints,
		});
		const profitAndLoss = value - baseValue;
		// Subtracted from zero rather than negated, so a scenario that moves
		// nothing reports positive zero. `-0` compares equal to zero but formats
		// as "-0.00", which in a stress report reads as a rounded-away loss.
		const firstOrder =
			0 -
			durations.reduce(
				(sum, duration, k) =>
					sum + duration * baseValue * ((scenario.shiftBasisPoints[k] ?? 0) / 10000),
				0,
			);
		return {
			name: scenario.name,
			value,
			profitAndLoss,
			firstOrder,
			secondOrder: profitAndLoss - firstOrder,
			returnFraction: baseValue === 0 ? null : profitAndLoss / baseValue,
		};
	});

	return { baseValue, results };
};

/**
 * The scenarios a rates book is normally run against.
 *
 * Parallel moves in both directions because convexity makes them asymmetric,
 * and four curve reshapes because a parallel move is the one thing a curve
 * almost never does. The steepeners and flatteners are split into bull and bear
 * versions — which end of the curve moves is a different position from which
 * way the spread goes, and a book can be right about one and wrong about the
 * other.
 */
export const standardScenarios = (
	keyRates: readonly number[] = KEY_RATES,
): TStressScenario[] => {
	const flat = (basisPoints: number) => keyRates.map(() => basisPoints);
	// Front end is anything inside two years, long end beyond ten, with the
	// belly untouched so a steepener is not secretly a butterfly.
	const front = (basisPoints: number) =>
		keyRates.map((time) => (time <= 2 ? basisPoints : 0));
	const back = (basisPoints: number) =>
		keyRates.map((time) => (time >= 10 ? basisPoints : 0));

	return [
		{ name: "parallel +300", shiftBasisPoints: flat(300) },
		{ name: "parallel +100", shiftBasisPoints: flat(100) },
		{ name: "parallel +50", shiftBasisPoints: flat(50) },
		{ name: "parallel -50", shiftBasisPoints: flat(-50) },
		{ name: "parallel -100", shiftBasisPoints: flat(-100) },
		{ name: "parallel -300", shiftBasisPoints: flat(-300) },
		{
			name: "bear steepener +100 long",
			shiftBasisPoints: back(100),
		},
		{
			name: "bull steepener -100 front",
			shiftBasisPoints: front(-100),
		},
		{
			name: "bear flattener +100 front",
			shiftBasisPoints: front(100),
		},
		{
			name: "bull flattener -100 long",
			shiftBasisPoints: back(-100),
		},
		{
			name: "butterfly, belly +50",
			shiftBasisPoints: keyRates.map((time) => (time > 2 && time < 10 ? 50 : -25)),
		},
	];
};

/**
 * A scenario built from what the curve actually did between two dates.
 *
 * Historical replay, and the honest kind: the shift is read off the two fitted
 * curves at the key rates rather than described in words, so "the 2020 rally"
 * is whatever the curve did rather than somebody's memory of it. Feeding this
 * back through `stressPortfolio` reprices today's book under a past move, which
 * is the question a risk committee asks.
 */
export const scenarioFromCurves = ({
	name,
	startCurve,
	endCurve,
	keyRates = KEY_RATES,
}: {
	name: string;
	startCurve: TNSSParameters;
	endCurve: TNSSParameters;
	keyRates?: readonly number[];
}): TStressScenario => ({
	name,
	shiftBasisPoints: keyRates.map(
		(time) => (zeroRate(endCurve, time) - zeroRate(startCurve, time)) * 100,
	),
});
