import { describe, expect, test } from "bun:test";
import type { TPortfolioHolding } from "../../src/risk/keyRates";
import {
	repriceHoldings,
	scenarioFromCurves,
	shockedZeroRate,
	standardScenarios,
	stressPortfolio,
} from "../../src/risk/portfolioStress";
import { KEY_RATES } from "../../src/risk/keyRates";
import { zeroRate } from "../../src/curve";

const CURVE = {
	theta0: 0.046,
	theta1: -0.021,
	theta2: 0.014,
	theta3: -0.008,
	lambda1: 1.2,
	lambda2: 7,
};

/**
 * A holding carrying only what this module reads.
 *
 * `paymentsExps` is the field repricing discounts on, so it is the one that has
 * to be right; the risk measures are unused here and set to zero rather than to
 * plausible-looking numbers that no assertion would catch being wrong.
 */
const bond = ({
	couponRate,
	years,
	faceValue = 1_000_000,
}: {
	couponRate: number;
	years: number;
	faceValue?: number;
}): TPortfolioHolding => {
	const payments: number[] = [];
	const paymentsExps: number[] = [];
	const count = Math.round(years * 2);
	for (let i = 1; i <= count; i++) {
		paymentsExps.push(i / 2);
		payments.push((couponRate * 100) / 2 + (i === count ? 100 : 0));
	}
	return {
		cusip: `${couponRate}-${years}`,
		faceValue,
		dirtyPrice: 100,
		macaulayDuration: 0,
		modifiedDuration: 0,
		convexity: 0,
		dv01: 0,
		keyRateDurations: [],
		payments,
		paymentsExps,
	};
};

const strip = (years: number, faceValue = 1_000_000): TPortfolioHolding => ({
	...bond({ couponRate: 0, years, faceValue }),
	payments: [100],
	paymentsExps: [years],
});

describe("shockedZeroRate", () => {
	test("at a key rate the shift is exactly that key rate's shift", () => {
		// The triangles are one at their own centre and zero at their
		// neighbours', so nothing bleeds in from the next key rate along.
		const shifts = KEY_RATES.map((_, k) => (k + 1) * 7);
		for (const [k, time] of KEY_RATES.entries()) {
			expect(
				shockedZeroRate({ curve: CURVE, time, shiftBasisPoints: shifts }),
			).toBeCloseTo(zeroRate(CURVE, time) + shifts[k] / 100, 12);
		}
	});

	test("shifting every key rate equally is a parallel shift everywhere", () => {
		// The identity that proves the interpolation is intact: the triangles sum
		// to one at every maturity, including between key rates and beyond both
		// ends, so this must hold at maturities no key rate sits on.
		const shifts = KEY_RATES.map(() => 25);
		for (const time of [0.1, 0.4, 1.7, 4.2, 8.9, 12.5, 23, 30, 40]) {
			expect(
				shockedZeroRate({ curve: CURVE, time, shiftBasisPoints: shifts }),
			).toBeCloseTo(zeroRate(CURVE, time) + 0.25, 12);
		}
	});

	test("an absent or short shift vector is no shift", () => {
		for (const time of [0.5, 5, 30]) {
			expect(
				shockedZeroRate({ curve: CURVE, time, shiftBasisPoints: [] }),
			).toBeCloseTo(zeroRate(CURVE, time), 12);
		}
		// A short array touches only the tenors it names.
		const front = shockedZeroRate({
			curve: CURVE,
			time: 30,
			shiftBasisPoints: [100, 100],
		});
		expect(front).toBeCloseTo(zeroRate(CURVE, 30), 12);
	});
});

describe("repriceHoldings", () => {
	test("a strip prices to its own discount factor, exactly", () => {
		// The one case with an elementary closed form, so it checks the
		// discounting convention rather than the code's agreement with itself.
		const value = repriceHoldings({ holdings: [strip(7)], curve: CURVE });
		const rate = zeroRate(CURVE, 7) / 100;
		expect(value).toBeCloseTo(1_000_000 * Math.exp(-rate * 7), 6);
	});

	test("a shocked strip moves by exactly e to the minus shift times time", () => {
		const shift = 100;
		const base = repriceHoldings({ holdings: [strip(10)], curve: CURVE });
		const shocked = repriceHoldings({
			holdings: [strip(10)],
			curve: CURVE,
			shiftBasisPoints: KEY_RATES.map(() => shift),
		});
		expect(shocked / base).toBeCloseTo(Math.exp((-shift / 10000) * 10), 12);
	});

	test("value is additive across holdings and linear in face", () => {
		const a = bond({ couponRate: 0.04, years: 10 });
		const b = bond({ couponRate: 0.02, years: 3, faceValue: 500_000 });
		const together = repriceHoldings({ holdings: [a, b], curve: CURVE });
		expect(together).toBeCloseTo(
			repriceHoldings({ holdings: [a], curve: CURVE }) +
				repriceHoldings({ holdings: [b], curve: CURVE }),
			6,
		);
		const doubled = repriceHoldings({
			holdings: [{ ...a, faceValue: a.faceValue * 2 }],
			curve: CURVE,
		});
		expect(doubled).toBeCloseTo(
			2 * repriceHoldings({ holdings: [a], curve: CURVE }),
			6,
		);
	});

	test("ageing drops cashflows that have already fallen due", () => {
		const holding = bond({ couponRate: 0.05, years: 2 });
		// Aged past the first two coupons, two of the four payments remain.
		const aged = repriceHoldings({
			holdings: [holding],
			curve: CURVE,
			ageBy: 1.2,
		});
		const manual =
			10_000 *
			holding.payments
				.map((payment, i) => ({
					payment,
					time: holding.paymentsExps[i] - 1.2,
				}))
				.filter((c) => c.time > 0)
				.reduce(
					(sum, c) =>
						sum + c.payment * Math.exp((-zeroRate(CURVE, c.time) / 100) * c.time),
					0,
				);
		expect(aged).toBeCloseTo(manual, 6);
	});

	test("an empty book is worth nothing rather than throwing", () => {
		expect(repriceHoldings({ holdings: [], curve: CURVE })).toBe(0);
	});
});

describe("stressPortfolio", () => {
	const book = [
		bond({ couponRate: 0.04, years: 10 }),
		bond({ couponRate: 0.0625, years: 30, faceValue: 400_000 }),
		bond({ couponRate: 0.02, years: 2, faceValue: 2_000_000 }),
	];

	test("a zero scenario moves nothing at all", () => {
		const { results } = stressPortfolio({
			holdings: book,
			curve: CURVE,
			scenarios: [{ name: "flat", shiftBasisPoints: KEY_RATES.map(() => 0) }],
		});
		expect(results[0].profitAndLoss).toBe(0);
		expect(results[0].firstOrder).toBe(0);
		expect(results[0].secondOrder).toBe(0);
		// Positive zero, not negative: a stress report that prints "-0.00" for an
		// unchanged curve invites the reader to look for a loss that is not there.
		expect(Object.is(results[0].firstOrder, -0)).toBe(false);
	});

	test("rates up is a loss and rates down is a gain, for a long book", () => {
		const { results } = stressPortfolio({
			holdings: book,
			curve: CURVE,
			scenarios: standardScenarios(),
		});
		const by = (name: string) =>
			results.find((r) => r.name === name) as (typeof results)[number];
		expect(by("parallel +100").profitAndLoss).toBeLessThan(0);
		expect(by("parallel -100").profitAndLoss).toBeGreaterThan(0);
		// And bigger moves move more, in both directions.
		expect(by("parallel +300").profitAndLoss).toBeLessThan(
			by("parallel +100").profitAndLoss,
		);
		expect(by("parallel -300").profitAndLoss).toBeGreaterThan(
			by("parallel -100").profitAndLoss,
		);
	});

	test("convexity is a gain for a long book whichever way rates move", () => {
		// The property that justifies reporting the second order term at all, and
		// the one a sign error breaks in exactly one direction.
		const { results } = stressPortfolio({
			holdings: book,
			curve: CURVE,
			scenarios: standardScenarios(),
		});
		for (const name of [
			"parallel +300",
			"parallel +100",
			"parallel -100",
			"parallel -300",
		]) {
			const result = results.find((r) => r.name === name);
			expect(result?.secondOrder).toBeGreaterThan(0);
		}
	});

	test("the gain from a rally exceeds the loss from an equal selloff", () => {
		// Convexity again, stated the way a portfolio manager would: the book is
		// asymmetric, and by an amount that grows with the size of the move.
		const { results } = stressPortfolio({
			holdings: book,
			curve: CURVE,
			scenarios: standardScenarios(),
		});
		const by = (name: string) =>
			(results.find((r) => r.name === name) as (typeof results)[number])
				.profitAndLoss;
		const smallGap = by("parallel -100") + by("parallel +100");
		const largeGap = by("parallel -300") + by("parallel +300");
		expect(smallGap).toBeGreaterThan(0);
		expect(largeGap).toBeGreaterThan(smallGap);
	});

	test("the second order term vanishes as the move does", () => {
		// Which is what makes it convexity rather than an interpolation artefact:
		// shrink the shock by ten and the remainder should fall by about a
		// hundred, since it is quadratic.
		const shock = (basisPoints: number) =>
			stressPortfolio({
				holdings: book,
				curve: CURVE,
				scenarios: [
					{
						name: "p",
						shiftBasisPoints: KEY_RATES.map(() => basisPoints),
					},
				],
			}).results[0];
		const ratio = shock(100).secondOrder / shock(10).secondOrder;
		expect(ratio).toBeGreaterThan(90);
		expect(ratio).toBeLessThan(110);
	});

	test("a short book has the opposite sign everywhere, convexity included", () => {
		const shorted = book.map((h) => ({ ...h, faceValue: -h.faceValue }));
		const long = stressPortfolio({
			holdings: book,
			curve: CURVE,
			scenarios: [{ name: "up", shiftBasisPoints: KEY_RATES.map(() => 100) }],
		});
		const short = stressPortfolio({
			holdings: shorted,
			curve: CURVE,
			scenarios: [{ name: "up", shiftBasisPoints: KEY_RATES.map(() => 100) }],
		});
		expect(short.baseValue).toBeCloseTo(-long.baseValue, 6);
		expect(short.results[0].profitAndLoss).toBeCloseTo(
			-long.results[0].profitAndLoss,
			6,
		);
		// Short convexity: the second order term is a cost for the short.
		expect(short.results[0].secondOrder).toBeLessThan(0);
	});

	test("derived key rate durations reproduce supplied ones", () => {
		// The fallback path bumps each key rate by a basis point and repricess,
		// so it should agree with durations computed any other way. Checked
		// against itself the long way round rather than assumed.
		const derived = stressPortfolio({
			holdings: [strip(10)],
			curve: CURVE,
			scenarios: [{ name: "up", shiftBasisPoints: KEY_RATES.map(() => 100) }],
		});
		// A ten year strip has a continuous duration of exactly ten, all of it at
		// the ten year key rate.
		const supplied = stressPortfolio({
			holdings: [strip(10)],
			curve: CURVE,
			scenarios: [{ name: "up", shiftBasisPoints: KEY_RATES.map(() => 100) }],
			keyRateDurations: KEY_RATES.map((t) => (t === 10 ? 10 : 0)),
		});
		// Close but deliberately not equal. The derived duration comes from an
		// actual one basis point reprice, so it already carries half a basis
		// point of the strip's own convexity and lands at 9.9995 rather than 10.
		// That is the bump estimator being honest, not an error, and asserting
		// equality here would be asserting that it is not.
		const relative =
			derived.results[0].firstOrder / supplied.results[0].firstOrder - 1;
		expect(Math.abs(relative)).toBeLessThan(1e-3);
		expect(Math.abs(relative)).toBeGreaterThan(1e-5);
	});

	test("a curve reshape is not the same as a parallel move of its average", () => {
		// The reason curve scenarios exist. A steepener with zero average shift
		// still moves a book that is not evenly spread across the curve.
		const { results } = stressPortfolio({
			holdings: book,
			curve: CURVE,
			scenarios: [
				{
					name: "steepener",
					shiftBasisPoints: KEY_RATES.map((t) => (t >= 10 ? 50 : -50)),
				},
			],
		});
		expect(Math.abs(results[0].profitAndLoss)).toBeGreaterThan(0);
	});

	test("an empty book reports no return fraction rather than dividing by zero", () => {
		const { baseValue, results } = stressPortfolio({
			holdings: [],
			curve: CURVE,
			scenarios: standardScenarios(),
		});
		expect(baseValue).toBe(0);
		expect(results[0].returnFraction).toBeNull();
	});
});

describe("scenarioFromCurves", () => {
	test("reads the shift straight off the two curves", () => {
		const rallied = { ...CURVE, theta0: 0.036 };
		const scenario = scenarioFromCurves({
			name: "rally",
			startCurve: CURVE,
			endCurve: rallied,
		});
		expect(scenario.name).toBe("rally");
		for (const shift of scenario.shiftBasisPoints) {
			expect(shift).toBeCloseTo(-100, 8);
		}
	});

	test("round trips through repricing to the end curve's own valuation", () => {
		// The check that makes historical replay trustworthy: repricing under the
		// scenario must give the same answer as pricing on the end curve
		// directly, or the scenario is not the move it claims to be.
		const end = { ...CURVE, theta0: 0.051, theta1: -0.017 };
		const holdings = [bond({ couponRate: 0.04, years: 10 })];
		const scenario = scenarioFromCurves({
			name: "replay",
			startCurve: CURVE,
			endCurve: end,
		});
		const viaScenario = repriceHoldings({
			holdings,
			curve: CURVE,
			shiftBasisPoints: scenario.shiftBasisPoints,
		});
		const direct = repriceHoldings({ holdings, curve: end });
		// Not exact away from the key rates, since the scenario is the true move
		// sampled at twelve points and interpolated linearly between them. Within
		// a tenth of a basis point of value is the standard here.
		expect(Math.abs(viaScenario / direct - 1)).toBeLessThan(1e-4);
	});
});
