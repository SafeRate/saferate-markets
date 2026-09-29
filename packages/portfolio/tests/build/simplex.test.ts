import { describe, expect, test } from "bun:test";
import {
	solveLinearProgram,
	type TLinearProgram,
} from "../../src/build/simplex";

describe("solveLinearProgram", () => {
	test("solves a problem with a known answer by hand", () => {
		// maximise 3x + 5y, written as a minimisation of its negation, subject to
		// x <= 4, 2y <= 12, 3x + 2y <= 18. The textbook Wyndor problem; the
		// optimum is (2, 6) worth 36.
		const solution = solveLinearProgram({
			objective: [-3, -5],
			constraints: [
				{ coefficients: [1, 0], relation: "<=", bound: 4 },
				{ coefficients: [0, 2], relation: "<=", bound: 12 },
				{ coefficients: [3, 2], relation: "<=", bound: 18 },
			],
		});
		expect(solution.status).toBe("optimal");
		expect(solution.x[0]).toBeCloseTo(2, 9);
		expect(solution.x[1]).toBeCloseTo(6, 9);
		expect(solution.objectiveValue).toBeCloseTo(-36, 9);
	});

	test("handles equalities and greater-thans, which need phase one", () => {
		// minimise x + y subject to x + y >= 10 and x - y = 2. The answer is
		// forced: (6, 4), worth 10.
		const solution = solveLinearProgram({
			objective: [1, 1],
			constraints: [
				{ coefficients: [1, 1], relation: ">=", bound: 10 },
				{ coefficients: [1, -1], relation: "=", bound: 2 },
			],
		});
		expect(solution.status).toBe("optimal");
		expect(solution.x[0]).toBeCloseTo(6, 9);
		expect(solution.x[1]).toBeCloseTo(4, 9);
		expect(solution.objectiveValue).toBeCloseTo(10, 9);
	});

	test("normalises a negative bound rather than mis-signing its slack", () => {
		// -x - y <= -10 is x + y >= 10. Written the awkward way on purpose,
		// because the row has to be reflected before its slack is chosen and
		// getting that wrong produces a feasible-looking wrong answer.
		const solution = solveLinearProgram({
			objective: [1, 1],
			constraints: [
				{ coefficients: [-1, -1], relation: "<=", bound: -10 },
				{ coefficients: [1, 0], relation: "<=", bound: 7 },
			],
		});
		expect(solution.status).toBe("optimal");
		expect(solution.x[0] + solution.x[1]).toBeCloseTo(10, 9);
		expect(solution.objectiveValue).toBeCloseTo(10, 9);
	});

	test("reports infeasibility rather than returning a wrong answer", () => {
		const solution = solveLinearProgram({
			objective: [1, 1],
			constraints: [
				{ coefficients: [1, 1], relation: "<=", bound: 2 },
				{ coefficients: [1, 1], relation: ">=", bound: 8 },
			],
		});
		expect(solution.status).toBe("infeasible");
	});

	test("reports unboundedness", () => {
		// minimise -x with nothing holding x down.
		const solution = solveLinearProgram({
			objective: [-1],
			constraints: [{ coefficients: [1], relation: ">=", bound: 1 }],
		});
		expect(solution.status).toBe("unbounded");
	});

	test("survives Beale's cycling example", () => {
		// The standard counterexample: under Dantzig's rule alone this cycles
		// through six bases for ever. Terminating at all is the assertion, and
		// the known optimum is -0.05 at the origin of the last three variables.
		const solution = solveLinearProgram({
			objective: [-0.75, 150, -0.02, 6],
			constraints: [
				{
					coefficients: [0.25, -60, -0.04, 9],
					relation: "<=",
					bound: 0,
				},
				{ coefficients: [0.5, -90, -0.02, 3], relation: "<=", bound: 0 },
				{ coefficients: [0, 0, 1, 0], relation: "<=", bound: 1 },
			],
		});
		expect(solution.status).toBe("optimal");
		expect(solution.objectiveValue).toBeCloseTo(-0.05, 9);
	});

	test("survives a deliberately degenerate problem", () => {
		// Many constraints binding at exactly zero, which is the shape the cash
		// matching problem produces by accident on every date the optimal
		// portfolio runs its surplus down to nothing.
		const size = 12;
		const constraints: TLinearProgram["constraints"] = [];
		for (let i = 0; i < size; i++) {
			constraints.push({
				coefficients: Array.from({ length: size }, (_, j) =>
					j === i ? 1 : j === (i + 1) % size ? -1 : 0,
				),
				relation: "<=",
				bound: 0,
			});
		}
		constraints.push({
			coefficients: Array.from({ length: size }, () => 1),
			relation: ">=",
			bound: 5,
		});
		const solution = solveLinearProgram({
			objective: Array.from({ length: size }, (_, j) => 1 + j / 100),
			constraints,
		});
		expect(solution.status).toBe("optimal");
		// The cycle of differences forces every variable equal, so each is 5/12.
		for (const value of solution.x) expect(value).toBeCloseTo(5 / size, 7);
	});

	test("duals price the binding constraints and ignore the slack ones", () => {
		// minimise 2x + 3y subject to x + y >= 10 and x <= 4. Both bind: x goes
		// to its cap because it is cheaper, y takes the rest. Relaxing the
		// demand by one unit costs another unit of y, so its dual is 3.
		const solution = solveLinearProgram({
			objective: [2, 3],
			constraints: [
				{ coefficients: [1, 1], relation: ">=", bound: 10 },
				{ coefficients: [1, 0], relation: "<=", bound: 4 },
				{ coefficients: [0, 1], relation: "<=", bound: 100 },
			],
		});
		expect(solution.status).toBe("optimal");
		expect(solution.x[0]).toBeCloseTo(4, 9);
		expect(solution.x[1]).toBeCloseTo(6, 9);
		expect(solution.duals[0]).toBeCloseTo(3, 7);
		// Raising the cap on the cheap variable saves the difference in cost.
		expect(solution.duals[1]).toBeCloseTo(-1, 7);
		// The third constraint is slack, so it is worth nothing.
		expect(solution.duals[2]).toBeCloseTo(0, 9);
	});

	test("the duals satisfy strong duality", () => {
		// b'y must equal c'x at the optimum. This is the check that would catch a
		// sign convention error the individual values above might survive.
		const program: TLinearProgram = {
			objective: [4, 1, 7],
			constraints: [
				{ coefficients: [1, 1, 1], relation: ">=", bound: 6 },
				{ coefficients: [2, 0, 1], relation: ">=", bound: 4 },
				{ coefficients: [1, 3, 0], relation: "<=", bound: 12 },
			],
		};
		const solution = solveLinearProgram(program);
		expect(solution.status).toBe("optimal");
		const dualObjective = program.constraints.reduce(
			(sum, constraint, i) => sum + constraint.bound * solution.duals[i],
			0,
		);
		expect(dualObjective).toBeCloseTo(solution.objectiveValue, 6);
	});

	test("a dual is the derivative of the objective, checked by perturbation", () => {
		// The interpretation, verified rather than asserted: nudge a bound and
		// the objective should move by the dual times the nudge. This is what
		// makes the number worth reporting to a user.
		const build = (bound: number): TLinearProgram => ({
			objective: [2, 3, 5],
			constraints: [
				{ coefficients: [1, 1, 0], relation: ">=", bound },
				{ coefficients: [0, 1, 1], relation: ">=", bound: 8 },
				{ coefficients: [1, 0, 1], relation: "<=", bound: 9 },
			],
		});
		const base = solveLinearProgram(build(10));
		const nudged = solveLinearProgram(build(10.001));
		expect(base.status).toBe("optimal");
		expect(nudged.objectiveValue - base.objectiveValue).toBeCloseTo(
			base.duals[0] * 0.001,
			7,
		);
	});

	test("a redundant equality does not read as infeasible", () => {
		// The same row twice. Phase one ends with an artificial basic at zero,
		// and treating that as infeasibility is the classic bug.
		const solution = solveLinearProgram({
			objective: [1, 1],
			constraints: [
				{ coefficients: [1, 1], relation: "=", bound: 5 },
				{ coefficients: [2, 2], relation: "=", bound: 10 },
			],
		});
		expect(solution.status).toBe("optimal");
		expect(solution.x[0] + solution.x[1]).toBeCloseTo(5, 9);
	});

	test("solves a problem with no variables and one with no constraints", () => {
		expect(solveLinearProgram({ objective: [], constraints: [] }).status).toBe(
			"optimal",
		);
		const free = solveLinearProgram({ objective: [1, 2], constraints: [] });
		expect(free.status).toBe("optimal");
		expect(free.objectiveValue).toBeCloseTo(0, 12);
	});

	test("pads short coefficient rows rather than reading undefined", () => {
		const solution = solveLinearProgram({
			objective: [1, 1, 1],
			constraints: [{ coefficients: [1], relation: ">=", bound: 3 }],
		});
		expect(solution.status).toBe("optimal");
		expect(solution.x[0]).toBeCloseTo(3, 9);
		expect(solution.objectiveValue).toBeCloseTo(3, 9);
	});

	test("agrees with a brute force vertex enumeration on random problems", () => {
		// An independent implementation, which is the check this repository rates
		// highest. Two variables and a handful of `<=` rows, so every vertex is
		// the intersection of a pair of constraints and can be listed.
		let seed = 20260907;
		const random = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let trial = 0; trial < 40; trial++) {
			const rowCount = 3 + Math.floor(random() * 3);
			const constraints: TLinearProgram["constraints"] = [];
			for (let i = 0; i < rowCount; i++) {
				constraints.push({
					coefficients: [random() * 4 - 0.5, random() * 4 - 0.5],
					relation: "<=",
					bound: 1 + random() * 20,
				});
			}
			// Bound the box so nothing is unbounded.
			constraints.push({ coefficients: [1, 0], relation: "<=", bound: 25 });
			constraints.push({ coefficients: [0, 1], relation: "<=", bound: 25 });
			const objective = [random() * 2 - 1, random() * 2 - 1];
			const solution = solveLinearProgram({ objective, constraints });
			expect(solution.status).toBe("optimal");

			const all = [
				...constraints,
				{ coefficients: [1, 0], relation: ">=" as const, bound: 0 },
				{ coefficients: [0, 1], relation: ">=" as const, bound: 0 },
			];
			let best = Number.POSITIVE_INFINITY;
			for (let a = 0; a < all.length; a++) {
				for (let b = a + 1; b < all.length; b++) {
					const [a1, a2] = all[a].coefficients;
					const [b1, b2] = all[b].coefficients;
					const determinant = a1 * b2 - a2 * b1;
					if (Math.abs(determinant) < 1e-9) continue;
					const x = (all[a].bound * b2 - all[b].bound * a2) / determinant;
					const y = (a1 * all[b].bound - b1 * all[a].bound) / determinant;
					if (x < -1e-7 || y < -1e-7) continue;
					const feasible = constraints.every(
						(c) => c.coefficients[0] * x + c.coefficients[1] * y <= c.bound + 1e-7,
					);
					if (!feasible) continue;
					best = Math.min(best, objective[0] * x + objective[1] * y);
				}
			}
			expect(solution.objectiveValue).toBeCloseTo(best, 6);
		}
	});
});
