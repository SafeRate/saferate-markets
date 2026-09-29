/**
 * The Nelson-Siegel-Svensson zero curve, PORTED from saferate-treasury
 * (zeroCurve.ts zeroRate/discountFactor, nssYieldCurve.ts nssBasis,
 * curveFitting.ts slopeLoading, at e2e7c7e). Parameters are the ones stored on
 * every zero curve row (theta_0..3, lambda_1..2), so a curve here is exactly the
 * published fit. tests/attribution.test.ts holds it to published zero rates.
 */

export type TCurveParams = {
	theta0: number;
	theta1: number;
	theta2: number;
	theta3: number;
	lambda1: number;
	lambda2: number;
};

const slopeLoading = (x: number) =>
	x < 1e-6 ? 1 - x / 2 + (x * x) / 6 : -Math.expm1(-x) / x;

const nssBasis = (
	time: number,
	lambda1: number,
	lambda2: number,
): [number, number, number, number] => {
	const scaled1 = time / lambda1;
	const scaled2 = time / lambda2;
	const slope1 = slopeLoading(scaled1);
	const slope2 = slopeLoading(scaled2);
	return [1, slope1, slope1 - Math.exp(-scaled1), slope2 - Math.exp(-scaled2)];
};

/** Continuously compounded zero rate at a maturity in years, PERCENT. */
export const zeroRate = (p: TCurveParams, time: number) => {
	const [b0, b1, b2, b3] = nssBasis(time, p.lambda1, p.lambda2);
	return (p.theta0 * b0 + p.theta1 * b1 + p.theta2 * b2 + p.theta3 * b3) * 100;
};

export const discountFactor = (p: TCurveParams, time: number) =>
	Math.exp((-zeroRate(p, time) / 100) * time);
