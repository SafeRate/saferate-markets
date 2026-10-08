/**
 * The bill curve: Nelson-Siegel on bills alone, bond-equivalent basis. PORTED
 * from saferate-treasury (moneyMarketCurve.ts moneyMarketRate and
 * moneyMarketDiscountFactor, curveFitting.ts nelsonSiegelBasis) at 1814d64.
 * The parameters are the ones stored on every money_market_curves row
 * (beta_0..2 in percent, lambda in years), so a rate here is exactly the
 * published fit. Change them there first, then here. tests/billCurve.test.ts
 * holds this to the stored tenor rates.
 *
 * Built on it: the implied forward rate for a future bill, and what rolling
 * bills earns over a horizon. A forward is the rate the curve already prices
 * for that future period, so rolling at the forwards and holding one bill to
 * the same date come out equal by construction; the useful number is the
 * forward itself, the rate a roll has to beat.
 */

export type TBillCurveParams = {
	beta0: number;
	beta1: number;
	beta2: number;
	lambda: number;
};

const slopeLoading = (x: number) =>
	x < 1e-6 ? 1 - x / 2 + (x * x) / 6 : -Math.expm1(-x) / x;

/** Fitted bond-equivalent rate at a maturity in years, PERCENT. */
export const billRate = (p: TBillCurveParams, years: number) => {
	if (!(years > 0))
		throw new Error(`Bill maturity must be positive, got ${years}`);
	const x = years / p.lambda;
	const slope = slopeLoading(x);
	return p.beta0 + p.beta1 * slope + p.beta2 * (slope - Math.exp(-x));
};

/** Discount factor at a maturity: bond-equivalent, compounded semiannually. */
export const billDiscountFactor = (p: TBillCurveParams, years: number) =>
	(1 + billRate(p, years) / 100 / 2) ** (-2 * years);

/** Growth of $1 over `years` at a bond-equivalent rate in percent. */
export const growthAt = (ratePercent: number, years: number) =>
	(1 + ratePercent / 100 / 2) ** (2 * years);

/** The bond-equivalent rate, percent, that grows $1 into `growth` over `years`. */
export const rateFor = (growth: number, years: number) =>
	(growth ** (1 / (2 * years)) - 1) * 2 * 100;

/** The forward rate the curve prices for a bill from `start` to `end`, percent. */
export const forwardBillRate = (
	p: TBillCurveParams,
	start: number,
	end: number,
) => {
	if (!(end > start) || start < 0)
		throw new Error(`Forward period must run forwards, got ${start} to ${end}`);
	const growth =
		(start === 0 ? 1 : billDiscountFactor(p, start)) / billDiscountFactor(p, end);
	return rateFor(growth, end - start);
};

/**
 * Rolling a bill of `termYears` until `horizonYears`: the rate each roll is
 * priced at today (the first is today's rate, the rest are forwards), and what
 * the roll earns if each future rate is the forward plus `shiftBp`.
 */
export const rollAtForwards = ({
	curve,
	termYears,
	horizonYears,
	shiftBp = 0,
}: {
	curve: TBillCurveParams;
	termYears: number;
	horizonYears: number;
	shiftBp?: number;
}) => {
	const rolls = Math.round(horizonYears / termYears);
	const steps = Array.from({ length: rolls }, (_, i) => {
		const start = i * termYears;
		const forward = forwardBillRate(curve, start, start + termYears);
		return {
			startYears: start,
			pricedRate: forward,
			assumedRate: i === 0 ? forward : forward + shiftBp / 100,
		};
	});
	const growth = steps.reduce(
		(g, s) => g * growthAt(s.assumedRate, termYears),
		1,
	);
	return { steps, growth, ratePercent: rateFor(growth, horizonYears) };
};

/**
 * The single rate the rolls after the first must average for the roll to
 * match holding one bill to the horizon: the breakeven reinvestment rate.
 */
export const breakevenReinvestmentRate = ({
	curve,
	termYears,
	horizonYears,
}: {
	curve: TBillCurveParams;
	termYears: number;
	horizonYears: number;
}) => {
	const hold = 1 / billDiscountFactor(curve, horizonYears);
	const first = growthAt(forwardBillRate(curve, 0, termYears), termYears);
	return rateFor(hold / first, horizonYears - termYears);
};
