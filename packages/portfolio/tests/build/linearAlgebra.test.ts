import { describe, expect, test } from "bun:test";
import {
	addMatrices,
	identity,
	leastSquares,
	multiply,
	principalComponents,
	scale,
	solveMatrix,
	symmetricEigen,
	type TMatrix,
	transpose,
	zeros,
} from "../../src/build/linearAlgebra";

const closeTo = (a: TMatrix, b: TMatrix, digits = 10): void => {
	expect(a.length).toBe(b.length);
	for (let i = 0; i < a.length; i++) {
		expect(a[i].length).toBe(b[i].length);
		for (let j = 0; j < a[i].length; j++) {
			expect(a[i][j]).toBeCloseTo(b[i][j], digits);
		}
	}
};

/** Deterministic pseudo-random, so a failure is always reproducible. */
const random = (seed: number): (() => number) => {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648 - 0.5;
	};
};

const randomMatrix = (rows: number, columns: number, seed: number): TMatrix => {
	const next = random(seed);
	return Array.from({ length: rows }, () =>
		Array.from({ length: columns }, () => next() * 4),
	);
};

/** A random symmetric positive definite matrix: M'M + kI. */
const randomSymmetric = (size: number, seed: number): TMatrix => {
	const m = randomMatrix(size, size, seed);
	const sym = multiply(transpose(m), m);
	return addMatrices(sym, scale(identity(size), 0.5));
};

describe("basic operations", () => {
	test("multiply matches a hand-computed product", () => {
		const a = [
			[1, 2],
			[3, 4],
		];
		const b = [
			[5, 6],
			[7, 8],
		];
		closeTo(multiply(a, b), [
			[19, 22],
			[43, 50],
		]);
	});

	test("multiplying by the identity changes nothing", () => {
		const a = randomMatrix(5, 5, 7);
		closeTo(multiply(a, identity(5)), a);
		closeTo(multiply(identity(5), a), a);
	});

	test("handles non-square shapes", () => {
		const a = randomMatrix(3, 4, 11);
		const b = randomMatrix(4, 2, 13);
		const product = multiply(a, b);
		expect(product.length).toBe(3);
		expect(product[0].length).toBe(2);
	});

	test("rejects a dimension mismatch rather than producing nonsense", () => {
		expect(() => multiply(zeros(2, 3), zeros(4, 2))).toThrow(/Cannot multiply/);
	});

	test("multiplication is associative", () => {
		const a = randomMatrix(4, 3, 17);
		const b = randomMatrix(3, 5, 19);
		const c = randomMatrix(5, 2, 23);
		closeTo(multiply(multiply(a, b), c), multiply(a, multiply(b, c)), 8);
	});

	test("transpose is its own inverse, and reverses a product", () => {
		const a = randomMatrix(4, 3, 29);
		const b = randomMatrix(3, 5, 31);
		closeTo(transpose(transpose(a)), a);
		closeTo(transpose(multiply(a, b)), multiply(transpose(b), transpose(a)), 8);
	});
});

describe("solveMatrix", () => {
	test("solves a hand-checkable system", () => {
		// 2x + y = 5, x + 3y = 10  ->  x = 1, y = 3
		const x = solveMatrix(
			[
				[2, 1],
				[1, 3],
			],
			[[5], [10]],
		);
		expect(x).not.toBeNull();
		expect(x?.[0][0]).toBeCloseTo(1, 12);
		expect(x?.[1][0]).toBeCloseTo(3, 12);
	});

	test("the solution actually satisfies the system", () => {
		for (const seed of [3, 37, 101]) {
			const a = randomSymmetric(6, seed);
			const b = randomMatrix(6, 2, seed + 1);
			const x = solveMatrix(a, b);
			expect(x).not.toBeNull();
			closeTo(multiply(a, x as TMatrix), b, 8);
		}
	});

	test("inverting and multiplying back gives the identity", () => {
		const a = randomSymmetric(5, 41);
		const inverse = solveMatrix(a, identity(5));
		expect(inverse).not.toBeNull();
		closeTo(multiply(a, inverse as TMatrix), identity(5), 8);
	});

	test("returns null for a singular system rather than garbage", () => {
		expect(
			solveMatrix(
				[
					[1, 2],
					[2, 4],
				],
				[[1], [2]],
			),
		).toBeNull();
	});

	test("pivots, so a zero leading entry is not fatal", () => {
		// Without partial pivoting this divides by zero on the first column.
		const x = solveMatrix(
			[
				[0, 1],
				[1, 0],
			],
			[[2], [3]],
		);
		expect(x?.[0][0]).toBeCloseTo(3, 12);
		expect(x?.[1][0]).toBeCloseTo(2, 12);
	});
});

describe("leastSquares", () => {
	test("recovers coefficients exactly when the model fits perfectly", () => {
		const x = randomMatrix(40, 2, 53);
		const y = x.map((row) => [2 + 3 * row[0] - 1.5 * row[1]]);
		const fit = leastSquares(x, y);

		expect(fit).not.toBeNull();
		expect(fit?.coefficients[0][0]).toBeCloseTo(2, 9);
		expect(fit?.coefficients[1][0]).toBeCloseTo(3, 9);
		expect(fit?.coefficients[2][0]).toBeCloseTo(-1.5, 9);
		for (const row of fit?.residuals ?? []) {
			expect(Math.abs(row[0])).toBeLessThan(1e-9);
		}
	});

	test("residuals are orthogonal to the regressors, as OLS requires", () => {
		const x = randomMatrix(60, 3, 59);
		const next = random(61);
		const y = x.map((row) => [1 + row[0] - 2 * row[1] + 0.5 * row[2] + next()]);
		const fit = leastSquares(x, y);
		expect(fit).not.toBeNull();

		const residuals = (fit as NonNullable<typeof fit>).residuals;
		// Orthogonal to the intercept, i.e. they sum to zero.
		expect(residuals.reduce((sum, row) => sum + row[0], 0)).toBeCloseTo(0, 8);
		for (let j = 0; j < 3; j++) {
			const dot = residuals.reduce((sum, row, i) => sum + row[0] * x[i][j], 0);
			expect(dot).toBeCloseTo(0, 8);
		}
	});

	test("fits several dependent columns at once", () => {
		const x = randomMatrix(30, 2, 67);
		const y = x.map((row) => [row[0] + row[1], 2 * row[0] - row[1]]);
		const fit = leastSquares(x, y);

		expect(fit?.coefficients[1][0]).toBeCloseTo(1, 9);
		expect(fit?.coefficients[2][0]).toBeCloseTo(1, 9);
		expect(fit?.coefficients[1][1]).toBeCloseTo(2, 9);
		expect(fit?.coefficients[2][1]).toBeCloseTo(-1, 9);
	});

	test("returns null when the regressors are collinear", () => {
		const x = Array.from({ length: 10 }, (_, i) => [i, 2 * i]);
		expect(
			leastSquares(
				x,
				x.map((row) => [row[0]]),
			),
		).toBeNull();
	});
});

describe("symmetricEigen", () => {
	test("finds known eigenvalues and eigenvectors", () => {
		// [[2,1],[1,2]] has eigenvalues 3 and 1.
		const { values, vectors } = symmetricEigen([
			[2, 1],
			[1, 2],
		]);
		expect(values[0]).toBeCloseTo(3, 10);
		expect(values[1]).toBeCloseTo(1, 10);
		expect(Math.abs(vectors[0][0])).toBeCloseTo(Math.SQRT1_2, 8);
		expect(Math.abs(vectors[1][0])).toBeCloseTo(Math.SQRT1_2, 8);
	});

	test("reconstructs the original matrix: A = V L V'", () => {
		// The decisive property. If this holds the decomposition is correct,
		// whatever the sign or ordering conventions.
		for (const seed of [71, 73, 79]) {
			const a = randomSymmetric(6, seed);
			const { values, vectors } = symmetricEigen(a);
			const lambda = values.map((value, i) =>
				values.map((_, j) => (i === j ? value : 0)),
			);
			closeTo(multiply(multiply(vectors, lambda), transpose(vectors)), a, 8);
		}
	});

	test("eigenvectors are orthonormal", () => {
		const a = randomSymmetric(5, 83);
		const { vectors } = symmetricEigen(a);
		closeTo(multiply(transpose(vectors), vectors), identity(5), 8);
	});

	test("each eigenpair satisfies A v = lambda v", () => {
		const a = randomSymmetric(4, 89);
		const { values, vectors } = symmetricEigen(a);
		for (let k = 0; k < 4; k++) {
			const v = vectors.map((row) => [row[k]]);
			closeTo(multiply(a, v), scale(v, values[k]), 8);
		}
	});

	test("eigenvalues come back in descending order", () => {
		const { values } = symmetricEigen(randomSymmetric(6, 97));
		for (let i = 1; i < values.length; i++) {
			expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
		}
	});

	test("handles an already diagonal matrix", () => {
		const { values } = symmetricEigen([
			[5, 0, 0],
			[0, 1, 0],
			[0, 0, 3],
		]);
		expect(values[0]).toBeCloseTo(5, 10);
		expect(values[1]).toBeCloseTo(3, 10);
		expect(values[2]).toBeCloseTo(1, 10);
	});

	test("handles repeated eigenvalues", () => {
		const { values, vectors } = symmetricEigen(scale(identity(4), 2.5));
		for (const value of values) expect(value).toBeCloseTo(2.5, 10);
		closeTo(multiply(transpose(vectors), vectors), identity(4), 10);
	});
});

describe("principalComponents", () => {
	test("scores are the centred data projected onto the loadings", () => {
		const data = randomMatrix(50, 4, 103);
		const pca = principalComponents(data, 4);
		const centred = data.map((row) => row.map((v, j) => v - pca.means[j]));
		closeTo(pca.scores, multiply(centred, pca.loadings), 8);
	});

	test("keeping every component reconstructs the data exactly", () => {
		const data = randomMatrix(40, 4, 107);
		const pca = principalComponents(data, 4);
		const rebuilt = multiply(pca.scores, transpose(pca.loadings)).map((row) =>
			row.map((v, j) => v + pca.means[j]),
		);
		closeTo(rebuilt, data, 8);
	});

	test("explained variance is descending and sums to one", () => {
		const pca = principalComponents(randomMatrix(80, 5, 109), 5);
		for (let i = 1; i < pca.explained.length; i++) {
			expect(pca.explained[i]).toBeLessThanOrEqual(pca.explained[i - 1]);
		}
		expect(pca.explained.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
	});

	test("each eigenvalue equals the sample variance of its score column", () => {
		// Pins the scale, not just the direction. Without this a covariance
		// divided by n instead of n-1 passes every other test here: the
		// eigenvectors and the explained shares are unchanged, only the
		// eigenvalues are wrong, by n/(n-1).
		const data = randomMatrix(60, 4, 131);
		const pca = principalComponents(data, 4);
		const n = pca.scores.length;

		for (let k = 0; k < 4; k++) {
			const column = pca.scores.map((row) => row[k]);
			const mean = column.reduce((a, b) => a + b, 0) / n;
			const variance = column.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
			expect(variance).toBeCloseTo(pca.eigenvalues[k], 8);
		}
	});

	test("scores are uncorrelated across components", () => {
		// The defining property of principal components.
		const pca = principalComponents(randomMatrix(200, 4, 113), 4);
		const n = pca.scores.length;
		for (let i = 0; i < 4; i++) {
			for (let j = i + 1; j < 4; j++) {
				const dot = pca.scores.reduce((s, row) => s + row[i] * row[j], 0) / n;
				expect(Math.abs(dot)).toBeLessThan(1e-8);
			}
		}
	});

	test("recovers a known dominant direction", () => {
		// Data lying almost entirely along (1,1), so PC1 must point there.
		const next = random(127);
		const data = Array.from({ length: 200 }, () => {
			const along = next() * 10;
			return [along + next() * 0.01, along + next() * 0.01];
		});
		const pca = principalComponents(data, 2);
		expect(pca.explained[0]).toBeGreaterThan(0.999);
		expect(Math.abs(pca.loadings[0][0])).toBeCloseTo(Math.SQRT1_2, 3);
		expect(Math.abs(pca.loadings[1][0])).toBeCloseTo(Math.SQRT1_2, 3);
	});
});
