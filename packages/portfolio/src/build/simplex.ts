// PORTED from saferate-treasury packages/utils/src/functions/simplex.ts at 191d25a (2026-09-29), plus its PR #11
// (maxIterations, made here first). Change it there first, then here; tests/build/simplex.test.ts is ported with it.
/**
 * A linear programme solver, by the two-phase tableau simplex.
 *
 *   Chvátal, V. (1983). *Linear Programming* — the clearest treatment, and the
 *   source for Bland's rule and the degeneracy discussion below.
 *
 * Written rather than installed for the reason every numeric here is: a
 * dependency would be a black box in the middle of a result nobody could then
 * check. It exists to serve the cash flow matching optimiser, which is a mixed
 * integer programme whose relaxation is solved at every node of a search tree,
 * so this gets called thousands of times per problem and has to be both correct
 * and unexcitable.
 *
 * DEGENERACY IS THE WHOLE DIFFICULTY, AND IT IS NOT INCIDENTAL HERE
 *
 * A degenerate vertex is one where a basic variable sits at zero, so a pivot
 * moves the basis without moving the point or the objective. A run of those can
 * close into a cycle and the solver spins for ever on a problem that looks
 * small. Textbook examples have to be constructed carefully; the cash matching
 * problem produces them by accident, constantly, because the optimal portfolio
 * runs surplus down to exactly zero on many dates at once and every one of
 * those is a constraint binding at zero.
 *
 * Two pivot rules, and the solver uses both:
 *
 *   Dantzig — enter on the most negative reduced cost. Fast, and can cycle.
 *   Bland   — enter on the *lowest indexed* column with a negative reduced
 *             cost, break ratio ties by lowest index too. Provably terminates,
 *             and is slow enough that using it throughout would be felt.
 *
 * Dantzig runs until the objective stops improving for `STALL_LIMIT`
 * iterations, then Bland's takes over permanently for that solve. A cycle
 * cannot survive the switch, and problems that never stall never pay for it.
 *
 * ON READING THE DUALS
 *
 * The dual on a constraint is what the objective would improve by if that
 * constraint were relaxed by one unit. For cash matching that is the marginal
 * cost of covering each liability date, which says which dates are expensive to
 * fund — genuinely useful, and nearly free once the tableau is solved. Getting
 * it out requires keeping the artificial columns in the tableau through phase
 * two rather than deleting them, since each is a unit column on its own row and
 * its reduced cost is therefore the negated dual. They are barred from
 * re-entering the basis instead.
 */

/** Values below this are treated as zero when choosing pivots. */
const TOLERANCE = 1e-9;

/**
 * Iterations without objective improvement before switching to Bland's rule.
 *
 * Generous, because switching early is pure cost on the overwhelming majority
 * of solves and the switch only has to happen before a cycle completes — and a
 * cycle cannot complete without stalling first, by definition.
 */
const STALL_LIMIT = 50;

export type TConstraintRelation = "<=" | ">=" | "=";

export type TLinearConstraint = {
	/** One coefficient per variable. Shorter arrays are padded with zeros. */
	coefficients: number[];
	relation: TConstraintRelation;
	bound: number;
};

export type TLinearProgram = {
	/** Coefficients of the objective, which is always MINIMISED. */
	objective: number[];
	constraints: TLinearConstraint[];
	/**
	 * Pivots allowed across both phases before giving up with status
	 * "iteration-limit". Default 10 x (rows + columns).
	 *
	 * Bland's rule guarantees termination in exact arithmetic, not in floating
	 * point. Measured 2026-09-29 in saferate-markets: a branch-and-bound node of
	 * the cash-flow matcher (609 rows, 1,217 columns, face amounts beside 0-1
	 * indicators) switched to Bland's rule and was still pivoting after 100,000
	 * iterations with its objective swinging between -1e10 and -1e16, while
	 * healthy nodes of the same programme finish in 50 to 300. With no limit the
	 * solve never returned and the Worker serving it was killed.
	 */
	maxIterations?: number;
};

export type TSimplexStatus =
	| "optimal"
	| "infeasible"
	| "unbounded"
	/** Gave up after maxIterations: numerically unsound, not an answer. */
	| "iteration-limit";

export type TSimplexSolution = {
	status: TSimplexStatus;
	/** The solution, or all zeros where there is not one. */
	x: number[];
	objectiveValue: number;
	/**
	 * One dual per constraint, in the order supplied.
	 *
	 * Signed so that a positive dual on a binding `>=` constraint means
	 * tightening it costs money, which is the reading a user expects. Zero
	 * everywhere the problem was not solved to optimality.
	 */
	duals: number[];
	iterations: number;
	/** True if the run ended on Bland's rule, which is worth knowing about. */
	usedBlandRule: boolean;
};

type TTableau = {
	// Typed arrays: allocated zeroed by the engine, and the same doubles.
	rows: Float64Array[];
	objective: Float64Array;
	basis: number[];
	columns: number;
};

/** Pivot the tableau on one entry, normalising the row and clearing the column. */
const pivot = (tableau: TTableau, row: number, column: number): void => {
	const pivotRow = tableau.rows[row];
	const pivotValue = pivotRow[column];
	// Only the pivot row's non-zero columns can change anything: subtracting
	// factor x 0 is a no-op. The matcher's tableaus are mostly zeros (each
	// indicator row touches two columns), so this is the same arithmetic in a
	// fraction of the time. Measured 2026-09-29 on the capped real-universe
	// match: see saferate-markets packages/portfolio/tests/builder.test.ts.
	const nonZero: number[] = [];
	for (let j = 0; j < pivotRow.length; j++) {
		pivotRow[j] /= pivotValue;
		if (pivotRow[j] !== 0) nonZero.push(j);
	}

	for (let i = 0; i < tableau.rows.length; i++) {
		if (i === row) continue;
		const factor = tableau.rows[i][column];
		if (factor === 0) continue;
		const target = tableau.rows[i];
		for (const j of nonZero) target[j] -= factor * pivotRow[j];
	}

	const objectiveFactor = tableau.objective[column];
	if (objectiveFactor !== 0) {
		for (const j of nonZero)
			tableau.objective[j] -= objectiveFactor * pivotRow[j];
	}
	tableau.basis[row] = column;
};

/**
 * One simplex phase: "done" at an optimum, "unbounded", or "limit" when the
 * iteration budget in `state` runs out.
 *
 * `allowed` gates which columns may enter, which is how artificial variables
 * are frozen out of phase two while their columns stay in the tableau for the
 * duals to be read from.
 */
const runPhase = (
	tableau: TTableau,
	allowed: (column: number) => boolean,
	state: { iterations: number; usedBlandRule: boolean; maxIterations: number },
): "done" | "unbounded" | "limit" => {
	let stalls = 0;
	let previousObjective = tableau.objective[tableau.columns];
	let bland = false;

	for (;;) {
		// Entering column.
		let entering = -1;
		if (bland) {
			for (let j = 0; j < tableau.columns; j++) {
				if (allowed(j) && tableau.objective[j] < -TOLERANCE) {
					entering = j;
					break;
				}
			}
		} else {
			let best = -TOLERANCE;
			for (let j = 0; j < tableau.columns; j++) {
				if (allowed(j) && tableau.objective[j] < best) {
					best = tableau.objective[j];
					entering = j;
				}
			}
		}
		if (entering === -1) return "done";

		// Leaving row, by the minimum ratio test. Ties broken on the lowest
		// basis index under Bland's rule, which is the half of the rule that is
		// usually forgotten and without which it does not terminate.
		let leaving = -1;
		let bestRatio = Number.POSITIVE_INFINITY;
		for (let i = 0; i < tableau.rows.length; i++) {
			const coefficient = tableau.rows[i][entering];
			if (coefficient <= TOLERANCE) continue;
			const ratio = tableau.rows[i][tableau.columns] / coefficient;
			if (ratio < bestRatio - TOLERANCE) {
				bestRatio = ratio;
				leaving = i;
			} else if (ratio < bestRatio + TOLERANCE && leaving !== -1) {
				if (bland && tableau.basis[i] < tableau.basis[leaving]) leaving = i;
			}
		}
		if (leaving === -1) return "unbounded";
		if (state.iterations >= state.maxIterations) return "limit";

		pivot(tableau, leaving, entering);
		state.iterations++;

		const objective = tableau.objective[tableau.columns];
		if (objective > previousObjective - TOLERANCE) {
			stalls++;
			if (stalls > STALL_LIMIT && !bland) {
				bland = true;
				state.usedBlandRule = true;
			}
		} else {
			stalls = 0;
		}
		previousObjective = objective;
	}
};

/**
 * Solve a linear programme in the form `minimise c'x subject to constraints`,
 * with every variable non-negative.
 *
 * Bounds on variables are not a separate concept here: pass them as ordinary
 * constraints. A bounded-variable simplex handles them implicitly and is
 * meaningfully faster on problems with many of them, which this will eventually
 * want; it is also a second pivot path to get wrong, and correctness came
 * first. The tableau grows by one row per bound, which the caller can see.
 */
export const solveLinearProgram = ({
	objective,
	constraints,
	maxIterations,
}: TLinearProgram): TSimplexSolution => {
	const variables = objective.length;
	if (variables === 0) {
		return {
			status: "optimal",
			x: [],
			objectiveValue: 0,
			duals: constraints.map(() => 0),
			iterations: 0,
			usedBlandRule: false,
		};
	}

	// Every row is normalised to a non-negative bound first, because the sign of
	// the bound decides which slack the row needs and flipping it afterwards is
	// where sign errors live.
	const normalised = constraints.map(({ coefficients, relation, bound }) => {
		// Already full length (the matcher's rows are), it is read, never written.
		const padded =
			coefficients.length === variables
				? coefficients
				: Array.from({ length: variables }, (_, j) => coefficients[j] ?? 0);
		if (bound < 0) {
			return {
				coefficients: padded.map((value) => -value),
				relation: relation === "<=" ? ">=" : relation === ">=" ? "<=" : "=",
				bound: -bound,
				flipped: true,
			} as const;
		}
		return { coefficients: padded, relation, bound, flipped: false } as const;
	});

	// Column layout: originals, then one slack or surplus per inequality, then
	// one artificial per row that needs a starting basis.
	const slackOf: number[] = [];
	const artificialOf: number[] = [];
	let column = variables;
	for (const row of normalised) {
		slackOf.push(row.relation === "=" ? -1 : column++);
	}
	const firstArtificial = column;
	for (const row of normalised) {
		// A `<=` row with a non-negative bound already has a basic slack.
		artificialOf.push(row.relation === "<=" ? -1 : column++);
	}
	const columns = column;

	const rows: Float64Array[] = normalised.map((row, i) => {
		const line = new Float64Array(columns + 1);
		for (let j = 0; j < variables; j++) line[j] = row.coefficients[j];
		if (slackOf[i] >= 0) {
			line[slackOf[i]] = row.relation === "<=" ? 1 : -1;
		}
		if (artificialOf[i] >= 0) line[artificialOf[i]] = 1;
		line[columns] = row.bound;
		return line;
	});

	const basis = normalised.map((_, i) =>
		artificialOf[i] >= 0 ? artificialOf[i] : slackOf[i],
	);
	const tableau: TTableau = {
		rows,
		objective: new Float64Array(columns + 1),
		basis,
		columns,
	};
	const state = {
		iterations: 0,
		usedBlandRule: false,
		maxIterations: maxIterations ?? 10 * (rows.length + columns),
	};
	const exhausted = (): TSimplexSolution => ({
		status: "iteration-limit",
		x: new Array<number>(variables).fill(0),
		objectiveValue: Number.NaN,
		duals: constraints.map(() => 0),
		iterations: state.iterations,
		usedBlandRule: state.usedBlandRule,
	});
	const failed: TSimplexSolution = {
		status: "infeasible",
		x: new Array<number>(variables).fill(0),
		objectiveValue: 0,
		duals: constraints.map(() => 0),
		iterations: 0,
		usedBlandRule: false,
	};

	// Phase one: drive the artificials to zero. Skipped when there are none,
	// which is the common case for a problem written entirely in `<=` form.
	if (firstArtificial < columns) {
		for (let j = firstArtificial; j < columns; j++) tableau.objective[j] = 1;
		// Price out the artificials so the objective row is consistent with the
		// starting basis rather than merely written down.
		for (let i = 0; i < rows.length; i++) {
			if (artificialOf[i] < 0) continue;
			for (let j = 0; j <= columns; j++) {
				tableau.objective[j] -= rows[i][j];
			}
		}
		const phaseOne = runPhase(tableau, () => true, state);
		if (phaseOne === "limit") return exhausted();
		if (phaseOne === "unbounded") {
			return { ...failed, iterations: state.iterations };
		}
		if (-tableau.objective[columns] > 1e-7) {
			return {
				...failed,
				iterations: state.iterations,
				usedBlandRule: state.usedBlandRule,
			};
		}
		// An artificial left in the basis at zero is a redundant constraint, not
		// an infeasibility. Pivot it out onto any real column with a non-zero
		// entry; if there is none the row is all zeros and can be left alone.
		for (let i = 0; i < rows.length; i++) {
			if (tableau.basis[i] < firstArtificial) continue;
			for (let j = 0; j < firstArtificial; j++) {
				if (Math.abs(rows[i][j]) > TOLERANCE) {
					pivot(tableau, i, j);
					break;
				}
			}
		}
	}

	// Phase two on the real objective, with the artificials frozen.
	tableau.objective = new Float64Array(columns + 1);
	for (let j = 0; j < variables; j++) tableau.objective[j] = objective[j];
	for (let i = 0; i < rows.length; i++) {
		const basic = tableau.basis[i];
		if (basic >= variables) continue;
		const cost = tableau.objective[basic];
		if (cost === 0) continue;
		for (let j = 0; j <= columns; j++) {
			tableau.objective[j] -= cost * rows[i][j];
		}
	}

	const allowed = (j: number) => j < firstArtificial;
	const phaseTwo = runPhase(tableau, allowed, state);
	if (phaseTwo === "limit") return exhausted();
	if (phaseTwo === "unbounded") {
		return {
			status: "unbounded",
			x: new Array<number>(variables).fill(0),
			objectiveValue: Number.NEGATIVE_INFINITY,
			duals: constraints.map(() => 0),
			iterations: state.iterations,
			usedBlandRule: state.usedBlandRule,
		};
	}

	const x = new Array<number>(variables).fill(0);
	for (let i = 0; i < rows.length; i++) {
		const basic = tableau.basis[i];
		if (basic < variables) x[basic] = rows[i][columns];
	}

	// The dual on a row is read from its own unit column: the artificial where
	// there is one, otherwise the slack. Both enter the tableau as +e_i on a
	// `>=`-normalised or `<=` row respectively, so the sign convention differs
	// between them and is undone here rather than left to the caller.
	const duals = normalised.map((row, i) => {
		let value: number;
		if (artificialOf[i] >= 0) {
			value = -tableau.objective[artificialOf[i]];
		} else {
			value = -tableau.objective[slackOf[i]];
		}
		// A row whose bound was negated had its whole inequality reflected, so
		// its dual is reflected with it.
		return row.flipped ? -value : value;
	});

	return {
		status: "optimal",
		x,
		objectiveValue: -tableau.objective[columns],
		duals,
		iterations: state.iterations,
		usedBlandRule: state.usedBlandRule,
	};
};
