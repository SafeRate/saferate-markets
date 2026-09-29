// PORTED VERBATIM from saferate-treasury packages/utils/src/functions/linearAlgebra.ts at 191d25a (2026-09-29).
// Change it there first, then here; tests/build/linearAlgebra.test.ts is ported with it.
/**
 * Dense linear algebra for the term structure models.
 *
 * Enough to run a principal components decomposition, a vector autoregression
 * and the affine pricing recursions, without pulling in a numerical library
 * that would not survive being bundled into a Worker. Everything here works on
 * plain arrays of arrays, row major.
 */

export type TMatrix = number[][];

export const zeros = (rows: number, columns: number): TMatrix =>
	Array.from({ length: rows }, () => new Array<number>(columns).fill(0));

export const identity = (size: number): TMatrix =>
	Array.from({ length: size }, (_, i) =>
		Array.from({ length: size }, (_, j) => (i === j ? 1 : 0)),
	);

export const transpose = (a: TMatrix): TMatrix =>
	a[0].map((_, j) => a.map((row) => row[j]));

export const multiply = (a: TMatrix, b: TMatrix): TMatrix => {
	const rows = a.length;
	const inner = b.length;
	const columns = b[0].length;

	if (a[0].length !== inner) {
		throw new Error(
			`Cannot multiply ${rows}x${a[0].length} by ${inner}x${columns}`,
		);
	}

	const result = zeros(rows, columns);
	for (let i = 0; i < rows; i++) {
		for (let k = 0; k < inner; k++) {
			const aik = a[i][k];
			if (aik === 0) continue;
			for (let j = 0; j < columns; j++) {
				result[i][j] += aik * b[k][j];
			}
		}
	}
	return result;
};

export const addMatrices = (a: TMatrix, b: TMatrix): TMatrix =>
	a.map((row, i) => row.map((value, j) => value + b[i][j]));

export const scale = (a: TMatrix, factor: number): TMatrix =>
	a.map((row) => row.map((value) => value * factor));

/** Solve A x = B for x, with partial pivoting. Null when A is singular. */
export const solveMatrix = (a: TMatrix, b: TMatrix): TMatrix | null => {
	const size = a.length;
	const width = b[0].length;
	const augmented = a.map((row, i) => [...row, ...b[i]]);

	for (let column = 0; column < size; column++) {
		let pivotRow = column;
		for (let row = column + 1; row < size; row++) {
			if (
				Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])
			) {
				pivotRow = row;
			}
		}
		const pivot = augmented[pivotRow][column];
		if (!Number.isFinite(pivot) || Math.abs(pivot) < 1e-13) {
			return null;
		}
		[augmented[column], augmented[pivotRow]] = [
			augmented[pivotRow],
			augmented[column],
		];

		for (let row = 0; row < size; row++) {
			if (row === column) continue;
			const factor = augmented[row][column] / augmented[column][column];
			for (let c = column; c < size + width; c++) {
				augmented[row][c] -= factor * augmented[column][c];
			}
		}
	}

	return augmented.map((row, i) =>
		row.slice(size).map((value) => value / augmented[i][i]),
	);
};

/**
 * Ordinary least squares of each column of Y on X, with an intercept.
 *
 * Returns coefficients with the intercept in the first row, so a fitted value
 * is `[1, x] * coefficients`.
 */
export const leastSquares = (
	x: TMatrix,
	y: TMatrix,
): { coefficients: TMatrix; residuals: TMatrix } | null => {
	const design = x.map((row) => [1, ...row]);
	const dt = transpose(design);
	const coefficients = solveMatrix(multiply(dt, design), multiply(dt, y));
	if (coefficients === null) {
		return null;
	}
	const fitted = multiply(design, coefficients);
	const residuals = y.map((row, i) => row.map((v, j) => v - fitted[i][j]));
	return { coefficients, residuals };
};

/**
 * Eigenvalues and eigenvectors of a symmetric matrix, by cyclic Jacobi
 * rotation.
 *
 * Chosen over anything fancier because a covariance matrix is symmetric and
 * small here, and Jacobi is unconditionally stable on symmetric input: it
 * cannot produce complex results or fail to converge the way a general
 * eigensolver can. Returned in descending order of eigenvalue, which is the
 * order principal components are wanted in.
 */
export const symmetricEigen = (
	input: TMatrix,
	maxSweeps = 100,
	tolerance = 1e-12,
): { values: number[]; vectors: TMatrix } => {
	const size = input.length;
	const a = input.map((row) => [...row]);
	const v = identity(size);

	for (let sweep = 0; sweep < maxSweeps; sweep++) {
		let off = 0;
		for (let p = 0; p < size; p++) {
			for (let q = p + 1; q < size; q++) {
				off += a[p][q] * a[p][q];
			}
		}
		if (Math.sqrt(off) < tolerance) break;

		for (let p = 0; p < size; p++) {
			for (let q = p + 1; q < size; q++) {
				if (Math.abs(a[p][q]) < tolerance) continue;

				const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
				const sign = theta >= 0 ? 1 : -1;
				const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
				const c = 1 / Math.sqrt(t * t + 1);
				const s = t * c;

				for (let k = 0; k < size; k++) {
					const akp = a[k][p];
					const akq = a[k][q];
					a[k][p] = c * akp - s * akq;
					a[k][q] = s * akp + c * akq;
				}
				for (let k = 0; k < size; k++) {
					const apk = a[p][k];
					const aqk = a[q][k];
					a[p][k] = c * apk - s * aqk;
					a[q][k] = s * apk + c * aqk;
				}
				for (let k = 0; k < size; k++) {
					const vkp = v[k][p];
					const vkq = v[k][q];
					v[k][p] = c * vkp - s * vkq;
					v[k][q] = s * vkp + c * vkq;
				}
			}
		}
	}

	const order = Array.from({ length: size }, (_, i) => i).sort(
		(i, j) => a[j][j] - a[i][i],
	);

	return {
		values: order.map((i) => a[i][i]),
		vectors: v.map((row) => order.map((i) => row[i])),
	};
};

export type TPrincipalComponents = {
	/** Column means removed before decomposition. */
	means: number[];
	/** Loadings, one column per component, in descending eigenvalue order. */
	loadings: TMatrix;
	eigenvalues: number[];
	/** Share of total variance explained by each component. */
	explained: number[];
	/** The data projected onto the components: one row per observation. */
	scores: TMatrix;
};

/** Principal components of a data matrix, one row per observation. */
export const principalComponents = (
	data: TMatrix,
	components: number,
): TPrincipalComponents => {
	const rows = data.length;
	const columns = data[0].length;
	const means = Array.from(
		{ length: columns },
		(_, j) => data.reduce((sum, row) => sum + row[j], 0) / rows,
	);
	const centred = data.map((row) => row.map((value, j) => value - means[j]));

	const covariance = zeros(columns, columns);
	for (let i = 0; i < columns; i++) {
		for (let j = i; j < columns; j++) {
			let total = 0;
			for (const row of centred) {
				total += row[i] * row[j];
			}
			covariance[i][j] = total / (rows - 1);
			covariance[j][i] = covariance[i][j];
		}
	}

	const { values, vectors } = symmetricEigen(covariance);
	const totalVariance = values.reduce(
		(sum, value) => sum + Math.max(value, 0),
		0,
	);

	const loadings = vectors.map((row) => row.slice(0, components));
	return {
		means,
		loadings,
		eigenvalues: values.slice(0, components),
		explained: values.slice(0, components).map((value) => value / totalVariance),
		scores: multiply(centred, loadings),
	};
};

export type TNnlsResult = {
	/** The solution, every entry at or above zero. */
	x: number[];
	/** `A'(b - Ax)`, the gradient. Zero where x is positive, at or below zero elsewhere. */
	gradient: number[];
	/** Squared norm of the residual `b - Ax`. */
	residualSumSquares: number;
	iterations: number;
	/** False if the iteration limit stopped it before the conditions were met. */
	converged: boolean;
};

/**
 * Least squares with every coefficient forced to be non-negative.
 *
 *   Lawson, C. and Hanson, R. (1974). *Solving Least Squares Problems*, ch. 23.
 *
 * Minimise `||Ax - b||` subject to `x >= 0`. Not the same thing as solving the
 * unconstrained problem and clamping the negatives to zero, which is the
 * tempting shortcut and is wrong: zeroing one coefficient changes what all the
 * others should be, and the clamped vector is generally not the constrained
 * optimum of anything.
 *
 * WHY THE CONSTRAINT IS THE POINT RATHER THAN A NUISANCE
 *
 * Where this gets used, a negative coefficient is a short position. An
 * immunising portfolio that shorts three Treasuries to match a liability's
 * exposure is a mathematically valid answer and an operationally useless one
 * for the institutions that immunise — pension funds, insurers, and anyone
 * running a matched book against a regulator. Non-negativity is what makes the
 * output implementable rather than merely optimal.
 *
 * HOW IT WORKS
 *
 * An active set method. Coefficients start at zero and in the active set; the
 * one whose gradient most wants it positive moves into the passive set; the
 * unconstrained least squares problem is solved on the passive set alone; and
 * if that pushes anything negative, the step is shortened until something hits
 * zero and is moved back. It terminates because each outer iteration strictly
 * decreases the residual and there are finitely many sets.
 *
 * The stopping conditions are the Karush-Kuhn-Tucker conditions, which is why
 * `gradient` is returned: at the solution it must be zero on every positive
 * coefficient and at or below zero on every zero one. A caller can check the
 * answer without trusting the loop, and the tests do exactly that.
 */
export const nonNegativeLeastSquares = ({
	a,
	b,
	tolerance = 1e-10,
	maxIterations,
}: {
	/** Rows are observations, columns are coefficients. */
	a: TMatrix;
	/** One entry per row of `a`. */
	b: number[];
	tolerance?: number;
	maxIterations?: number;
}): TNnlsResult => {
	const rows = a.length;
	if (rows === 0) {
		return {
			x: [],
			gradient: [],
			residualSumSquares: 0,
			iterations: 0,
			converged: true,
		};
	}
	const columns = a[0].length;
	if (b.length !== rows) {
		throw new Error(
			`Design has ${rows} rows and the target has ${b.length} entries`,
		);
	}
	const limit = maxIterations ?? 3 * columns + 30;

	const x = new Array<number>(columns).fill(0);
	const passive = new Array<boolean>(columns).fill(false);

	/** `A'(b - Ax)` for the current x. */
	const gradientAt = (current: number[]): number[] => {
		const residual = b.map((value, i) => {
			let fitted = 0;
			for (let j = 0; j < columns; j++) fitted += a[i][j] * current[j];
			return value - fitted;
		});
		return Array.from({ length: columns }, (_, j) => {
			let total = 0;
			for (let i = 0; i < rows; i++) total += a[i][j] * residual[i];
			return total;
		});
	};

	/**
	 * Unconstrained least squares on the passive columns only, by the normal
	 * equations. Fine at this scale: the design is a dozen key rates against a
	 * few hundred securities, and its columns are durations of the same order,
	 * so the conditioning that makes normal equations a poor idea in general
	 * does not arise. A singular passive set returns null and the caller stops.
	 */
	const solvePassive = (): number[] | null => {
		const index: number[] = [];
		for (let j = 0; j < columns; j++) if (passive[j]) index.push(j);
		if (index.length === 0) return new Array<number>(columns).fill(0);

		const size = index.length;
		const normal: TMatrix = Array.from({ length: size }, () =>
			new Array<number>(size).fill(0),
		);
		const rhs: TMatrix = Array.from({ length: size }, () => [0]);
		for (let p = 0; p < size; p++) {
			for (let i = 0; i < rows; i++) rhs[p][0] += a[i][index[p]] * b[i];
			for (let q = 0; q < size; q++) {
				let total = 0;
				for (let i = 0; i < rows; i++) {
					total += a[i][index[p]] * a[i][index[q]];
				}
				normal[p][q] = total;
			}
		}
		const solved = solveMatrix(normal, rhs);
		if (solved === null) return null;
		const out = new Array<number>(columns).fill(0);
		for (let p = 0; p < size; p++) out[index[p]] = solved[p][0];
		return out;
	};

	let iterations = 0;
	let converged = false;

	for (;;) {
		const gradient = gradientAt(x);
		let candidate = -1;
		let best = tolerance;
		for (let j = 0; j < columns; j++) {
			if (!passive[j] && gradient[j] > best) {
				best = gradient[j];
				candidate = j;
			}
		}
		// Every inactive coefficient is already pushing the wrong way, which is
		// the Karush-Kuhn-Tucker condition for optimality.
		if (candidate === -1) {
			converged = true;
			break;
		}
		if (iterations >= limit) break;

		passive[candidate] = true;
		for (;;) {
			iterations++;
			const trial = solvePassive();
			if (trial === null) {
				// A singular passive set means the column added nothing new. Put it
				// back and stop rather than pivoting on a rank deficiency.
				passive[candidate] = false;
				converged = true;
				break;
			}
			let worst = Number.POSITIVE_INFINITY;
			for (let j = 0; j < columns; j++) {
				if (passive[j] && trial[j] < worst) worst = trial[j];
			}
			if (worst > 0) {
				for (let j = 0; j < columns; j++) x[j] = passive[j] ? trial[j] : 0;
				break;
			}

			// Move as far towards the trial point as non-negativity allows, then
			// release whatever reached zero.
			let step = 1;
			for (let j = 0; j < columns; j++) {
				if (!passive[j] || trial[j] > 0) continue;
				const denominator = x[j] - trial[j];
				if (denominator <= 0) continue;
				step = Math.min(step, x[j] / denominator);
			}
			for (let j = 0; j < columns; j++) {
				if (!passive[j]) continue;
				x[j] += step * (trial[j] - x[j]);
				if (x[j] <= tolerance) {
					x[j] = 0;
					passive[j] = false;
				}
			}
			if (iterations >= limit) break;
		}
		if (converged) break;
		if (iterations >= limit) break;
	}

	const gradient = gradientAt(x);
	let residualSumSquares = 0;
	for (let i = 0; i < rows; i++) {
		let fitted = 0;
		for (let j = 0; j < columns; j++) fitted += a[i][j] * x[j];
		residualSumSquares += (b[i] - fitted) ** 2;
	}

	return { x, gradient, residualSumSquares, iterations, converged };
};
