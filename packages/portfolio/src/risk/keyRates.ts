// PORTED VERBATIM from saferate-treasury at 191d25a (2026-09-29): KEY_RATES and
// keyRateBumpWeight from securityAnalytics.ts, TPortfolioHolding from
// portfolioAnalytics.ts. Change them there first, then here.

/** The twelve key rate tenors, in years: the stored analytics' krd_03m..krd_30y. */
export const KEY_RATES: readonly number[] = [
	0.25, 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 25, 30,
];

/** Triangular key rate bump: 1 at its tenor, falling linearly to its neighbours. */
export const keyRateBumpWeight = (
	time: number,
	index: number,
	keyRates: readonly number[],
): number => {
	const centre = keyRates[index];
	const previous = index > 0 ? keyRates[index - 1] : null;
	const next = index < keyRates.length - 1 ? keyRates[index + 1] : null;

	if (time === centre) return 1;

	if (time < centre) {
		// Flat below the first key rate rather than falling to zero, or the
		// shortest cashflows would be unhedged by any key rate.
		if (previous === null) return 1;
		if (time <= previous) return 0;
		return (time - previous) / (centre - previous);
	}

	if (next === null) return 1;
	if (time >= next) return 0;
	return (next - time) / (next - centre);
};

export type TPortfolioHolding = {
	cusip: string;
	/** Face amount held, in dollars of par. Negative for a short. */
	faceValue: number;
	/** Dirty price per 100 of face. */
	dirtyPrice: number;
	macaulayDuration: number;
	modifiedDuration: number;
	convexity: number;
	/** Money value of a basis point, per 100 of face. */
	dv01: number;
	/** One per key rate, in the order of KEY_RATES. */
	keyRateDurations: number[];
	payments: number[];
	paymentsExps: number[];
};
