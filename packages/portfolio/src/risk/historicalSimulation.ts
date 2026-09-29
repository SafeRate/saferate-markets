// PORTED VERBATIM from saferate-treasury packages/utils/src/functions/historicalSimulation.ts at 191d25a (2026-09-29).
// Change it there first, then here; tests/risk/historicalSimulation.test.ts is its own test file, ported with it.
/**
 * Filtered historical simulation of curve risk.
 *
 * The alternative most tools reach for is to fit a normal distribution to each
 * curve factor and draw from it. Measured on this history that is wrong in the
 * direction that matters: the level factor has kurtosis 6.3 against the normal's
 * 3.0, the slope factor 79.8, and the worst observed slope day sits 18.2
 * standard deviations out — an event a normal distribution assigns a
 * probability around 1e-73. A Gaussian model understates exactly the moves that
 * value at risk exists to measure.
 *
 * So the scenarios here are real days, not draws from a curve. Two refinements
 * make that work:
 *
 * Whole days are sampled at once, never one tenor at a time, which preserves
 * the correlation between tenors without anyone having to estimate it.
 *
 * And each day is standardised by the volatility prevailing when it happened,
 * then rescaled to today's. Without that the sample mixes regimes: a sixty
 * basis point day from 2008 and a three basis point day from 2019 are not
 * alternative versions of tomorrow. Dividing each out and rescaling means the
 * sample contributes its *shape* while today's volatility sets the magnitude.
 */

import { fitGarch, fitTail, garchVariance, tailRisk } from "./volatilityModels";

/** RiskMetrics' decay for daily data. Higher is slower to react. */
export const EWMA_LAMBDA = 0.94;

/**
 * How the conditional volatility used for standardising is estimated.
 *
 * `ewma` is RiskMetrics: a fixed decay, no intercept, persistence pinned at
 * one. That last part is the assumption worth noticing — it says volatility has
 * no long run level to return to, so a shock never fully decays. Rates do
 * return to a level.
 *
 * `garch` estimates the three parameters rather than fixing two of them. EWMA
 * is the special case where omega is zero and alpha plus beta is one, so this
 * can only fit at least as well; where it fits no better the estimates simply
 * come back near the RiskMetrics values.
 *
 * GARCH is the default because it measurably calibrates better. Backtested over
 * 4,249 days on the same portfolio, exponential weighting breaches the one day
 * 99% value at risk 1.13% of the time and GARCH 1.01%, against a target of
 * 1.00%; the Kupiec statistic falls from 0.69 to 0.01 and the ratio of realised
 * to predicted shortfall moves from 0.981 to 1.005. On this data the fitted
 * persistence comes back at 0.9981 rather than the assumed 1.0, with a long run
 * daily volatility of 9.07 basis points — a level EWMA cannot express at all.
 *
 * It costs about twenty times the compute, which is 0.6 seconds against 0.03
 * for the whole history. Irrelevant here, and worth knowing before it is put
 * somewhere it matters.
 */
export type TVolatilityModel = "ewma" | "garch";

/**
 * How the far tail of the simulated distribution is read.
 *
 * `empirical` takes the quantile straight from the sampled paths. Simple,
 * assumption free, and bounded by construction: it can never report a loss
 * larger than the worst path it drew, so "how bad could it get" is always
 * answered "about as bad as the worst thing that already happened". Past the
 * 99th percentile it is describing a few dozen draws, not a distribution.
 *
 * `extreme-value` fits a generalised Pareto to losses beyond a high threshold
 * and reads the quantile from that. Pickands, Balkema and de Haan give the
 * licence: for a broad class of parents, the excess over a high enough
 * threshold converges to a generalised Pareto whatever the parent is. The tail
 * gets a shape without the body needing one, which is the opposite of assuming
 * a distribution everywhere and is the one place a parametric assumption buys
 * more than it costs.
 */
export type TTailModel = "empirical" | "extreme-value";

/**
 * Exponentially weighted volatility, one estimate per observation.
 *
 * Entry `i` is the volatility estimated from everything strictly before `i`, so
 * it can be used to standardise observation `i` without the observation
 * informing its own scale.
 */
export const ewmaVolatility = ({
	changes,
	lambda = EWMA_LAMBDA,
	seed,
}: {
	changes: number[];
	lambda?: number;
	/** Starting variance; defaults to the variance of the whole sample. */
	seed?: number;
}): number[] => {
	if (changes.length === 0) return [];
	if (!(lambda > 0 && lambda < 1)) {
		throw new Error("EWMA lambda must lie strictly between 0 and 1");
	}

	const mean = changes.reduce((sum, value) => sum + value, 0) / changes.length;
	const sampleVariance =
		changes.length > 1
			? changes.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
				(changes.length - 1)
			: 0;

	let variance = seed ?? sampleVariance;
	const out: number[] = [];
	for (const change of changes) {
		out.push(Math.sqrt(variance));
		variance = lambda * variance + (1 - lambda) * change * change;
	}
	return out;
};

export type TScenarioSet = {
	/**
	 * Standardised historical days, one row per day, one column per tenor.
	 * Multiply by a volatility vector to get a usable scenario.
	 */
	standardised: number[][];
	/** Latest volatility estimate per tenor, in the units of the input. */
	currentVolatility: number[];
	/** Dates of the retained rows, aligned with `standardised`. */
	dates: string[];
};

/** A tiny deterministic generator, so a run can be reproduced and tested. */
const mulberry32 = (seed: number) => {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/**
 * Turn a history of curve levels into standardised daily scenarios.
 *
 * Rows are consecutive observations of the same tenors. Gaps longer than
 * `maxGapDays` are dropped rather than differenced, so a missing week does not
 * enter the sample as one enormous day.
 */
export const buildScenarios = ({
	dates,
	levels,
	lambda = EWMA_LAMBDA,
	maxGapDays = 5,
	model = "garch",
}: {
	dates: string[];
	/** One row per date, one column per tenor, in any consistent unit. */
	levels: number[][];
	lambda?: number;
	maxGapDays?: number;
	/** Which conditional volatility estimator to standardise by. */
	model?: TVolatilityModel;
}): TScenarioSet => {
	if (dates.length !== levels.length) {
		throw new Error("dates and levels must be the same length");
	}
	if (levels.length < 2) {
		throw new Error("Need at least two observations to difference");
	}

	const tenors = levels[0].length;
	const changes: number[][] = [];
	const kept: string[] = [];
	for (let i = 1; i < levels.length; i++) {
		const gap =
			(Date.parse(`${dates[i]}T00:00:00Z`) -
				Date.parse(`${dates[i - 1]}T00:00:00Z`)) /
			86_400_000;
		if (!(gap > 0) || gap > maxGapDays) continue;
		changes.push(levels[i].map((value, j) => value - levels[i - 1][j]));
		kept.push(dates[i]);
	}
	if (changes.length === 0) {
		throw new Error("No consecutive observations survived the gap filter");
	}

	// One volatility path per tenor, then standardise each day by the volatility
	// that prevailed on it. Sampling whole rows afterwards keeps the tenors'
	// co-movement intact.
	const volatility: number[][] = [];
	const currentVolatility: number[] = [];
	for (let j = 0; j < tenors; j++) {
		const column = changes.map((row) => row[j]);

		if (model === "garch") {
			// Falls back to the exponential weighting rather than throwing: a
			// tenor with too little history should still produce scenarios.
			try {
				const fitted = fitGarch(column);
				const path = garchVariance(column, fitted).map(Math.sqrt);
				const last = column[column.length - 1];
				const next =
					fitted.omega +
					fitted.alpha * last * last +
					fitted.beta * path[path.length - 1] ** 2;
				volatility.push(path);
				currentVolatility.push(Math.sqrt(next));
				continue;
			} catch {}
		}

		const path = ewmaVolatility({ changes: column, lambda });
		volatility.push(path);
		let variance = path[path.length - 1] ** 2;
		const last = column[column.length - 1];
		variance = lambda * variance + (1 - lambda) * last * last;
		currentVolatility.push(Math.sqrt(variance));
	}

	const standardised = changes.map((row, i) =>
		row.map((value, j) => {
			const sigma = volatility[j][i];
			// A tenor that has not moved at all has no scale; leaving the raw
			// change would let one flat stretch dominate the sample.
			return sigma > 1e-12 ? value / sigma : 0;
		}),
	);

	return { standardised, currentVolatility, dates: kept };
};

export type TSimulationResult = {
	/** Sorted ascending, so the left tail is at the front. */
	profitAndLoss: number[];
	/** Loss not exceeded with the stated confidence, reported positive. */
	valueAtRisk95: number;
	valueAtRisk99: number;
	/**
	 * Mean loss given the threshold is breached, reported positive.
	 *
	 * The more informative of the two measures. Value at risk says where the bad
	 * region starts and nothing about what is inside it, so two portfolios with
	 * the same value at risk can hide very different cliffs; shortfall averages
	 * the losses beyond the threshold and sees them.
	 */
	expectedShortfall95: number;
	expectedShortfall99: number;
	mean: number;
	standardDeviation: number;
	/** Excess over the normal's 3.0, as evidence the tails survived. */
	kurtosis: number;
	/**
	 * Shape of the fitted generalised Pareto, or null where the tail was read
	 * empirically. Above zero means a heavy tail with no finite worst case,
	 * which is the usual finding and is worth surfacing rather than burying.
	 */
	tailShape: number | null;
};

const quantile = (sorted: number[], p: number): number => {
	const position = (sorted.length - 1) * p;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return sorted[lower];
	return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
};

/**
 * Sample scenarios and value them against a portfolio's key rate exposure.
 *
 * Profit and loss is the dot product of the key rate DV01 vector with the
 * simulated move, which is why this is fast enough to run interactively: no
 * repricing, one multiply-add per tenor per path.
 *
 * A horizon longer than a day samples that many *consecutive* days rather than
 * scaling by the square root of time. Consecutive sampling keeps whatever
 * momentum or reversal the history holds; the square root rule assumes
 * independence that rate moves do not have.
 */
export const simulateHistorical = ({
	scenarios,
	keyRateDv01,
	paths = 100_000,
	horizonDays = 1,
	seed = 1,
	tail = "empirical",
}: {
	scenarios: TScenarioSet;
	/** Dollars per basis point at each tenor, aligned with the scenario columns. */
	keyRateDv01: number[];
	paths?: number;
	horizonDays?: number;
	seed?: number;
	/** How to read the far tail; see TTailModel. */
	tail?: TTailModel;
}): TSimulationResult => {
	const { standardised, currentVolatility } = scenarios;
	const tenors = currentVolatility.length;
	if (keyRateDv01.length !== tenors) {
		throw new Error(
			`keyRateDv01 has ${keyRateDv01.length} entries, scenarios have ${tenors} tenors`,
		);
	}
	if (horizonDays < 1 || !Number.isInteger(horizonDays)) {
		throw new Error("horizonDays must be a positive whole number");
	}
	if (standardised.length < horizonDays) {
		throw new Error("Not enough history for that horizon");
	}

	// Fold volatility into the exposure once rather than per path.
	const scaled = keyRateDv01.map((dv01, j) => dv01 * currentVolatility[j]);
	const random = mulberry32(seed);
	const starts = standardised.length - horizonDays + 1;

	const results = new Float64Array(paths);
	for (let path = 0; path < paths; path++) {
		const start = Math.floor(random() * starts);
		let move = 0;
		for (let day = start; day < start + horizonDays; day++) {
			const row = standardised[day];
			for (let j = 0; j < tenors; j++) move += scaled[j] * row[j];
		}
		// Rates up is a loss for a long position, hence the sign.
		results[path] = -move;
	}

	const sorted = Array.from(results).sort((a, b) => a - b);
	const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
	const variance =
		sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
		(sorted.length - 1);
	const standardDeviation = Math.sqrt(variance);
	const kurtosis =
		standardDeviation > 0
			? sorted.reduce(
					(sum, value) => sum + ((value - mean) / standardDeviation) ** 4,
					0,
				) / sorted.length
			: 0;

	// The sample is sorted ascending, so the losses beyond a threshold are a
	// prefix of it and the mean needs no second scan.
	const shortfall = (p: number): number => {
		const threshold = quantile(sorted, p);
		const count = Math.max(1, Math.floor(sorted.length * p));
		let sum = 0;
		for (let i = 0; i < count; i++) sum += sorted[i];
		return -Math.min(sum / count, threshold);
	};

	// Fitted tail where asked for and where there is enough of one to fit.
	// Falls back rather than throwing: a portfolio with no risk has no tail.
	let fitted: ReturnType<typeof fitTail> | null = null;
	if (tail === "extreme-value") {
		try {
			const losses = sorted.map((value) => -value).filter((value) => value > 0);
			if (losses.length >= 200) fitted = fitTail(losses, 0.1);
		} catch {}
	}
	const fromTail = (confidence: number) => {
		if (fitted === null) return null;
		try {
			return tailRisk(fitted, confidence);
		} catch {
			return null;
		}
	};
	const tail95 = fromTail(0.95);
	const tail99 = fromTail(0.99);

	return {
		profitAndLoss: sorted,
		valueAtRisk95: tail95?.valueAtRisk ?? -quantile(sorted, 0.05),
		valueAtRisk99: tail99?.valueAtRisk ?? -quantile(sorted, 0.01),
		expectedShortfall95: tail95?.expectedShortfall ?? shortfall(0.05),
		expectedShortfall99: tail99?.expectedShortfall ?? shortfall(0.01),
		mean,
		standardDeviation,
		kurtosis,
		tailShape: fitted?.shape ?? null,
	};
};

/**
 * Value a portfolio against the moves that actually happened over a window.
 *
 * No sampling and no model: this is what the portfolio would have done in a
 * named episode. The number a person believes without being walked through a
 * methodology, and the right first thing to show.
 */
export const replayWindow = ({
	dates,
	levels,
	keyRateDv01,
	from,
	to,
}: {
	dates: string[];
	levels: number[][];
	keyRateDv01: number[];
	from: string;
	to: string;
}): { profitAndLoss: number; move: number[]; days: number } => {
	const start = dates.findIndex((date) => date >= from);
	let end = -1;
	for (let i = dates.length - 1; i >= 0; i--) {
		if (dates[i] <= to) {
			end = i;
			break;
		}
	}
	if (start < 0 || end < 0 || end <= start) {
		throw new Error(`No history between ${from} and ${to}`);
	}

	const move = levels[end].map((value, j) => value - levels[start][j]);
	const profitAndLoss = -move.reduce(
		(sum, change, j) => sum + change * keyRateDv01[j],
		0,
	);
	return { profitAndLoss, move, days: end - start };
};
