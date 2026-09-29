import { describe, expect, test } from "bun:test";
import {
	fitGarch,
	fitTail,
	garchVariance,
	tailRisk,
} from "../../src/risk/volatilityModels";

/** A decent 32-bit mixer; an LCG's low bits are too poor for tail work. */
const mulberry = (seed: number) => {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/** Deterministic standard normal draws. */
const normals = (seed: number, count: number): number[] => {
	let state = seed;
	const next = () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
	const out: number[] = [];
	while (out.length < count) {
		const a = next() + 1e-12;
		const b = next();
		out.push(Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b));
		out.push(Math.sqrt(-2 * Math.log(a)) * Math.sin(2 * Math.PI * b));
	}
	return out.slice(0, count);
};

/** Simulate a GARCH(1,1) series with known parameters. */
const simulateGarch = (
	omega: number,
	alpha: number,
	beta: number,
	count: number,
	seed: number,
): number[] => {
	const z = normals(seed, count);
	let variance = omega / (1 - alpha - beta);
	const out: number[] = [];
	for (let i = 0; i < count; i++) {
		const value = Math.sqrt(variance) * z[i];
		out.push(value);
		variance = omega + alpha * value * value + beta * variance;
	}
	return out;
};

describe("fitGarch", () => {
	test("recovers parameters from a series it generated", () => {
		const series = simulateGarch(0.02, 0.08, 0.9, 4000, 17);
		const fit = fitGarch(series);
		// Persistence is what the model is really about and is estimated far more
		// precisely than the split between alpha and beta.
		expect(fit.persistence).toBeCloseTo(0.98, 1);
		expect(fit.alpha).toBeGreaterThan(0.01);
		expect(fit.beta).toBeGreaterThan(0.7);
		expect(fit.longRunVariance).toBeGreaterThan(0.5);
		expect(fit.longRunVariance).toBeLessThan(3);
	});

	test("constraints hold whatever the data", () => {
		for (const seed of [1, 2, 3]) {
			const fit = fitGarch(normals(seed, 800));
			expect(fit.omega).toBeGreaterThan(0);
			expect(fit.alpha).toBeGreaterThanOrEqual(0);
			expect(fit.beta).toBeGreaterThanOrEqual(0);
			expect(fit.persistence).toBeLessThan(1);
		}
	});

	test("beats a fixed exponential weighting on data with a long run level", () => {
		// EWMA is GARCH with omega zero and persistence one. On a series that
		// does revert, the fitted model should win on likelihood.
		const series = simulateGarch(0.05, 0.1, 0.85, 3000, 5);
		const fitted = fitGarch(series);
		const ewmaVariance = garchVariance(series, {
			omega: 0,
			alpha: 0.06,
			beta: 0.94,
		});
		let ewmaLogLikelihood = 0;
		for (let i = 0; i < series.length; i++) {
			const v = ewmaVariance[i];
			if (v > 0)
				ewmaLogLikelihood +=
					-0.5 * (Math.log(v) + series[i] ** 2 / v + Math.log(2 * Math.PI));
		}
		expect(fitted.logLikelihood).toBeGreaterThan(ewmaLogLikelihood);
	});

	test("variance responds to a shock and decays back", () => {
		const quiet = new Array(200).fill(0.01);
		const shocked = [...quiet, 5, ...quiet];
		const path = garchVariance(shocked, {
			omega: 0.001,
			alpha: 0.1,
			beta: 0.85,
		});
		const atShock = path[200];
		const justAfter = path[201];
		const muchLater = path[shocked.length - 1];
		expect(justAfter).toBeGreaterThan(atShock * 5);
		expect(muchLater).toBeLessThan(justAfter);
	});

	test("refuses a sample too short to say anything", () => {
		expect(() => fitGarch([1, 2, 3])).toThrow(/meaningful sample/);
	});
});

describe("fitTail", () => {
	test("recovers the shape of a known heavy tail, and converges", () => {
		// Drawn from a generalised Pareto with a known shape, which is threshold
		// stable — the exceedances of a GPD are GPD with the same shape — so the
		// fit should return it.
		//
		// The tolerance comes from theory rather than taste. The maximum
		// likelihood shape estimator has standard error near (1 + shape) over the
		// root of the exceedance count: at twenty thousand draws with a tenth in
		// the tail, about 0.028. Three of those is the estimator behaving, and a
		// tighter bound would fail on sampling noise rather than on a defect.
		const trueShape = 0.25;
		const draw = (seed: number, count: number) => {
			const u = mulberry(seed);
			return Array.from({ length: count }, () => {
				const x = u() + 1e-12;
				return (x ** -trueShape - 1) / trueShape;
			});
		};

		const fit = fitTail(draw(7919, 20_000), 0.1);
		expect(fit.shape).toBeGreaterThan(0);
		expect(Math.abs(fit.shape - trueShape)).toBeLessThan(0.09);

		// And it must improve with more data, which separates a consistent
		// estimator from one that merely lands close on this sample.
		const small = Math.abs(fitTail(draw(7919, 5_000), 0.1).shape - trueShape);
		const large = Math.abs(fitTail(draw(7919, 80_000), 0.1).shape - trueShape);
		expect(large).toBeLessThan(small);
	});

	test("a light tail comes back with a shape near or below zero", () => {
		const fit = fitTail(normals(4, 5000).map(Math.abs), 0.1);
		expect(fit.shape).toBeLessThan(0.3);
	});

	test("needs enough exceedances to fit", () => {
		expect(() => fitTail([1, 2, 3, 4, 5], 0.1)).toThrow(/twenty exceedances/);
	});
});

describe("tailRisk", () => {
	const fit = fitTail(
		Array.from({ length: 4000 }, (_, i) => {
			let s = (i * 2654435761) % 2147483647;
			s = (s * 1103515245 + 12345) & 0x7fffffff;
			const u = s / 0x7fffffff + 1e-12;
			return (u ** -0.2 - 1) / 0.2;
		}),
		0.1,
	);

	test("losses deepen with confidence, and shortfall exceeds value at risk", () => {
		const a = tailRisk(fit, 0.95);
		const b = tailRisk(fit, 0.99);
		expect(b.valueAtRisk).toBeGreaterThan(a.valueAtRisk);
		expect(a.expectedShortfall).toBeGreaterThan(a.valueAtRisk);
		expect(b.expectedShortfall).toBeGreaterThan(b.valueAtRisk);
	});

	test("refuses a confidence the tail model cannot speak to", () => {
		// Fitted on the top ten percent, so it knows nothing about the median.
		expect(() => tailRisk(fit, 0.5)).toThrow(/inside the body/);
		expect(() => tailRisk(fit, 1)).toThrow(/strictly between/);
	});
});

describe("outputs that nothing was reading", () => {
	// Added after an audit found that 63 of 226 declared result fields were
	// consumed by no test. An unread output is untested however many tests
	// surround it — which is exactly how a missing determinant term survived in
	// the Kalman likelihood.

	test("the tail threshold sits at the stated quantile", () => {
		const losses = Array.from({ length: 1000 }, (_, i) => i / 10);
		const fit = fitTail(losses, 0.1);
		// Ten percent in the tail means the cut is at the ninetieth percentile.
		expect(fit.threshold).toBeGreaterThan(88);
		expect(fit.threshold).toBeLessThan(91);
		expect(fit.total).toBe(1000);
		expect(fit.exceedances).toBeGreaterThan(80);
		expect(fit.exceedances).toBeLessThanOrEqual(100);
	});

	test("the tail scale carries the units of the data", () => {
		// Scaling every loss by ten must scale the fitted scale by ten and leave
		// the shape alone: shape is dimensionless, scale is not.
		const base = Array.from({ length: 4000 }, (_, i) => {
			const u = ((i * 7919) % 4001) / 4001 + 1e-6;
			return (u ** -0.2 - 1) / 0.2;
		});
		const small = fitTail(base, 0.1);
		const large = fitTail(
			base.map((v) => v * 10),
			0.1,
		);
		expect(large.scale / small.scale).toBeCloseTo(10, 0);
		expect(large.shape).toBeCloseTo(small.shape, 2);
		expect(large.threshold / small.threshold).toBeCloseTo(10, 1);
	});

	test("exceedance count and total drive the quantile mapping", () => {
		// tailRisk maps a confidence through exceedances/total. If either were
		// wrong the quantile would be silently misplaced, so check the boundary:
		// at exactly the exceedance rate, value at risk must equal the threshold.
		const losses = Array.from({ length: 2000 }, (_, i) => {
			const u = ((i * 2654435761) % 2003) / 2003 + 1e-6;
			return (u ** -0.15 - 1) / 0.15;
		});
		const fit = fitTail(losses, 0.1);
		const rate = fit.exceedances / fit.total;
		const atBoundary = tailRisk(fit, 1 - rate);
		expect(atBoundary.valueAtRisk).toBeCloseTo(fit.threshold, 6);
	});

	test("garch variance path starts at the unconditional level", () => {
		// A field nothing read: the first entry is a forecast made from no data,
		// so it must be the long run variance rather than anything sample driven.
		const params = { omega: 0.02, alpha: 0.08, beta: 0.9 };
		const path = garchVariance(new Array(500).fill(0.1), params);
		const unconditional = params.omega / (1 - params.alpha - params.beta);
		expect(path[0]).toBeCloseTo(unconditional, 6);
	});

	test("persistence and long run variance agree with their parts", () => {
		const fit = fitGarch(simulateGarch(0.03, 0.07, 0.9, 2000, 23));
		expect(fit.persistence).toBeCloseTo(fit.alpha + fit.beta, 12);
		expect(fit.longRunVariance).toBeCloseTo(fit.omega / (1 - fit.persistence), 8);
	});
});
