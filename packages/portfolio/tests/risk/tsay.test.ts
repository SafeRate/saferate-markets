import { describe as group, expect, test } from "bun:test";
import {
	chiSquareSurvival,
	describe,
	fitStudentT,
	hillTailIndex,
	ljungBox,
	studentTRisk,
	tQuantile,
} from "../../src/risk/tsay";

/** A seeded uniform, so every sample below is the same on every run. */
const rng = (seed: number) => {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};
const normals = (n: number, seed: number) => {
	const u = rng(seed);
	return Array.from(
		{ length: n },
		() => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u()),
	);
};
/** Student-t with nu degrees of freedom, scaled to unit variance: Z / sqrt(chi2/nu). */
const standardisedT = (n: number, nu: number, seed: number) => {
	const z = normals(n * (nu + 1), seed);
	return Array.from({ length: n }, (_, i) => {
		const chi2 = z
			.slice(n + i * nu, n + (i + 1) * nu)
			.reduce((s, x) => s + x * x, 0);
		return (z[i] / Math.sqrt(chi2 / nu)) * Math.sqrt((nu - 2) / nu);
	});
};

group("the distributions, against textbook tables", () => {
	test("chi-square 5% critical values", () => {
		expect(chiSquareSurvival(3.841459, 1)).toBeCloseTo(0.05, 5);
		expect(chiSquareSurvival(5.991465, 2)).toBeCloseTo(0.05, 5);
		expect(chiSquareSurvival(18.307038, 10)).toBeCloseTo(0.05, 5);
	});
	test("Student-t quantiles", () => {
		expect(tQuantile(0.975, 10)).toBeCloseTo(2.228139, 4);
		expect(tQuantile(0.99, 5)).toBeCloseTo(3.36493, 4);
		expect(tQuantile(0.01, 5)).toBeCloseTo(-3.36493, 4);
	});
	test("with many degrees of freedom the t risk is the normal's", () => {
		const r = studentTRisk(1, 10_000, 0.99);
		expect(r.valueAtRisk).toBeCloseTo(2.326348, 2);
		expect(r.expectedShortfall).toBeCloseTo(2.665214, 2);
	});
	test("and with few, the tail is fatter than the normal's", () => {
		const r = studentTRisk(1, 4, 0.99);
		expect(r.valueAtRisk).toBeGreaterThan(2.33);
		expect(r.expectedShortfall).toBeGreaterThan(r.valueAtRisk);
	});
});

group("on samples whose answer is known", () => {
	test("a normal sample looks normal", () => {
		const d = describe(normals(20_000, 1));
		expect(Math.abs(d.skewness)).toBeLessThan(0.05);
		expect(Math.abs(d.excessKurtosis)).toBeLessThan(0.1);
		expect(d.jarqueBeraPValue).toBeGreaterThan(0.01);
	});
	test("a t(4) sample is fat-tailed and Jarque-Bera says so", () => {
		const d = describe(standardisedT(20_000, 4, 2));
		expect(d.excessKurtosis).toBeGreaterThan(2);
		expect(d.jarqueBeraPValue).toBeLessThan(1e-6);
	});
	test("the t fit recovers the degrees of freedom", () => {
		const fit = fitStudentT(standardisedT(20_000, 5, 3));
		expect(fit.degreesOfFreedom).toBeGreaterThan(4);
		expect(fit.degreesOfFreedom).toBeLessThan(6.5);
	});
	test("Hill recovers a Pareto tail index", () => {
		const u = rng(4);
		// Losses Pareto with alpha 3: X = U^(-1/3); as P&L, negative.
		const sample = Array.from({ length: 40_000 }, () => -((1 - u()) ** (-1 / 3)));
		const hill = hillTailIndex(sample);
		expect(hill?.alpha).toBeGreaterThan(2.6);
		expect(hill?.alpha).toBeLessThan(3.4);
	});
	test("Ljung-Box: no clustering in iid noise, strong clustering in an ARCH process", () => {
		expect(ljungBox(normals(5_000, 5).map((x) => x * x)).pValue).toBeGreaterThan(
			0.01,
		);
		const z = normals(5_000, 6);
		const arch: number[] = [];
		let prev = 0;
		for (const e of z) {
			const x = Math.sqrt(0.2 + 0.7 * prev * prev) * e;
			arch.push(x);
			prev = x;
		}
		expect(ljungBox(arch.map((x) => x * x)).pValue).toBeLessThan(1e-6);
	});
});
