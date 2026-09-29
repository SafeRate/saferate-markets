/**
 * PORTED VERBATIM from saferate-treasury packages/utils/src/functions/curveFitting.ts
 * (nelderMead only) at 191d25a, 2026-09-29, for the GARCH fit in volatilityModels.ts.
 */

export type TSimplexResult = {
	x: number[];
	fx: number;
	iterations: number;
	converged: boolean;
};

/**
 * Downhill simplex.
 *
 * Replaces `optimizers/nelderMead.js`, which was untyped, logged every
 * iteration to the console, and stashed function values as ad-hoc properties on
 * the point arrays. Here it only ever runs in one or two dimensions.
 */
export const nelderMead = (
	objective: (x: number[]) => number,
	start: number[],
	maxIterations: number,
): TSimplexResult => {
	const size = start.length;
	const nonZeroDelta = 1.05;
	const zeroDelta = 0.00025;
	const minErrorDelta = 1e-10;
	const minTolerance = 1e-8;
	const [rho, chi, psi, sigma] = [1, 2, -0.5, 0.5];

	let points: number[][] = [start.slice()];
	let values: number[] = [objective(start)];

	for (let i = 0; i < size; i++) {
		const point = start.slice();
		point[i] = point[i] ? point[i] * nonZeroDelta : zeroDelta;
		points.push(point);
		values.push(objective(point));
	}

	const sortSimplex = () => {
		const order = points
			.map((_, index) => index)
			.sort((a, b) => values[a] - values[b]);
		points = order.map((index) => points[index]);
		values = order.map((index) => values[index]);
	};

	const weightedSum = (
		weightA: number,
		a: number[],
		weightB: number,
		b: number[],
	): number[] => a.map((value, index) => weightA * value + weightB * b[index]);

	let iteration = 0;
	let converged = false;

	for (iteration = 0; iteration < maxIterations; iteration++) {
		sortSimplex();

		let maxDiff = 0;
		for (let i = 0; i < size; i++) {
			maxDiff = Math.max(maxDiff, Math.abs(points[0][i] - points[1][i]));
		}
		if (
			Math.abs(values[0] - values[size]) < minErrorDelta &&
			maxDiff < minTolerance
		) {
			converged = true;
			break;
		}

		const centroid = new Array<number>(size).fill(0);
		for (let i = 0; i < size; i++) {
			for (let j = 0; j < size; j++) {
				centroid[i] += points[j][i];
			}
			centroid[i] /= size;
		}

		const worst = points[size];
		const reflected = weightedSum(1 + rho, centroid, -rho, worst);
		const reflectedValue = objective(reflected);

		if (reflectedValue < values[0]) {
			const expanded = weightedSum(1 + chi, centroid, -chi, worst);
			const expandedValue = objective(expanded);
			if (expandedValue < reflectedValue) {
				points[size] = expanded;
				values[size] = expandedValue;
			} else {
				points[size] = reflected;
				values[size] = reflectedValue;
			}
		} else if (reflectedValue >= values[size - 1]) {
			let shouldReduce = false;

			if (reflectedValue > values[size]) {
				const contracted = weightedSum(1 + psi, centroid, -psi, worst);
				const contractedValue = objective(contracted);
				if (contractedValue < values[size]) {
					points[size] = contracted;
					values[size] = contractedValue;
				} else {
					shouldReduce = true;
				}
			} else {
				const contracted = weightedSum(1 - psi * rho, centroid, psi * rho, worst);
				const contractedValue = objective(contracted);
				if (contractedValue < reflectedValue) {
					points[size] = contracted;
					values[size] = contractedValue;
				} else {
					shouldReduce = true;
				}
			}

			if (shouldReduce) {
				for (let i = 1; i <= size; i++) {
					points[i] = weightedSum(1 - sigma, points[0], sigma, points[i]);
					values[i] = objective(points[i]);
				}
			}
		} else {
			points[size] = reflected;
			values[size] = reflectedValue;
		}
	}

	sortSimplex();

	return { x: points[0], fx: values[0], iterations: iteration, converged };
};
