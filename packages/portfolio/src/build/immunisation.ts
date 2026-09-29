// PORTED VERBATIM from saferate-treasury packages/utils/src/functions/immunisation.ts at 191d25a (2026-09-29).
// Change it there first, then here; tests/build/immunisation.test.ts is ported with it.
/**
 * Immunisation: match the liability's curve exposure instead of its cashflows.
 *
 *   Redington, F. (1952). "Review of the Principles of Life-Office Valuations."
 *   Fisher, L. and Weil, R. (1971). "Coping with the Risk of Interest-Rate
 *   Fluctuations" — immunisation when the curve is not flat.
 *   Ho, T. (1992). "Key Rate Durations" — the triangular formulation used here.
 *
 * The other way to fund a liability stream. `cashflowMatching.ts` buys
 * securities whose payments arrive when the money is needed, and once bought
 * the problem is over: nothing has to be forecast and nothing has to be traded
 * again. This buys securities whose *sensitivity* to the curve equals the
 * liability's, so the two move together and the funding ratio holds.
 *
 * THE TRADE BETWEEN THE TWO, WHICH IS THE WHOLE REASON TO HAVE BOTH
 *
 * Dedication is exact and expensive. It needs a security paying on or near
 * every date, and where none exists it holds something longer and carries the
 * surplus, which costs money. Immunisation is cheap and approximate: a handful
 * of positions can match a twelve-element exposure vector, so it is far easier
 * to trade and far easier to fund. What it costs is that the match holds only
 * for small moves and only until the durations drift apart, so it has to be
 * rebalanced, and rebalancing is trading, and trading is where the cost comes
 * back. A dedicated portfolio has no reinvestment risk by construction; an
 * immunised one has residual curve risk by construction, and this module
 * reports exactly how much rather than implying there is none.
 *
 * DURATION IS MATCHED FIRST, AND THE SHAPE ONLY AFTERWARDS
 *
 * This is not a detail and the barbell test below is what forced it. Minimising
 * the squared error of the twelve-element vector on its own does *not* match
 * total duration, and where the universe cannot span the liability it produces
 * something far worse than a barbell. A ten year liability against a universe
 * of two year and thirty year strips comes out at 99.6% in the two year, since
 * that is where the squared error is smallest — a portfolio of duration 2.1
 * against a liability of duration 10, which is unhedged against the one move
 * every curve makes.
 *
 * So the duration row carries its own large weight, like the budget. Match the
 * parallel exposure first because that is the risk that dominates, then use
 * whatever freedom is left to match the shape. With that ordering the same
 * problem returns the barbell — 71% and 29%, duration exactly 10 — and the key
 * rate residual then reports the steepening risk the barbell is carrying, which
 * is the answer a practitioner wants: hedged against the big move, and told
 * precisely what is left.
 *
 * WHY KEY RATES AND NOT DURATION
 *
 * Matching a single duration number immunises against a parallel shift of the
 * curve, which is the one thing curves rarely do. The classic failure is the
 * barbell: two years and thirty years, weighted to the duration of a ten year
 * liability, looks immunised and is not — it loses on any steepening and gains
 * on any flattening, without limit, because its exposure sits at the wrong
 * points of the curve. Matching the twelve-element key rate vector removes
 * exactly that, and the tests below construct that barbell to show the residual
 * being caught rather than hidden.
 *
 * WHY NON-NEGATIVE LEAST SQUARES
 *
 * A plain least squares fit will short securities to improve the match, and for
 * the institutions that immunise — pension funds, insurers, anyone running a
 * matched book against a regulator — a short is not an available instrument.
 * `nonNegativeLeastSquares` constrains the answer to what can be held. It also
 * produces a sparse one for free: the active set method leaves most weights at
 * exactly zero, so the portfolio comes out with a handful of positions without
 * anyone asking for a position limit.
 */

import { nonNegativeLeastSquares } from "./linearAlgebra";
import { KEY_RATES } from "../risk/keyRates";

export type TImmunisationSecurity = {
	cusip: string;
	/** Dirty ask price per 100 of face. */
	askPrice: number;
	/** Key rate durations, in the order of `keyRates`. */
	keyRateDurations: number[];
};

export type TImmunisationTarget = {
	/** Present value of the liability stream, in dollars. */
	presentValue: number;
	/** Key rate durations of the liability stream, in the order of `keyRates`. */
	keyRateDurations: number[];
};

export type TImmunisationPosition = {
	cusip: string;
	/** Share of the portfolio's market value. */
	weight: number;
	/** Market value, in dollars. */
	marketValue: number;
	/** Face amount to buy, in dollars. */
	faceValue: number;
};

export type TImmunisationResult = {
	positions: TImmunisationPosition[];
	/** Market value of the portfolio, which should equal the target's. */
	presentValue: number;
	/** Achieved key rate durations, market-value weighted. */
	keyRateDurations: number[];
	/**
	 * Achieved less target, per key rate, in years.
	 *
	 * The residual curve risk, and the number that distinguishes this from
	 * dedication. Zero everywhere means the portfolio moves exactly as the
	 * liability does for any small curve move; anything else names which part of
	 * the curve is unhedged and in which direction.
	 */
	keyRateResidual: number[];
	/**
	 * Dollars gained or lost per basis point at each key rate, net of the
	 * liability.
	 *
	 * The residual vector in money, which is what a risk report shows. Sums to
	 * roughly zero on a duration-matched portfolio even when the individual
	 * entries are large, which is precisely the barbell trap.
	 */
	residualDv01: number[];
	/** Achieved total duration less target duration, in years. */
	durationResidual: number;
	/** True if the underlying solver met its optimality conditions. */
	converged: boolean;
};

/**
 * Build the immunising portfolio.
 *
 * The system solved is `sum_i w_i (KRD_i - KRD_target) = 0` subject to
 * `sum_i w_i = 1` and `w >= 0`, which is a convex combination of the securities
 * whose blended exposure matches the liability's. Expressing it as differences
 * rather than levels is what makes the target vector zero and the budget the
 * only row with a right hand side, which keeps the problem well scaled: key
 * rate durations run from zero to thirty while weights sum to one, and mixing
 * those in one least squares without the subtraction lets the long end dominate
 * for no reason but its units.
 */
export const immunise = ({
	securities,
	target,
	keyRates = KEY_RATES,
	budgetWeight = 1_000,
	durationWeight = 100,
}: {
	securities: TImmunisationSecurity[];
	target: TImmunisationTarget;
	keyRates?: readonly number[];
	/**
	 * How hard the weights are held to summing to one.
	 *
	 * Large, because a portfolio that does not fund the liability is not a
	 * candidate however well it matches the exposure. It is a weight rather than
	 * a hard constraint so that an unfundable request degrades visibly instead
	 * of failing, and the achieved present value is returned for checking.
	 */
	budgetWeight?: number;
	/**
	 * How hard total duration is matched, relative to the shape.
	 *
	 * See the module header: without this the fit abandons the parallel exposure
	 * to chase the shape, which is the wrong way round. Lowering it towards zero
	 * recovers the pure vector fit and is almost never what anyone wants;
	 * raising it makes duration effectively exact and pushes all the error into
	 * the shape, which is the classic barbell.
	 */
	durationWeight?: number;
}): TImmunisationResult => {
	const usable = securities.filter(
		(security) => security.askPrice > 0 && security.keyRateDurations.length > 0,
	);
	const n = usable.length;
	const empty: TImmunisationResult = {
		positions: [],
		presentValue: 0,
		keyRateDurations: keyRates.map(() => 0),
		keyRateResidual: keyRates.map((_, k) => -(target.keyRateDurations[k] ?? 0)),
		residualDv01: keyRates.map(
			(_, k) => (-(target.keyRateDurations[k] ?? 0) * target.presentValue) / 10000,
		),
		durationResidual: -target.keyRateDurations.reduce(
			(sum, value) => sum + value,
			0,
		),
		converged: false,
	};
	if (n === 0 || !(target.presentValue > 0)) return empty;

	// One row per key rate holding the exposure difference, then the budget row.
	const a: number[][] = keyRates.map((_, k) =>
		usable.map(
			(security) =>
				(security.keyRateDurations[k] ?? 0) - (target.keyRateDurations[k] ?? 0),
		),
	);
	// Total duration, weighted so it is matched before the shape is.
	const targetDuration = keyRates.reduce(
		(sum, _, k) => sum + (target.keyRateDurations[k] ?? 0),
		0,
	);
	a.push(
		usable.map(
			(security) =>
				durationWeight *
				(security.keyRateDurations.reduce((sum, value) => sum + value, 0) -
					targetDuration),
		),
	);
	a.push(usable.map(() => budgetWeight));
	const b = [...keyRates.map(() => 0), 0, budgetWeight];

	const solved = nonNegativeLeastSquares({ a, b });
	const total = solved.x.reduce((sum, value) => sum + value, 0);
	if (!(total > 0)) return empty;

	// Renormalise so the budget holds exactly. The weight above makes the
	// solver respect it to a rounding error already; dividing through removes
	// the rounding error rather than leaving the caller to notice it, and it
	// cannot change the exposure match because scaling every weight scales the
	// whole exposure vector by the same factor.
	const weights = solved.x.map((value) => value / total);

	const achieved = keyRates.map((_, k) =>
		usable.reduce(
			(sum, security, i) => sum + weights[i] * (security.keyRateDurations[k] ?? 0),
			0,
		),
	);
	const keyRateResidual = achieved.map(
		(value, k) => value - (target.keyRateDurations[k] ?? 0),
	);

	const positions = usable
		.map((security, i) => ({
			cusip: security.cusip,
			weight: weights[i],
			marketValue: weights[i] * target.presentValue,
			faceValue: (weights[i] * target.presentValue * 100) / security.askPrice,
		}))
		// Anything under a hundredth of a basis point of the book is arithmetic
		// residue rather than a holding, and reporting it overstates the position
		// count that makes immunisation attractive in the first place.
		.filter((position) => position.weight > 1e-6);

	return {
		positions,
		presentValue: positions.reduce(
			(sum, position) => sum + position.marketValue,
			0,
		),
		keyRateDurations: achieved,
		keyRateResidual,
		residualDv01: keyRateResidual.map(
			(value) => (value * target.presentValue) / 10000,
		),
		durationResidual: keyRateResidual.reduce((sum, value) => sum + value, 0),
		converged: solved.converged,
	};
};
