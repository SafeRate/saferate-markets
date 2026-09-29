import { describe, expect, test } from "bun:test";
import {
	buildScenarios,
	ewmaVolatility,
	replayWindow,
	simulateHistorical,
} from "../../src/risk/historicalSimulation";

/** A run of business days, so the gap filter keeps them. */
const businessDays = (count: number, start = "2020-01-06"): string[] => {
	const out: string[] = [];
	const date = new Date(`${start}T00:00:00Z`);
	while (out.length < count) {
		const day = date.getUTCDay();
		if (day !== 0 && day !== 6) out.push(date.toISOString().slice(0, 10));
		date.setUTCDate(date.getUTCDate() + 1);
	}
	return out;
};

/** Deterministic pseudo-random levels, so tests do not depend on Math.random. */
const syntheticLevels = (days: number, tenors: number, amplitude = 5) => {
	const levels: number[][] = [];
	let state = 12345;
	const next = () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff - 0.5;
	};
	let current = Array.from({ length: tenors }, (_, j) => 2 + j * 0.2);
	for (let i = 0; i < days; i++) {
		// A shared shock plus tenor noise, so the columns genuinely co-move.
		const common = next() * amplitude;
		current = current.map((value) => value + (common + next()) / 100);
		levels.push([...current]);
	}
	return levels;
};

describe("ewmaVolatility", () => {
	test("returns one estimate per observation", () => {
		const vol = ewmaVolatility({ changes: [1, -2, 3, -1] });
		expect(vol).toHaveLength(4);
	});

	test("each estimate uses only what came before it", () => {
		// A long calm run then one huge day: the estimate ON the huge day must
		// still be calm, or the observation has informed its own scale.
		const changes = [...Array(50).fill(0.1), 100];
		const vol = ewmaVolatility({ changes, seed: 0.01 });
		expect(vol[50]).toBeLessThan(1);
		// And the next estimate must react to it.
		const after = ewmaVolatility({ changes: [...changes, 0.1], seed: 0.01 });
		expect(after[51]).toBeGreaterThan(vol[50] * 5);
	});

	test("a higher lambda reacts more slowly", () => {
		const changes = [...Array(30).fill(0.1), 50, 0.1];
		const fast = ewmaVolatility({ changes, lambda: 0.7, seed: 0.01 });
		const slow = ewmaVolatility({ changes, lambda: 0.99, seed: 0.01 });
		expect(fast[31]).toBeGreaterThan(slow[31]);
	});

	test("rejects a lambda outside the unit interval", () => {
		expect(() => ewmaVolatility({ changes: [1, 2], lambda: 1 })).toThrow(
			/lambda/,
		);
		expect(() => ewmaVolatility({ changes: [1, 2], lambda: 0 })).toThrow(
			/lambda/,
		);
	});

	test("no observations gives no estimates", () => {
		expect(ewmaVolatility({ changes: [] })).toEqual([]);
	});
});

describe("buildScenarios", () => {
	const dates = businessDays(300);
	const levels = syntheticLevels(300, 4);

	test("standardised days have roughly unit scale", () => {
		const { standardised } = buildScenarios({ dates, levels });
		const column = standardised.map((row) => row[0]);
		const mean = column.reduce((a, b) => a + b, 0) / column.length;
		const sd = Math.sqrt(
			column.reduce((a, b) => a + (b - mean) ** 2, 0) / (column.length - 1),
		);
		// Dividing each change by the volatility prevailing on it should leave a
		// series with scale near one; exactness is not the point.
		expect(sd).toBeGreaterThan(0.5);
		expect(sd).toBeLessThan(2);
	});

	test("drops gaps rather than differencing across them", () => {
		const sparse = [dates[0], dates[1], "2021-06-01", "2021-06-02"];
		const four = levels.slice(0, 4);
		const { standardised, dates: kept } = buildScenarios({
			dates: sparse,
			levels: four,
		});
		// The jump from 2020 to 2021 is not a day and must not enter the sample.
		expect(kept).not.toContain("2021-06-01");
		expect(standardised).toHaveLength(2);
	});

	test("rejects mismatched inputs", () => {
		expect(() => buildScenarios({ dates: ["2020-01-06"], levels })).toThrow(
			/same length/,
		);
		expect(() =>
			buildScenarios({ dates: [dates[0]], levels: [levels[0]] }),
		).toThrow(/at least two/);
	});
});

describe("simulateHistorical", () => {
	const dates = businessDays(600);
	const levels = syntheticLevels(600, 4);
	const scenarios = buildScenarios({ dates, levels });
	const keyRateDv01 = [200, 400, 900, 600];

	test("losses deepen as confidence rises, and shortfall exceeds both", () => {
		const result = simulateHistorical({
			scenarios,
			keyRateDv01,
			paths: 20_000,
		});
		expect(result.valueAtRisk99).toBeGreaterThan(result.valueAtRisk95);
		expect(result.expectedShortfall99).toBeGreaterThan(result.valueAtRisk99);
	});

	test("shortfall exceeds value at risk at both confidence levels", () => {
		const r = simulateHistorical({ scenarios, keyRateDv01, paths: 20_000 });
		expect(r.expectedShortfall95).toBeGreaterThan(r.valueAtRisk95);
		expect(r.expectedShortfall99).toBeGreaterThan(r.valueAtRisk99);
		// And the 99% measures sit outside the 95% ones.
		expect(r.expectedShortfall99).toBeGreaterThan(r.expectedShortfall95);
	});

	test("the same seed gives the same answer", () => {
		const a = simulateHistorical({
			scenarios,
			keyRateDv01,
			paths: 5_000,
			seed: 7,
		});
		const b = simulateHistorical({
			scenarios,
			keyRateDv01,
			paths: 5_000,
			seed: 7,
		});
		const c = simulateHistorical({
			scenarios,
			keyRateDv01,
			paths: 5_000,
			seed: 8,
		});
		expect(a.valueAtRisk99).toBe(b.valueAtRisk99);
		expect(a.valueAtRisk99).not.toBe(c.valueAtRisk99);
	});

	test("doubling every exposure doubles the risk", () => {
		const single = simulateHistorical({
			scenarios,
			keyRateDv01,
			paths: 20_000,
			seed: 3,
		});
		const double = simulateHistorical({
			scenarios,
			keyRateDv01: keyRateDv01.map((v) => v * 2),
			paths: 20_000,
			seed: 3,
		});
		expect(double.valueAtRisk99).toBeCloseTo(single.valueAtRisk99 * 2, 6);
	});

	test("no exposure is no risk", () => {
		const flat = simulateHistorical({
			scenarios,
			keyRateDv01: [0, 0, 0, 0],
			paths: 1_000,
		});
		expect(flat.valueAtRisk99).toBeCloseTo(0, 10);
	});

	test("a longer horizon carries more risk than a single day", () => {
		const day = simulateHistorical({
			scenarios,
			keyRateDv01,
			paths: 20_000,
			seed: 5,
		});
		const tenDay = simulateHistorical({
			scenarios,
			keyRateDv01,
			paths: 20_000,
			horizonDays: 10,
			seed: 5,
		});
		expect(tenDay.valueAtRisk99).toBeGreaterThan(day.valueAtRisk99);
	});

	test("rejects an exposure vector that does not match the scenarios", () => {
		expect(() =>
			simulateHistorical({ scenarios, keyRateDv01: [1, 2], paths: 10 }),
		).toThrow(/tenors/);
	});

	test("rejects a nonsensical horizon", () => {
		expect(() =>
			simulateHistorical({ scenarios, keyRateDv01, horizonDays: 0 }),
		).toThrow(/whole number/);
		expect(() =>
			simulateHistorical({ scenarios, keyRateDv01, horizonDays: 1.5 }),
		).toThrow(/whole number/);
	});
});

describe("replayWindow", () => {
	const dates = businessDays(100);
	const levels = syntheticLevels(100, 3);

	test("values the move that actually happened", () => {
		const keyRateDv01 = [100, 200, 300];
		const result = replayWindow({
			dates,
			levels,
			keyRateDv01,
			from: dates[0],
			to: dates[50],
		});
		const expected = -levels[50].reduce(
			(sum, value, j) => sum + (value - levels[0][j]) * keyRateDv01[j],
			0,
		);
		expect(result.profitAndLoss).toBeCloseTo(expected, 8);
		expect(result.days).toBe(50);
	});

	test("rates rising loses money for a long portfolio", () => {
		const rising = levels.map((row, i) => row.map((v) => v + i * 0.01));
		const { profitAndLoss } = replayWindow({
			dates,
			levels: rising,
			keyRateDv01: [100, 200, 300],
			from: dates[0],
			to: dates[99],
		});
		expect(profitAndLoss).toBeLessThan(0);
	});

	test("rejects a window with no history in it", () => {
		expect(() =>
			replayWindow({
				dates,
				levels,
				keyRateDv01: [1, 2, 3],
				from: "2030-01-01",
				to: "2030-12-31",
			}),
		).toThrow(/No history/);
	});
});

describe("outputs that nothing was reading", () => {
	// From the same audit. These fields are the scenario set itself and the
	// distribution summary — if they are wrong every risk number is wrong, and
	// until now no test read any of them.
	const dates = businessDays(400);
	const levels = syntheticLevels(400, 4);

	test("currentVolatility is a forecast, not a historical average", () => {
		// It must respond to the most recent observation, which a plain average
		// over the sample would not.
		const calm = levels.map((row) => [...row]);
		const shocked = calm.map((row, i) =>
			i === calm.length - 1 ? row.map((v) => v + 3) : row,
		);
		const a = buildScenarios({ dates, levels: calm, model: "ewma" });
		const b = buildScenarios({ dates, levels: shocked, model: "ewma" });
		expect(b.currentVolatility[0]).toBeGreaterThan(a.currentVolatility[0]);
		for (const v of a.currentVolatility) expect(v).toBeGreaterThan(0);
	});

	test("standardised rows keep the sign and shape of the raw move", () => {
		// Standardising divides by a positive scale, so it can change magnitude
		// and must not change direction. A sign error here would invert every
		// scenario and still look plausible in aggregate.
		const set = buildScenarios({ dates, levels, model: "ewma" });
		let raw = 0;
		let agreed = 0;
		for (let i = 1; i < levels.length && i - 1 < set.standardised.length; i++) {
			const change = levels[i][0] - levels[i - 1][0];
			if (Math.abs(change) < 1e-9) continue;
			raw++;
			if (Math.sign(change) === Math.sign(set.standardised[i - 1][0])) agreed++;
		}
		expect(agreed / raw).toBeGreaterThan(0.95);
	});

	test("dates align one-to-one with the standardised rows", () => {
		const set = buildScenarios({ dates, levels, model: "ewma" });
		expect(set.dates).toHaveLength(set.standardised.length);
		// And every retained date is one of the inputs, in order.
		let previous = "";
		for (const d of set.dates) {
			expect(dates).toContain(d);
			expect(d > previous).toBe(true);
			previous = d;
		}
	});

	test("the reported spread and kurtosis describe the returned sample", () => {
		// Recomputing them from profitAndLoss must reproduce what was reported;
		// otherwise the summary and the distribution have drifted apart.
		const set = buildScenarios({ dates, levels, model: "ewma" });
		const r = simulateHistorical({
			scenarios: set,
			keyRateDv01: [100, 200, 300, 400],
			paths: 20_000,
			seed: 11,
		});
		const n = r.profitAndLoss.length;
		const mean = r.profitAndLoss.reduce((a, b) => a + b, 0) / n;
		const sd = Math.sqrt(
			r.profitAndLoss.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1),
		);
		const kurt =
			r.profitAndLoss.reduce((a, b) => a + ((b - mean) / sd) ** 4, 0) / n;
		expect(r.mean).toBeCloseTo(mean, 8);
		expect(r.standardDeviation).toBeCloseTo(sd, 8);
		expect(r.kurtosis).toBeCloseTo(kurt, 6);
	});

	test("tailShape is null unless the fitted tail was actually used", () => {
		const set = buildScenarios({ dates, levels, model: "ewma" });
		const empirical = simulateHistorical({
			scenarios: set,
			keyRateDv01: [100, 200, 300, 400],
			paths: 20_000,
			seed: 3,
		});
		expect(empirical.tailShape).toBeNull();

		const fitted = simulateHistorical({
			scenarios: set,
			keyRateDv01: [100, 200, 300, 400],
			paths: 20_000,
			seed: 3,
			tail: "extreme-value",
		});
		expect(fitted.tailShape).not.toBeNull();
		// And the fitted tail must not silently agree with the empirical one:
		// if it did, it would mean the option is doing nothing.
		expect(fitted.valueAtRisk99).not.toBeCloseTo(empirical.valueAtRisk99, 6);
	});

	test("garch and ewma give different scenario sets on the same data", () => {
		// The model option must actually change something. A silently ignored
		// parameter is the same class of defect as an unread output.
		const a = buildScenarios({ dates, levels, model: "ewma" });
		const b = buildScenarios({ dates, levels, model: "garch" });
		const differs = a.currentVolatility.some(
			(v, i) => Math.abs(v - b.currentVolatility[i]) > 1e-9,
		);
		expect(differs).toBe(true);
	});
});
