// PORTED from saferate-treasury (verbatim but for the empty-universe guard in matchCashflows) packages/utils/src/functions/cashflowMatching.ts at 191d25a (2026-09-29).
// Change it there first, then here; tests/build/cashflowMatching.test.ts is ported with it.
/**
 * Cash flow matching: the cheapest operable portfolio that covers a liability
 * stream.
 *
 *   Ronn, E. (1987). "A New Linear Programming Approach to Bond Portfolio
 *   Management." *JFQA* 22(4).
 *   Wolsey, L. (1998). *Integer Programming* — branch and bound, and why the
 *   big-M governs how long it takes.
 *
 * Given liabilities on dates and a universe of securities, return face amounts
 * to buy. Prescriptive rather than descriptive: the output is a shopping list,
 * and a cash matched portfolio has no reinvestment risk by construction, which
 * removes the risk the simulation module exists to measure.
 *
 * WHY THIS IS A MIXED INTEGER PROGRAMME AND NOT A LINEAR ONE
 *
 * The textbook version is a linear programme, and a linear programme will
 * happily return forty positions of six thousand dollars each. Nobody can trade
 * that. The position count and the minimum lot are what make the output a
 * portfolio rather than an answer, and they are what force the integers.
 *
 * THE SURPLUS RECURSION IS EXPANDED RATHER THAN CARRIED
 *
 * Surplus rolls forward: whatever is left after one date is available for the
 * next. Written literally that needs a variable per date and a chain of
 * equalities. Unrolling it instead — each date's constraint is the accumulated
 * inflow to that date against the accumulated liability, both compounded at the
 * reinvestment rate — leaves one inequality per date and no extra variables.
 * The two are the same programme; this one is a third the size.
 *
 * THE BIG-M IS THE PERFORMANCE STORY
 *
 * `x_i <= M_i y_i` is only as good as its M. A loose one makes the relaxation
 * nearly useless, its bound nearly worthless, and the search exponential.
 *
 * The brief this was built from proposes the total remaining liability over the
 * security's *smallest* positive cashflow. That is valid and it is far too
 * loose to use. A bond with a small coupon has a smallest cashflow of well
 * under a point, so on a real eight year stream it produces bounds around 1e10
 * — four orders of magnitude above any face anyone would buy, and the search
 * never finishes.
 *
 * The bound used instead is
 *
 *   M_i = max over dates t of  accumulatedLiability(t) / accumulatedCashflow(t)
 *
 * which is tighter and still valid, and the argument is short. Suppose an
 * optimal `x_i` exceeded that maximum. Then at *every* date the security's own
 * accumulated delivery already exceeds the accumulated liability, so cutting it
 * back to the maximum leaves every constraint satisfied — by that security
 * alone — at strictly lower cost, which contradicts optimality. Accumulated
 * rather than per-date because surplus carries forward, so it is the running
 * total that has to be covered and not each date in isolation.
 *
 * Measured on a real universe this is the difference between a search that
 * finishes and one that does not.
 *
 * PRICES: THE ASK, AND FILTER THE UNPRICED
 *
 * A buyer pays the ask. Optimising against the close understates the cost by
 * roughly two cents in a calm year and six in 2020, which on a large dedication
 * is real money that is really paid. And a security quoted at zero is not free,
 * it is unquoted: `eligibleForMatching` drops them, because an optimiser that
 * believes them will buy nothing else.
 */

import { solveLinearProgram, type TLinearConstraint } from "./simplex";

export type TMatchingSecurity = {
	cusip: string;
	/** Ask price per 100 of face, dirty. Must be positive. */
	askPrice: number;
	/**
	 * Cashflow per 100 of face on each liability date, aligned with the
	 * liabilities array. Cashflows falling between liability dates belong on the
	 * next date at or after them, which is the conservative placement: money
	 * that arrives early can wait, money that arrives late cannot.
	 */
	cashflows: number[];
};

export type TLiability = {
	/** Label for reporting; a date string in practice. */
	date: string;
	/** Amount due, in dollars. */
	amount: number;
};

export type TMatchingOptions = {
	/** Most positions the portfolio may hold. */
	maxPositions?: number;
	/** Smallest face amount worth holding, in dollars. Zero disables the rule. */
	minLot?: number;
	/** Largest face in any one security, in dollars. */
	maxPosition?: number;
	/**
	 * Rate earned on surplus carried forward, per period between liabilities.
	 *
	 * Zero by default, which is conservative and defensible. Reinvesting at the
	 * curve's own forward rates is a later refinement and deliberately out of
	 * scope: a dedication that depends on earning a forecast rate is no longer a
	 * dedication.
	 */
	reinvestmentRate?: number;
	/** Face amounts are rounded down to a multiple of this. */
	denomination?: number;
	/** Give up after this many branch and bound nodes. */
	maxNodes?: number;
	/**
	 * Simplex pivots allowed across the whole search, relaxation included.
	 * Default 25,000. Nodes are what maxNodes counts, but one node can cost a
	 * thousand times another (see solveLinearProgram's maxIterations), and a
	 * Worker has no clock that moves during computation, so pivots are the
	 * budget that bounds the time. A search that runs out stops like one that
	 * hits maxNodes: its best portfolio so far, not proven optimal.
	 */
	maxPivots?: number;
};

export type TMatchingPosition = {
	cusip: string;
	/** Face amount to buy, in dollars. */
	faceValue: number;
	/** What it costs, in dollars. */
	cost: number;
};

export type TMatchingFailure =
	/** No portfolio covers the stream, whatever the position limits. */
	| { kind: "uncoverable"; date: string; message: string }
	/** Coverable, but not within the position cap. */
	| { kind: "position-cap"; needed: number; message: string }
	/** The search hit its node or pivot budget without proving anything. */
	| { kind: "node-limit"; message: string };

export type TMatchingResult = {
	positions: TMatchingPosition[];
	/** Total cost in dollars, at the ask. */
	cost: number;
	/** Surplus carried out of each liability date, in dollars. */
	surplus: number[];
	/**
	 * The linear relaxation's cost, which no integer solution can beat.
	 *
	 * Reported because the gap to it is the price of operability: what the
	 * position count and lot size cost against a portfolio nobody could trade.
	 */
	relaxationCost: number;
	/**
	 * Marginal cost of one more dollar due on each liability date.
	 *
	 * From the relaxation's duals, so it prices the liability stream rather than
	 * the integer portfolio. Says which dates are expensive to fund, which is
	 * the question a liability manager asks before the shopping list.
	 */
	marginalCostByDate: number[];
	nodesExplored: number;
	/** False when the node budget stopped the search before it proved optimality. */
	provenOptimal: boolean;
};

/**
 * Drop securities nothing can be bought at, or that pay nothing.
 *
 * Seven per cent of the price table carries an ask of zero, which means
 * unquoted rather than free. A security with no positive cashflow on any
 * liability date cannot contribute either, and leaving it in only widens the
 * search.
 */
export const eligibleForMatching = (
	securities: TMatchingSecurity[],
): TMatchingSecurity[] =>
	securities.filter(
		(security) =>
			security.askPrice > 0 && security.cashflows.some((cashflow) => cashflow > 0),
	);

/**
 * The largest face of a security that could ever appear in an optimal answer.
 *
 * See the module header for why this shape rather than the looser one, and for
 * the argument that it is still valid. Returns zero for a security that never
 * pays inside the horizon, which switches it off entirely.
 */
const bigM = ({
	accumulatedCashflow,
	accumulatedLiabilities,
	maxPosition,
}: {
	/** Per 100 of face, accumulated to each date. */
	accumulatedCashflow: number[];
	accumulatedLiabilities: number[];
	maxPosition: number;
}): number => {
	let largest = 0;
	for (let t = 0; t < accumulatedCashflow.length; t++) {
		const delivered = accumulatedCashflow[t];
		if (delivered <= 0) continue;
		const needed = (accumulatedLiabilities[t] * 100) / delivered;
		if (needed > largest) largest = needed;
	}
	if (largest <= 0) return 0;
	return Math.min(maxPosition, largest);
};

/** Accumulated liability to each date, compounded at the reinvestment rate. */
const accumulatedLiability = (
	liabilities: TLiability[],
	rate: number,
): number[] => {
	const out: number[] = [];
	let running = 0;
	for (const liability of liabilities) {
		running = running * (1 + rate) + liability.amount;
		out.push(running);
	}
	return out;
};

/** Accumulated cashflow per 100 of face to each date, same compounding. */
const accumulatedCashflows = (
	security: TMatchingSecurity,
	dates: number,
	rate: number,
): number[] => {
	const out: number[] = [];
	let running = 0;
	for (let t = 0; t < dates; t++) {
		running = running * (1 + rate) + (security.cashflows[t] ?? 0);
		out.push(running);
	}
	return out;
};

/** Surplus carried out of each date, for a given set of face amounts. */
const surplusPath = ({
	securities,
	faces,
	liabilities,
	rate,
}: {
	securities: TMatchingSecurity[];
	faces: number[];
	liabilities: TLiability[];
	rate: number;
}): number[] => {
	const path: number[] = [];
	let running = 0;
	for (let t = 0; t < liabilities.length; t++) {
		let inflow = 0;
		for (let i = 0; i < securities.length; i++) {
			inflow += ((securities[i].cashflows[t] ?? 0) * faces[i]) / 100;
		}
		running = running * (1 + rate) + inflow - liabilities[t].amount;
		path.push(running);
	}
	return path;
};

/**
 * Build the relaxed programme, optionally with the integer machinery.
 *
 * Variables are the face amounts of the securities still in play, followed by
 * the indicators of those still FREE. When `withIndicators` is false there are
 * no indicators at all, which is the pure linear dedication used both for the
 * lower bound and for telling the two kinds of infeasibility apart.
 *
 * PINNED INDICATORS ARE NOT VARIABLES. A security branched to 0 is left out;
 * one branched to 1 keeps its face with a plain bound (and the minimum lot),
 * and uses up one of the cap. Until 2026-09-29 a pin was an equality row on a
 * full-width indicator, so every node carried one artificial variable per
 * security for phase one to drive out: the seeds of a 6-position cap on the
 * real universe (609 rows, 1,217 columns) exhausted their pivot budget
 * without a basis, and one node diverged past 100,000 pivots with its
 * objective at -1e16. A fully pinned seed is now a ten-variable programme.
 *
 * SCALED. Faces are in units of `unit` (the largest accumulated liability),
 * so bounds, big-M caps and lots are divided by it; the objective's
 * coefficients are unchanged, so its value is in units too and the duals are
 * exactly the unscaled ones. `expand` returns x in the full dollar layout
 * (n faces, then n indicators when withIndicators).
 */
const buildProgram = ({
	securities,
	liabilities,
	rate,
	limits,
	withIndicators,
	fixed,
}: {
	securities: TMatchingSecurity[];
	liabilities: TLiability[];
	rate: number;
	limits: { maxPositions: number; minLot: number; maxPosition: number };
	withIndicators: boolean;
	/** Indicators pinned by branching: 0, 1, or undefined for free. */
	fixed: (0 | 1 | undefined)[];
}) => {
	const n = securities.length;
	const active = securities
		.map((_, i) => i)
		.filter((i) => !withIndicators || fixed[i] !== 0);
	const free = withIndicators
		? active.filter((i) => fixed[i] === undefined)
		: [];
	const held = withIndicators ? active.filter((i) => fixed[i] === 1) : [];
	const m = active.length;
	const variables = m + free.length;
	/** Column of each free security's indicator. */
	const indicatorOf = new Map(free.map((i, k) => [i, m + k]));

	const objective = new Array<number>(variables).fill(0);
	active.forEach((i, j) => {
		objective[j] = securities[i].askPrice / 100;
	});

	const constraints: TLinearConstraint[] = [];

	// One row per liability date: accumulated inflow must cover accumulated
	// liability. This is the unrolled surplus recursion.
	const dollars = accumulatedLiability(liabilities, rate);
	const unit = Math.max(1, ...dollars);
	const accumulated = dollars.map((amount) => amount / unit);
	const perSecurity = securities.map((security) =>
		accumulatedCashflows(security, liabilities.length, rate),
	);
	for (let t = 0; t < liabilities.length; t++) {
		const coefficients = new Array<number>(variables).fill(0);
		active.forEach((i, j) => {
			coefficients[j] = perSecurity[i][t] / 100;
		});
		constraints.push({
			coefficients,
			relation: ">=",
			bound: accumulated[t],
		});
	}

	const expand = (x: number[]) => {
		const full = new Array<number>(withIndicators ? 2 * n : n).fill(0);
		active.forEach((i, j) => {
			full[i] = x[j] * unit;
		});
		if (withIndicators) {
			for (const i of held) full[n + i] = 1;
			for (const [i, column] of indicatorOf) full[n + i] = x[column];
		}
		return full;
	};

	if (!withIndicators) {
		active.forEach((_, j) => {
			const coefficients = new Array<number>(variables).fill(0);
			coefficients[j] = 1;
			constraints.push({
				coefficients,
				relation: "<=",
				bound: limits.maxPosition / unit,
			});
		});
		return { objective, constraints, unit, expand };
	}

	active.forEach((i, j) => {
		const cap = bigM({
			accumulatedCashflow: perSecurity[i],
			accumulatedLiabilities: accumulated,
			maxPosition: limits.maxPosition / unit,
		});
		const indicator = indicatorOf.get(i);
		if (indicator === undefined) {
			// Held: x_i <= M_i, and x_i >= minLot.
			const upper = new Array<number>(variables).fill(0);
			upper[j] = 1;
			constraints.push({ coefficients: upper, relation: "<=", bound: cap });
			if (limits.minLot > 0) {
				const lower = new Array<number>(variables).fill(0);
				lower[j] = 1;
				constraints.push({
					coefficients: lower,
					relation: ">=",
					bound: limits.minLot / unit,
				});
			}
			return;
		}

		// x_i - M_i y_i <= 0
		const upper = new Array<number>(variables).fill(0);
		upper[j] = 1;
		upper[indicator] = -cap;
		constraints.push({ coefficients: upper, relation: "<=", bound: 0 });

		if (limits.minLot > 0) {
			// x_i - minLot y_i >= 0
			const lower = new Array<number>(variables).fill(0);
			lower[j] = 1;
			lower[indicator] = -limits.minLot / unit;
			constraints.push({ coefficients: lower, relation: ">=", bound: 0 });
		}

		const bound = new Array<number>(variables).fill(0);
		bound[indicator] = 1;
		constraints.push({ coefficients: bound, relation: "<=", bound: 1 });
	});

	// The cap, less what is already held. Negative means this node is
	// infeasible, which the programme reports on its own.
	const cardinality = new Array<number>(variables).fill(0);
	for (const column of indicatorOf.values()) cardinality[column] = 1;
	constraints.push({
		coefficients: cardinality,
		relation: "<=",
		bound: limits.maxPositions - held.length,
	});

	return { objective, constraints, unit, expand };
};

/**
 * Solve the dedication problem.
 *
 * Returns the failure rather than an approximation when there is one. A
 * portfolio that nearly covers the liabilities is worse than an honest failure,
 * because the shortfall is discovered on the date it falls due.
 */
export const matchCashflows = ({
	securities: supplied,
	liabilities,
	options = {},
}: {
	securities: TMatchingSecurity[];
	liabilities: TLiability[];
	options?: TMatchingOptions;
}): TMatchingResult | TMatchingFailure => {
	const securities = eligibleForMatching(supplied);
	const rate = options.reinvestmentRate ?? 0;
	const denomination = options.denomination ?? 0;
	const maxNodes = options.maxNodes ?? 5000;
	let pivotsLeft = options.maxPivots ?? 25_000;
	/** Solves that gave up numerically: their subtrees were not searched. */
	let unsound = 0;
	/**
	 * Every solve goes through here: capped at three pivots per row (healthy
	 * solves of the 609-row programme take 50 to 300) and at what is left of
	 * the search's budget.
	 */
	const solve = (program: ReturnType<typeof buildProgram>) => {
		const perSolve = Math.max(1_000, 3 * program.constraints.length);
		const allowed = Math.max(0, Math.min(pivotsLeft, perSolve));
		const solution = solveLinearProgram({
			objective: program.objective,
			constraints: program.constraints,
			maxIterations: allowed,
		});
		pivotsLeft -= solution.iterations;
		// Stopped by its own cap, the solve was numerically unsound; stopped by
		// what was left of the search's budget, the search is simply over.
		if (solution.status === "iteration-limit" && allowed === perSolve) unsound++;
		// Back to dollars and the full layout: faces and cost scale; indicators
		// and duals do not.
		return {
			...solution,
			x: program.expand(solution.x),
			objectiveValue: solution.objectiveValue * program.unit,
		};
	};
	const limits = {
		maxPositions: options.maxPositions ?? securities.length,
		minLot: options.minLot ?? 0,
		maxPosition: options.maxPosition ?? Number.POSITIVE_INFINITY,
	};
	const n = securities.length;

	// NOTHING TO BUY IS NOT A SOLUTION. With no eligible securities the linear
	// programme has no variables and came back "optimal" at a cost of zero with
	// every liability unmet (surplus -amount): an absence reported as success.
	// Found 2026-09-29 porting this into saferate-markets; fixed there first.
	const firstDue = liabilities.find((liability) => liability.amount > 0);
	if (n === 0 && firstDue !== undefined) {
		return {
			kind: "uncoverable",
			date: firstDue.date,
			message: `No eligible security pays on or before ${firstDue.date}, so nothing can cover it. The universe needs a security paying by that date.`,
		};
	}

	if (liabilities.length === 0) {
		return {
			positions: [],
			cost: 0,
			surplus: [],
			relaxationCost: 0,
			marginalCostByDate: [],
			nodesExplored: 0,
			provenOptimal: true,
		};
	}

	// A finite big-M needs a finite cap. Without one from the caller, the total
	// liability over the smallest cashflow is already finite and is used.
	const totalLiability = liabilities.reduce((s, l) => s + l.amount, 0);
	if (!Number.isFinite(limits.maxPosition)) {
		limits.maxPosition = Number.POSITIVE_INFINITY;
	}

	// The pure linear dedication, which is both the lower bound and the test
	// that tells the two kinds of infeasibility apart.
	const relaxed = buildProgram({
		securities,
		liabilities,
		rate,
		limits: {
			...limits,
			maxPosition: Number.isFinite(limits.maxPosition)
				? limits.maxPosition
				: totalLiability * 1e4,
		},
		withIndicators: false,
		fixed: [],
	});
	const linear = solve(relaxed);

	if (linear.status === "iteration-limit") {
		return {
			kind: "node-limit",
			message: `The linear relaxation did not converge within ${linear.iterations} pivots, so nothing was searched. Fewer securities or fewer dates will help.`,
		};
	}

	if (linear.status !== "optimal") {
		// Name the first date nothing can reach, which is the actionable half of
		// the message: it is almost always the last one, and the fix is to add a
		// security that matures at or after it.
		let culprit = liabilities[liabilities.length - 1];
		for (let t = 0; t < liabilities.length; t++) {
			const reachable = securities.some((security) =>
				security.cashflows.slice(0, t + 1).some((cashflow) => cashflow > 0),
			);
			if (!reachable && liabilities[t].amount > 0) {
				culprit = liabilities[t];
				break;
			}
		}
		return {
			kind: "uncoverable",
			date: culprit.date,
			message: `No combination of the ${n} eligible securities covers the liability on ${culprit.date}. The universe needs a security paying on or before that date.`,
		};
	}

	const relaxationCost = linear.objectiveValue;
	const marginalCostByDate = liabilities.map((_, t) => linear.duals[t] ?? 0);
	const linearPositions = linear.x
		.slice(0, n)
		.filter((face) => face > 1e-6).length;

	// No integer structure asked for: the linear answer is the answer.
	if (limits.maxPositions >= n && limits.minLot === 0) {
		return finalise({
			securities,
			liabilities,
			faces: linear.x.slice(0, n),
			rate,
			denomination,
			minLot: limits.minLot,
			relaxationCost,
			marginalCostByDate,
			nodesExplored: 0,
			provenOptimal: true,
		});
	}

	// Branch and bound over the indicators.
	let incumbentCost = Number.POSITIVE_INFINITY;
	let incumbentFaces: number[] | null = null;
	let nodes = 0;
	let hitLimit = false;

	/** Try one fixed support, and keep it if it is feasible and an improvement. */
	const consider = (rounded: (0 | 1 | undefined)[]): void => {
		const program = buildProgram({
			securities,
			liabilities,
			rate,
			limits,
			withIndicators: true,
			fixed: rounded,
		});
		const candidate = solve(program);
		if (
			candidate.status === "optimal" &&
			candidate.objectiveValue < incumbentCost - 1e-9
		) {
			incumbentCost = candidate.objectiveValue;
			incumbentFaces = candidate.x
				.slice(0, n)
				.map((face, i) => (rounded[i] === 1 ? face : 0));
		}
	};

	/**
	 * Seed the incumbent from the relaxation before branching.
	 *
	 * Take the largest positions the linear answer wants, keep the cap's worth
	 * of them, and re-solve with the rest switched off. Relaxation-guided
	 * rounding: it is not optimal and does not need to be, because its whole job
	 * is to give the bound something to prune against. Without it the first
	 * thousand nodes cannot prune at all, since there is nothing to be worse
	 * than, and the search degenerates into enumeration — measured at 300
	 * securities and 40 dates, that is the difference between finishing and
	 * exhausting the node budget.
	 */
	const ranked = linear.x
		.slice(0, n)
		.map((face, i) => ({ face, i }))
		.sort((a, b) => b.face - a.face);
	// Several sizes, not just the cap and half of it: measured 2026-09-29 on the
	// real universe and ten $1M annual payouts, a cap of 4 found nothing in its
	// budget while a cap of 2 found a 2-position plan that a cap of 4 allows.
	// The smaller seeds are the ones that survive a tight cap.
	const cap = limits.maxPositions;
	const takes = [
		...new Set([
			cap,
			Math.ceil((cap * 3) / 4),
			Math.ceil(cap / 2),
			Math.ceil(cap / 4),
			2,
			1,
		]),
	].filter((take) => take >= 1 && take <= cap);
	for (const take of takes) {
		const seed = new Array<0 | 1 | undefined>(n).fill(0);
		for (const { face, i } of ranked.slice(0, take)) {
			if (face > 0) seed[i] = 1;
		}
		consider(seed);
	}

	const stack: (0 | 1 | undefined)[][] = [new Array(n).fill(undefined)];
	while (stack.length > 0) {
		if (nodes >= maxNodes || pivotsLeft <= 0) {
			hitLimit = true;
			break;
		}
		const fixed = stack.pop() as (0 | 1 | undefined)[];
		nodes++;

		const program = buildProgram({
			securities,
			liabilities,
			rate,
			limits,
			withIndicators: true,
			fixed,
		});
		const node = solve(program);
		if (node.status !== "optimal") continue;
		// Prune on the bound. An integer solution below its own relaxation is
		// impossible, so a node that cannot beat the incumbent cannot contain one.
		if (node.objectiveValue >= incumbentCost - 1e-6) continue;

		let branchOn = -1;
		let mostFractional = 1e-6;
		for (let i = 0; i < n; i++) {
			const value = node.x[n + i];
			const distance = Math.min(value, 1 - value);
			if (distance > mostFractional) {
				mostFractional = distance;
				branchOn = i;
			}
		}

		if (branchOn === -1) {
			// Polish before accepting. An indicator that came back at 1e-12 counts
			// as integral, and `x_i <= M_i y_i` then still permits a face of M_i
			// times 1e-12 — dust, but dust that is a *position*, so a cap of one
			// can be reported as satisfied by a portfolio holding two things.
			// Re-solving with the indicators pinned to their rounded values costs
			// one linear programme per incumbent, which is rare, and makes the
			// support exact rather than nearly exact.
			const rounded = fixed.map<0 | 1 | undefined>((pinned, i) =>
				pinned !== undefined ? pinned : node.x[n + i] > 0.5 ? 1 : 0,
			);
			consider(rounded);
			continue;
		}

		// Depth first, taking the "hold it" branch first: a feasible incumbent
		// early is what makes the bound prune anything at all.
		const zero = [...fixed];
		zero[branchOn] = 0;
		const one = [...fixed];
		one[branchOn] = 1;
		stack.push(zero);
		stack.push(one);
	}

	if (incumbentFaces === null) {
		if (hitLimit || unsound > 0) {
			return {
				kind: "node-limit",
				message: `Explored ${nodes} nodes${pivotsLeft <= 0 ? " and used the pivot budget" : ""} without finding a portfolio inside the limits. Relax maxPositions above ${limits.maxPositions}.`,
			};
		}
		return {
			kind: "position-cap",
			needed: linearPositions,
			message: `The stream is coverable but not within ${limits.maxPositions} positions. The unconstrained solution uses ${linearPositions}; try that as the cap.`,
		};
	}

	return finalise({
		securities,
		liabilities,
		faces: incumbentFaces,
		rate,
		denomination,
		minLot: limits.minLot,
		relaxationCost,
		marginalCostByDate,
		nodesExplored: nodes,
		provenOptimal: !hitLimit && unsound === 0 && pivotsLeft > 0,
	});
};

/**
 * Round to the denomination and repair the shortfall rounding creates.
 *
 * Rounding down is what keeps the answer tradeable, and it always opens a small
 * hole because a portfolio at the optimum has no slack. The hole is closed by
 * adding one denomination at a time to whichever held security covers the first
 * uncovered date most cheaply per dollar delivered — never a new security,
 * since that would break the position count the search just spent its time
 * respecting.
 *
 * The brief's alternative, modelling the denomination as a third class of
 * integer variable, buys an accuracy nobody will notice at the cost of a much
 * harder programme.
 */
const finalise = ({
	securities,
	liabilities,
	faces,
	rate,
	denomination,
	minLot,
	relaxationCost,
	marginalCostByDate,
	nodesExplored,
	provenOptimal,
}: {
	securities: TMatchingSecurity[];
	liabilities: TLiability[];
	faces: number[];
	rate: number;
	denomination: number;
	minLot: number;
	relaxationCost: number;
	marginalCostByDate: number[];
	nodesExplored: number;
	provenOptimal: boolean;
}): TMatchingResult => {
	// Rounding down is what keeps the answer tradeable, and on its own it can
	// undo the minimum lot the search just spent its time enforcing: a position
	// the optimiser set at 99,500 against a lot size of 100,000 rounds to
	// 99,000 and is no longer tradeable for the opposite reason. Anything the
	// optimiser wanted to hold is rounded UP to the first admissible multiple
	// instead. Anything it wanted at zero stays at zero.
	const lotFloor =
		denomination > 0 && minLot > 0
			? Math.ceil(minLot / denomination) * denomination
			: minLot;
	const rounded =
		denomination > 0
			? faces.map((face) => {
					if (face <= 0) return 0;
					const down = Math.floor(face / denomination) * denomination;
					return down < lotFloor ? lotFloor : down;
				})
			: [...faces];

	if (denomination > 0) {
		const held = rounded
			.map((face, i) => ({ face, i }))
			.filter((entry) => entry.face > 0)
			.map((entry) => entry.i);

		for (let guard = 0; guard < 10_000; guard++) {
			const path = surplusPath({
				securities,
				faces: rounded,
				liabilities,
				rate,
			});
			const short = path.findIndex((value) => value < -1e-6);
			if (short === -1) break;

			// Cheapest way to deliver a dollar on or before the uncovered date.
			let best = -1;
			let bestCost = Number.POSITIVE_INFINITY;
			for (const i of held) {
				let delivered = 0;
				for (let t = 0; t <= short; t++) {
					delivered = delivered * (1 + rate) + (securities[i].cashflows[t] ?? 0);
				}
				if (delivered <= 0) continue;
				const cost = securities[i].askPrice / delivered;
				if (cost < bestCost) {
					bestCost = cost;
					best = i;
				}
			}
			if (best === -1) break;
			rounded[best] += denomination;
		}
	}

	// A face below a thousandth of a dollar is arithmetic residue, not a
	// holding. Reporting it would overstate the position count, which is the one
	// number the integer programme exists to control.
	const positions = securities
		.map((security, i) => ({
			cusip: security.cusip,
			faceValue: rounded[i],
			cost: (rounded[i] * security.askPrice) / 100,
		}))
		.filter((position) => position.faceValue > 1e-3);

	return {
		positions,
		cost: positions.reduce((sum, position) => sum + position.cost, 0),
		surplus: surplusPath({ securities, faces: rounded, liabilities, rate }),
		relaxationCost,
		marginalCostByDate,
		nodesExplored,
		provenOptimal,
	};
};

/** Narrowing helper, since the solver returns a union. */
export const isMatchingFailure = (
	result: TMatchingResult | TMatchingFailure,
): result is TMatchingFailure => "kind" in result;
