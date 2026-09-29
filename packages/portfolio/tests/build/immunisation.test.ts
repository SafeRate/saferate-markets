import { describe, expect, test } from "bun:test";
import { nonNegativeLeastSquares } from "../../src/build/linearAlgebra";

describe("nonNegativeLeastSquares", () => {
	/** Ordinary least squares by the normal equations, for comparison. */
	const unconstrained = (a: number[][], b: number[]): number[] => {
		const columns = a[0].length;
		const normal = Array.from({ length: columns }, (_, p) =>
			Array.from({ length: columns }, (_, q) =>
				a.reduce((sum, row) => sum + row[p] * row[q], 0),
			),
		);
		const rhs = Array.from({ length: columns }, (_, p) =>
			a.reduce((sum, row, i) => sum + row[p] * b[i], 0),
		);
		// Two by two only, which is all these fixtures need.
		const [[m00, m01], [m10, m11]] = normal;
		const determinant = m00 * m11 - m01 * m10;
		return [
			(rhs[0] * m11 - m01 * rhs[1]) / determinant,
			(m00 * rhs[1] - rhs[0] * m10) / determinant,
		];
	};

	test("agrees with ordinary least squares when the answer is already positive", () => {
		// The constraint is not binding, so it must not bite. If this fails the
		// method is charging for a restriction nobody needed.
		const a = [
			[1, 0],
			[1, 1],
			[1, 2],
			[1, 3],
		];
		const b = [1.1, 2.0, 2.9, 4.2];
		const free = unconstrained(a, b);
		expect(free[0]).toBeGreaterThan(0);
		expect(free[1]).toBeGreaterThan(0);
		const constrained = nonNegativeLeastSquares({ a, b });
		expect(constrained.converged).toBe(true);
		expect(constrained.x[0]).toBeCloseTo(free[0], 8);
		expect(constrained.x[1]).toBeCloseTo(free[1], 8);
	});

	test("is not the same as clamping the unconstrained answer", () => {
		// The distinction that justifies the algorithm. Zeroing one coefficient
		// changes what the others should be, so the clamped vector is generally
		// not the constrained optimum and fits measurably worse.
		const a = [
			[1, 2],
			[1, 3],
			[1, 4],
		];
		const b = [6, 5, 4];
		const free = unconstrained(a, b);
		expect(free[1]).toBeLessThan(0);

		const clamped = [Math.max(free[0], 0), 0];
		const solved = nonNegativeLeastSquares({ a, b });
		const error = (x: number[]) =>
			a.reduce(
				(sum, row, i) => sum + (b[i] - (row[0] * x[0] + row[1] * x[1])) ** 2,
				0,
			);
		expect(solved.x[1]).toBe(0);
		expect(solved.x[0]).not.toBeCloseTo(clamped[0], 4);
		expect(error(solved.x)).toBeLessThan(error(clamped));
	});

	test("never returns a negative coefficient", () => {
		let seed = 42;
		const random = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let trial = 0; trial < 50; trial++) {
			const rows = 6 + Math.floor(random() * 6);
			const columns = 2 + Math.floor(random() * 5);
			const a = Array.from({ length: rows }, () =>
				Array.from({ length: columns }, () => random() * 4 - 2),
			);
			const b = Array.from({ length: rows }, () => random() * 6 - 3);
			const solved = nonNegativeLeastSquares({ a, b });
			for (const value of solved.x) expect(value).toBeGreaterThanOrEqual(0);
		}
	});

	test("satisfies the Karush-Kuhn-Tucker conditions at the solution", () => {
		// The check that does not trust the loop. At a constrained optimum the
		// gradient must vanish on every coefficient that is free to move and
		// point the wrong way on every one pinned at zero. Verified on random
		// problems rather than on a fixture, since a fixture only ever exercises
		// one active set.
		let seed = 7;
		const random = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let trial = 0; trial < 50; trial++) {
			const rows = 8;
			const columns = 4;
			const a = Array.from({ length: rows }, () =>
				Array.from({ length: columns }, () => random() * 3 - 1),
			);
			const b = Array.from({ length: rows }, () => random() * 5 - 2);
			const solved = nonNegativeLeastSquares({ a, b });
			if (!solved.converged) continue;
			const scale = Math.max(
				1,
				...solved.gradient.map((value) => Math.abs(value)),
			);
			for (let j = 0; j < columns; j++) {
				if (solved.x[j] > 1e-8) {
					expect(Math.abs(solved.gradient[j]) / scale).toBeLessThan(1e-6);
				} else {
					expect(solved.gradient[j]).toBeLessThan(1e-6 * scale);
				}
			}
		}
	});

	test("recovers an exactly representable non-negative target", () => {
		// Recovery from generated data: build b from a known non-negative x and
		// ask for it back. Exact, because the system is consistent.
		const a = [
			[2, 1, 0],
			[0, 3, 1],
			[1, 0, 4],
			[1, 1, 1],
		];
		const truth = [1.5, 0, 2.25];
		const b = a.map((row) =>
			row.reduce((sum, value, j) => sum + value * truth[j], 0),
		);
		const solved = nonNegativeLeastSquares({ a, b });
		expect(solved.converged).toBe(true);
		for (const [j, value] of truth.entries()) {
			expect(solved.x[j]).toBeCloseTo(value, 8);
		}
		expect(solved.residualSumSquares).toBeCloseTo(0, 12);
	});

	test("returns all zeros when nothing helps", () => {
		// Every column points away from the target, so the best non-negative
		// combination is none of them.
		const solved = nonNegativeLeastSquares({
			a: [
				[-1, -2],
				[-2, -1],
			],
			b: [3, 4],
		});
		expect(solved.x).toEqual([0, 0]);
		expect(solved.residualSumSquares).toBeCloseTo(25, 9);
	});

	test("rejects a target that does not match the design", () => {
		expect(() =>
			nonNegativeLeastSquares({ a: [[1], [1]], b: [1, 2, 3] }),
		).toThrow(/rows/);
	});

	test("handles an empty problem", () => {
		const solved = nonNegativeLeastSquares({ a: [], b: [] });
		expect(solved.x).toEqual([]);
		expect(solved.converged).toBe(true);
	});
});

import {
	immunise,
	type TImmunisationSecurity,
} from "../../src/build/immunisation";
import { KEY_RATES } from "../../src/risk/keyRates";

/** A security whose exposure sits entirely at one key rate, like a strip. */
const pure = (
	cusip: string,
	tenor: number,
	askPrice = 100,
): TImmunisationSecurity => ({
	cusip,
	askPrice,
	keyRateDurations: KEY_RATES.map((time) => (time === tenor ? tenor : 0)),
});

describe("immunise", () => {
	test("a liability replicable by one security buys only that one", () => {
		const target = {
			presentValue: 10_000_000,
			keyRateDurations: KEY_RATES.map((time) => (time === 10 ? 10 : 0)),
		};
		const result = immunise({
			securities: [pure("TWO", 2), pure("TEN", 10), pure("THIRTY", 30)],
			target,
		});
		expect(result.positions).toHaveLength(1);
		expect(result.positions[0].cusip).toBe("TEN");
		expect(result.positions[0].weight).toBeCloseTo(1, 8);
		for (const residual of result.keyRateResidual) {
			expect(Math.abs(residual)).toBeLessThan(1e-6);
		}
	});

	test("funds the liability exactly and converts weights to face", () => {
		const target = {
			presentValue: 10_000_000,
			keyRateDurations: KEY_RATES.map((time) => (time === 5 ? 5 : 0)),
		};
		const result = immunise({
			securities: [pure("FIVE", 5, 96.5), pure("TWO", 2, 99.1)],
			target,
		});
		expect(result.presentValue).toBeCloseTo(target.presentValue, 4);
		// Face is market value grossed up by the price, so a discount bond needs
		// more face than dollars.
		expect(result.positions[0].faceValue).toBeCloseTo(
			(10_000_000 * 100) / 96.5,
			4,
		);
	});

	test("weights are non-negative and sum to one", () => {
		const target = {
			presentValue: 5_000_000,
			keyRateDurations: KEY_RATES.map((time) =>
				time >= 3 && time <= 15 ? time / 4 : 0,
			),
		};
		const result = immunise({
			securities: KEY_RATES.map((time) => pure(`K${time}`, time, 98)),
			target,
		});
		let total = 0;
		for (const position of result.positions) {
			expect(position.weight).toBeGreaterThan(0);
			total += position.weight;
		}
		expect(total).toBeCloseTo(1, 8);
	});

	test("the answer is sparse without anyone asking for a position limit", () => {
		// The active set leaves most weights at exactly zero, which is why
		// immunisation is operable where dedication needs an integer programme to
		// be made so.
		const target = {
			presentValue: 20_000_000,
			keyRateDurations: KEY_RATES.map((time) => (time === 7 ? 7 : 0)),
		};
		const universe = KEY_RATES.flatMap((time) => [
			pure(`A${time}`, time, 97),
			pure(`B${time}`, time, 101),
		]);
		const result = immunise({ securities: universe, target });
		expect(result.positions.length).toBeLessThanOrEqual(3);
		expect(universe.length).toBeGreaterThan(20);
	});

	test("CATCHES THE BARBELL, which is the whole reason for key rates", () => {
		// Two years and thirty years, weighted to the duration of a ten year
		// liability. Total duration matches; the exposure sits in the wrong
		// places, so the portfolio loses on any steepening. A single-duration
		// immunisation calls this hedged. This one reports the gap.
		const target = {
			presentValue: 10_000_000,
			keyRateDurations: KEY_RATES.map((time) => (time === 10 ? 10 : 0)),
		};
		const result = immunise({
			securities: [pure("TWO", 2), pure("THIRTY", 30)],
			target,
		});
		// Duration is matched, or very nearly: a barbell can always hit the
		// number.
		expect(Math.abs(result.durationResidual)).toBeLessThan(0.5);
		// And the exposure is badly wrong at the three points that matter.
		const at = (tenor: number) =>
			result.keyRateResidual[KEY_RATES.indexOf(tenor)];
		expect(at(2)).toBeGreaterThan(1);
		expect(at(10)).toBeLessThan(-9);
		expect(at(30)).toBeGreaterThan(1);
		// In money: millions of dollars per basis point sitting unhedged at the
		// wings while the reported total duration says everything is fine.
		const worst = Math.max(...result.residualDv01.map((v) => Math.abs(v)));
		expect(worst).toBeGreaterThan(5_000);
	});

	test("a spanning universe drives the residual to nothing", () => {
		// The same liability, given securities at the point where its exposure
		// actually sits. The barbell above and this differ only in the universe.
		const target = {
			presentValue: 10_000_000,
			keyRateDurations: KEY_RATES.map((time) => (time === 10 ? 10 : 0)),
		};
		const result = immunise({
			securities: [pure("TWO", 2), pure("TEN", 10), pure("THIRTY", 30)],
			target,
		});
		for (const value of result.residualDv01) {
			expect(Math.abs(value)).toBeLessThan(1);
		}
	});

	test("blends where no single security matches", () => {
		// A liability with exposure between two key rates has to be built from
		// both, and the blend must reproduce it.
		const target = {
			presentValue: 8_000_000,
			keyRateDurations: KEY_RATES.map((time) =>
				time === 5 ? 2.5 : time === 7 ? 3.5 : 0,
			),
		};
		const result = immunise({
			securities: [pure("FIVE", 5), pure("SEVEN", 7), pure("TWENTY", 20)],
			target,
		});
		expect(result.positions.length).toBeGreaterThanOrEqual(2);
		for (const residual of result.keyRateResidual) {
			expect(Math.abs(residual)).toBeLessThan(1e-6);
		}
	});

	test("reports the shortfall when the liability is out of reach", () => {
		// A thirty year liability against a universe stopping at two years. There
		// is no hedge, and saying so is the required behaviour: an immunisation
		// that silently returns its best effort is the dangerous one.
		const target = {
			presentValue: 10_000_000,
			keyRateDurations: KEY_RATES.map((time) => (time === 30 ? 25 : 0)),
		};
		const result = immunise({
			securities: [pure("ONE", 1), pure("TWO", 2)],
			target,
		});
		expect(result.durationResidual).toBeLessThan(-20);
		expect(Math.abs(result.residualDv01[KEY_RATES.indexOf(30)])).toBeGreaterThan(
			20_000,
		);
	});

	test("never shorts, even where a short would fit better", () => {
		// Plain least squares would go negative here to sharpen the match. The
		// institutions that immunise cannot borrow a bond to sell.
		const target = {
			presentValue: 10_000_000,
			keyRateDurations: KEY_RATES.map((time) => (time === 3 ? 3 : 0)),
		};
		const result = immunise({
			securities: [pure("TWO", 2), pure("THIRTY", 30)],
			target,
		});
		for (const position of result.positions) {
			expect(position.weight).toBeGreaterThan(0);
		}
	});

	test("an empty universe or a worthless liability returns the whole exposure unhedged", () => {
		const target = {
			presentValue: 1_000_000,
			keyRateDurations: KEY_RATES.map((time) => (time === 10 ? 10 : 0)),
		};
		const none = immunise({ securities: [], target });
		expect(none.positions).toEqual([]);
		expect(none.durationResidual).toBeCloseTo(-10, 8);
		const nothingDue = immunise({
			securities: [pure("TEN", 10)],
			target: { presentValue: 0, keyRateDurations: target.keyRateDurations },
		});
		expect(nothingDue.positions).toEqual([]);
	});

	test("drops unpriced securities rather than treating them as free", () => {
		const target = {
			presentValue: 1_000_000,
			keyRateDurations: KEY_RATES.map((time) => (time === 10 ? 10 : 0)),
		};
		const result = immunise({
			securities: [{ ...pure("UNQUOTED", 10), askPrice: 0 }, pure("PRICED", 10)],
			target,
		});
		expect(result.positions.map((p) => p.cusip)).toEqual(["PRICED"]);
	});
});
