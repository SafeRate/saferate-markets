// PORTED VERBATIM from saferate-treasury packages/utils/src/functions/volatilityModels.ts at 191d25a (2026-09-29).
// Change it there first, then here; tests/risk/volatilityModels.test.ts is its own test file, ported with it.
/**
 * Conditional volatility and tail models for the risk work.
 *
 * Two ideas, both from the standard time series treatment of financial data —
 * Tsay's Analysis of Financial Time Series is the reference for each — and both
 * addressing a specific weakness in what the simulation currently does.
 *
 * GARCH replaces the exponentially weighted volatility used until now. That
 * estimator is not wrong so much as assumed: RiskMetrics' EWMA is exactly a
 * GARCH(1,1) with the intercept forced to zero and the persistence forced to
 * one, which asserts that volatility has no long run level and never returns to
 * it. Rates do return to a level. Estimating the three parameters rather than
 * fixing two of them lets the data say so.
 *
 * Extreme value theory replaces resampling in the far tail. Filtered historical
 * simulation can only produce losses it has seen, so the worst outcome it will
 * ever report is the worst that happened, and beyond about the 99th percentile
 * it is describing a handful of days rather than a distribution. Fitting a
 * generalised Pareto to the exceedances gives the tail a shape, which is the
 * one place where a parametric assumption buys more than it costs.
 */

import { nelderMead } from "./nelderMead";

export type TGarchParameters = {
	/** Long run variance level, per period. */
	omega: number;
	/** Weight on the last squared shock. */
	alpha: number;
	/** Weight on the last variance. */
	beta: number;
	/** Sum of alpha and beta: how slowly a shock decays. */
	persistence: number;
	/** Variance the process reverts to, omega / (1 - persistence). */
	longRunVariance: number;
	logLikelihood: number;
};

/**
 * Variance path implied by a set of parameters.
 *
 * Entry `i` is the variance forecast for observation `i` made from everything
 * before it, so it can be used to standardise that observation without the
 * observation informing its own scale.
 */
export const garchVariance = (
	returns: number[],
	{ omega, alpha, beta }: { omega: number; alpha: number; beta: number },
): number[] => {
	if (returns.length === 0) return [];
	const persistence = alpha + beta;
	// Start at the unconditional variance where one exists, and at the sample
	// variance where the process is not stationary.
	const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
	const sample =
		returns.reduce((a, b) => a + (b - mean) ** 2, 0) /
		Math.max(returns.length - 1, 1);
	let variance = persistence < 1 ? omega / (1 - persistence) : sample;
	if (!(variance > 0)) variance = sample;

	const out: number[] = [];
	for (const value of returns) {
		out.push(variance);
		variance = omega + alpha * value * value + beta * variance;
	}
	return out;
};

/**
 * Fit GARCH(1,1) by maximum likelihood.
 *
 * Parameters are optimised in an unconstrained space and mapped back, which is
 * how the constraints are enforced without the optimiser ever seeing them:
 * omega through an exponential so it stays positive, and alpha and beta through
 * a softmax-style share of a logistic so that both stay non-negative and their
 * sum stays below one. A simplex walking into an inadmissible region is the
 * usual way these fits fail.
 */
export const fitGarch = (
	returns: number[],
	maxIterations = 2000,
): TGarchParameters => {
	if (returns.length < 100) {
		throw new Error(
			`GARCH needs a meaningful sample; received ${returns.length} observations`,
		);
	}
	const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
	const centred = returns.map((r) => r - mean);
	const sample =
		centred.reduce((a, b) => a + b * b, 0) / Math.max(centred.length - 1, 1);

	// Unconstrained -> constrained.
	const unpack = (x: number[]) => {
		const persistence = 1 / (1 + Math.exp(-x[1]));
		const share = 1 / (1 + Math.exp(-x[2]));
		const alpha = persistence * share;
		const beta = persistence * (1 - share);
		return { omega: Math.exp(x[0]), alpha, beta };
	};

	const negativeLogLikelihood = (x: number[]): number => {
		const p = unpack(x);
		if (!Number.isFinite(p.omega) || p.omega <= 0) return 1e12;
		const variances = garchVariance(centred, p);
		let total = 0;
		for (let i = 0; i < centred.length; i++) {
			const v = variances[i];
			if (!(v > 0) || !Number.isFinite(v)) return 1e12;
			total += Math.log(v) + (centred[i] * centred[i]) / v;
		}
		return Number.isFinite(total) ? 0.5 * total : 1e12;
	};

	// Start near the values RiskMetrics assumes, which is a sensible region even
	// though the point of fitting is not to end up there.
	const start = [
		Math.log(sample * 0.05),
		Math.log(0.94 / (1 - 0.94)),
		Math.log(0.06 / 0.94),
	];
	const solved = nelderMead(negativeLogLikelihood, start, maxIterations);
	const best = unpack(solved.x);
	const persistence = best.alpha + best.beta;

	return {
		...best,
		persistence,
		longRunVariance: persistence < 1 ? best.omega / (1 - persistence) : sample,
		logLikelihood: -(solved.fx + 0.5 * centred.length * Math.log(2 * Math.PI)),
	};
};

export type TTailFit = {
	/** Threshold above which the tail model applies, as a positive loss. */
	threshold: number;
	/** Generalised Pareto scale. */
	scale: number;
	/**
	 * Generalised Pareto shape. Above zero the tail is heavy and has no finite
	 * upper limit, which is the usual finding for financial losses; below zero
	 * it is bounded.
	 */
	shape: number;
	exceedances: number;
	total: number;
};

/**
 * Fit a generalised Pareto to losses beyond a threshold.
 *
 * The peaks over threshold approach. Pickands, Balkema and de Haan give the
 * result that makes it respectable: for a wide class of distributions, the
 * excess over a high enough threshold converges to a generalised Pareto
 * whatever the parent distribution is. So the tail can be modelled without
 * committing to a shape for the body, which is the opposite of assuming
 * normality everywhere and is why this is worth doing.
 *
 * `losses` are positive numbers; feed it the negated profit and loss.
 */
export const fitTail = (
	losses: number[],
	/** Share of the sample treated as tail. Ten percent is the usual choice. */
	tailFraction = 0.1,
): TTailFit => {
	const sorted = [...losses].sort((a, b) => a - b);
	const cut = Math.max(1, Math.floor(sorted.length * (1 - tailFraction)));
	const threshold = sorted[cut - 1];
	const excess = sorted
		.slice(cut)
		.map((v) => v - threshold)
		.filter((v) => v > 0);

	if (excess.length < 20) {
		throw new Error(
			`Tail fitting needs at least twenty exceedances; found ${excess.length}`,
		);
	}

	const negativeLogLikelihood = (x: number[]): number => {
		const scale = Math.exp(x[0]);
		const shape = x[1];
		let total = 0;
		for (const value of excess) {
			const z = (shape * value) / scale;
			if (z <= -1) return 1e12;
			total +=
				Math.log(scale) +
				(Math.abs(shape) < 1e-8
					? value / scale
					: (1 + 1 / shape) * Math.log(1 + z));
		}
		return Number.isFinite(total) ? total : 1e12;
	};

	const mean = excess.reduce((a, b) => a + b, 0) / excess.length;
	const solved = nelderMead(negativeLogLikelihood, [Math.log(mean), 0.1], 2000);

	return {
		threshold,
		scale: Math.exp(solved.x[0]),
		shape: solved.x[1],
		exceedances: excess.length,
		total: losses.length,
	};
};

/**
 * Value at risk and expected shortfall from a fitted tail.
 *
 * Beyond the threshold this reads off the generalised Pareto rather than the
 * sample, so it can report a loss larger than any that has happened — which is
 * the entire point. A resampling estimator cannot, and quietly reports the
 * worst observed day as though it were the worst possible one.
 */
export const tailRisk = (
	fit: TTailFit,
	confidence: number,
): { valueAtRisk: number; expectedShortfall: number } => {
	if (!(confidence > 0 && confidence < 1)) {
		throw new Error("Confidence must lie strictly between zero and one");
	}
	const exceedanceRate = fit.exceedances / fit.total;
	const tailProbability = 1 - confidence;
	if (tailProbability > exceedanceRate) {
		throw new Error(
			`Confidence ${confidence} sits inside the body of the distribution; this model only describes the far ${(exceedanceRate * 100).toFixed(1)}%`,
		);
	}

	const ratio = tailProbability / exceedanceRate;
	const { threshold, scale, shape } = fit;
	const valueAtRisk =
		Math.abs(shape) < 1e-8
			? threshold + scale * -Math.log(ratio)
			: threshold + (scale / shape) * (ratio ** -shape - 1);

	// The mean beyond the quantile has a closed form, and only exists where the
	// shape is below one; a heavier tail than that has infinite expectation.
	const expectedShortfall =
		shape >= 1
			? Number.POSITIVE_INFINITY
			: (valueAtRisk + (scale - shape * threshold)) / (1 - shape);

	return { valueAtRisk, expectedShortfall };
};
