import { immunise } from "./build/immunisation";
import {
	matchCashflows,
	type TMatchingFailure,
	type TMatchingResult,
} from "./build/cashflowMatching";
import {
	accruedPer100,
	couponDates,
	settlementFor,
	yearFraction,
} from "./dates";
import { type TCurveParams, zeroRate } from "./curve";
import type { TFamily } from "./ledger";
import { KEY_RATES, keyRateBumpWeight } from "./risk/keyRates";

/**
 * The Portfolio Builder's logic: turn today's priced Treasuries into a
 * recommended portfolio for a liability stream or a strategy.
 *
 * Two optimisers, both saferate-treasury's (ported with their tests into
 * src/build): cash-flow matching, the lowest-cost set of bonds whose coupons
 * and principal meet every liability on or before its date (a linear
 * programme, with optional branch and bound for a position cap); and the
 * strategy templates below, which are rules, not optimisations.
 *
 * Only bills, notes and bonds are used. A TIPS pays on future CPI and a floater
 * on future bill rates, so neither has a known cashflow to match a liability
 * with.
 *
 * Prices are the latest END OF DAY close, the index's mark, plus a markup the
 * caller chooses to stand for the offer side: FedInvest's own SELL column is
 * the noisier one (saferate-treasury fedInvestPrices.ts), so it is not used.
 */

export type TUniverseSecurity = {
	cusip: string;
	family: TFamily | null;
	couponPercent: number;
	maturityDate: string;
	/** Clean close per 100. */
	price: number;
};

export type TPlannedSecurity = TUniverseSecurity & {
	/** Clean price per 100 the plan is costed at: the close plus the markup. */
	planPrice: number;
	/** Dirty price per 100: planPrice plus accrued to settlement. */
	dirtyPrice: number;
	/** Every remaining payment per 100, dated. */
	payments: { date: string; amount: number }[];
};

const NOMINAL = new Set<TFamily>(["bill", "note", "bond"]);

/** Price, accrue and schedule the nominal universe for a settlement date. */
export const planUniverse = ({
	securities,
	settlementDate,
	markup,
}: {
	securities: TUniverseSecurity[];
	settlementDate: string;
	/** Added to the clean close, per 100 (4/32 = 0.125). */
	markup: number;
}): TPlannedSecurity[] =>
	securities
		.filter(
			(s) =>
				s.family !== null &&
				NOMINAL.has(s.family) &&
				s.maturityDate > settlementDate &&
				s.price > 0,
		)
		.map((s) => {
			const couponRate = s.couponPercent / 100;
			const planPrice = s.price + markup;
			const coupons =
				couponRate > 0
					? couponDates({
							maturityDate: s.maturityDate,
							from: settlementDate,
							frequency: 2,
						}).filter((d) => d > settlementDate)
					: [];
			const payments = coupons.map((date) => ({
				date,
				amount: (couponRate * 100) / 2 + (date === s.maturityDate ? 100 : 0),
			}));
			if (!coupons.includes(s.maturityDate))
				payments.push({ date: s.maturityDate, amount: 100 });
			return {
				...s,
				planPrice,
				dirtyPrice:
					planPrice +
					accruedPer100({
						couponRate,
						maturityDate: s.maturityDate,
						settlementDate,
						frequency: 2,
					}),
				payments,
			};
		});

export type TLiabilityInput = { date: string; amount: number };

export type TPlanPosition = {
	cusip: string;
	faceAmount: number;
	/** Dollars at the plan price, accrued included. */
	cost: number;
	security: TPlannedSecurity;
};

export type TPlan = {
	method: string;
	positions: TPlanPosition[];
	cost: number;
	notes: string[];
	/** Cash-flow matching only. */
	matching?: {
		surplusByDate: { date: string; amount: number; surplus: number }[];
		relaxationCost: number;
		provenOptimal: boolean;
		marginalCostByDate: { date: string; perDollar: number }[];
	};
};

/**
 * Cash-flow matching (dedication): the cheapest portfolio whose payments,
 * each placed on the first liability date at or after it (money that arrives
 * early can wait; money that arrives late cannot), meet every liability.
 * Surplus carries forward at `reinvestmentRate` per period (0: conservative).
 */
export const matchLiabilities = ({
	universe,
	liabilities,
	denomination = 100,
	maxPositions,
	minLot,
	reinvestmentRate = 0,
	maxNodes = 200,
}: {
	universe: TPlannedSecurity[];
	liabilities: TLiabilityInput[];
	denomination?: number;
	maxPositions?: number;
	minLot?: number;
	reinvestmentRate?: number;
	maxNodes?: number;
}): TPlan | TMatchingFailure => {
	const sorted = [...liabilities].sort((a, b) => a.date.localeCompare(b.date));
	const last = sorted.at(-1)?.date ?? "";
	// Anything maturing after the last liability can only help through coupons,
	// and its principal would have to be sold at an unknown price: left out.
	const eligible = universe.filter((s) => s.maturityDate <= last);
	const securities = eligible.map((s) => ({
		cusip: s.cusip,
		askPrice: s.dirtyPrice,
		cashflows: sorted.map((liability, t) =>
			s.payments
				.filter(
					(p) =>
						p.date <= liability.date && (t === 0 || p.date > sorted[t - 1].date),
				)
				.reduce((sum, p) => sum + p.amount, 0),
		),
	}));
	const result = matchCashflows({
		securities,
		liabilities: sorted.map((l) => ({ date: l.date, amount: l.amount })),
		options: { denomination, maxPositions, minLot, reinvestmentRate, maxNodes },
	});
	if ("kind" in result) return result;
	const r = result as TMatchingResult;
	// Belt and braces: a "solution" that leaves any date short is not one.
	const shortAt = sorted.findIndex((_, t) => (r.surplus[t] ?? 0) < -0.01);
	if (shortAt !== -1)
		return {
			kind: "uncoverable",
			date: sorted[shortAt].date,
			message: `The securities available cannot cover the liability on ${sorted[shortAt].date}: it is short by $${(-(r.surplus[shortAt] ?? 0)).toFixed(2)}.`,
		};
	const byCusip = new Map(eligible.map((s) => [s.cusip, s]));
	return {
		method: "Cash-flow matching",
		positions: r.positions.map((p) => ({
			cusip: p.cusip,
			faceAmount: p.faceValue,
			cost: p.cost,
			security: byCusip.get(p.cusip) as TPlannedSecurity,
		})),
		cost: r.cost,
		notes: r.provenOptimal
			? []
			: [
					"The position cap stopped the search before it proved this is the cheapest; it is the best found.",
				],
		matching: {
			surplusByDate: sorted.map((l, t) => ({
				date: l.date,
				amount: l.amount,
				surplus: r.surplus[t] ?? 0,
			})),
			relaxationCost: r.relaxationCost,
			provenOptimal: r.provenOptimal,
			marginalCostByDate: sorted.map((l, t) => ({
				date: l.date,
				perDollar: r.marginalCostByDate[t] ?? 0,
			})),
		},
	};
};

/* ─── Immunisation, horizon matching, index tracking ─────────────────────── */

/**
 * Present value on a fitted curve, and the key-rate durations of any dated
 * cashflows: each key rate bumped 1bp with the triangular weights the stored
 * analytics use (keyRateBumpWeight), duration = -dPV/PV per 1bp x 10,000.
 * The same measure for a bond and for a liability, so the match is like for like.
 */
export const keyRateProfile = (
	cashflows: { years: number; amount: number }[],
	curve: TCurveParams,
) => {
	const pv = (bumpAt: number | null) =>
		cashflows.reduce((sum, f) => {
			if (f.years <= 0) return sum;
			const bump =
				bumpAt === null ? 0 : keyRateBumpWeight(f.years, bumpAt, KEY_RATES) / 100;
			return (
				sum +
				f.amount * Math.exp((-(zeroRate(curve, f.years) + bump) / 100) * f.years)
			);
		}, 0);
	const presentValue = pv(null);
	const keyRateDurations = KEY_RATES.map((_, k) =>
		presentValue > 0 ? (-(pv(k) - presentValue) / presentValue) * 10_000 : 0,
	);
	return { presentValue, keyRateDurations };
};

const roundedPositions = (
	positions: { cusip: string; faceValue: number }[],
	universe: TPlannedSecurity[],
	denomination: number,
): TPlanPosition[] => {
	const byCusip = new Map(universe.map((s) => [s.cusip, s]));
	return positions
		.map((p) => {
			const security = byCusip.get(p.cusip) as TPlannedSecurity;
			const face = Math.floor(p.faceValue / denomination) * denomination;
			return {
				cusip: p.cusip,
				faceAmount: face,
				cost: (face * security.dirtyPrice) / 100,
				security,
			};
		})
		.filter((p) => p.faceAmount > 0);
};

export type TRiskMatch = {
	targetPresentValue: number;
	targetKeyRateDurations: number[];
	achievedKeyRateDurations: number[];
	/** Dollars per bp left unhedged at each key rate, net of the target. */
	residualDv01: number[];
	durationResidual: number;
};

/**
 * Immunisation (Redington; Fisher and Weil; Ho's key rates): the portfolio
 * whose value moves with the target's for small curve moves. Duration matched
 * first, then the twelve-point shape, by non-negative least squares.
 */
export const immuniseTarget = ({
	universe,
	target,
	curve,
	settlementDate,
	denomination = 100,
	method,
}: {
	universe: TPlannedSecurity[];
	target: { presentValue: number; keyRateDurations: number[] };
	curve: TCurveParams;
	settlementDate: string;
	denomination?: number;
	method: string;
}): TPlan & { risk: TRiskMatch } => {
	const securities = universe.map((s) => ({
		cusip: s.cusip,
		askPrice: s.dirtyPrice,
		keyRateDurations: keyRateProfile(
			s.payments.map((p) => ({
				years: yearFraction(settlementDate, p.date),
				amount: p.amount,
			})),
			curve,
		).keyRateDurations,
	}));
	const solved = immunise({ securities, target });
	const positions = roundedPositions(solved.positions, universe, denomination);
	return {
		method,
		positions,
		cost: positions.reduce((s, p) => s + p.cost, 0),
		notes: [
			...(solved.converged
				? []
				: [
						"The solver did not meet its optimality conditions; check the residual risk.",
					]),
			...(() => {
				// Measured 2026-09-29 on ten $1m liabilities from 2032 to 2041:
				// duration matched exactly but $353/bp left at 7 years and $183/bp
				// at 25, offsetting. Single-payment liabilities are shaped like
				// zero-coupon bonds and coupon securities cannot fully reproduce
				// that shape; STRIPS could. Said on the page rather than implied away.
				const total =
					solved.keyRateDurations.reduce((sum, d) => sum + d, 0) *
					target.presentValue *
					1e-4;
				const worst = Math.max(...solved.residualDv01.map(Math.abs));
				return total > 0 && worst > 0.02 * total
					? [
							`Duration is matched, but up to $${worst.toFixed(0)} per basis point is left unhedged at single key rates (offsetting across the curve). Coupon-paying bonds cannot fully reproduce single-payment liabilities; zero-coupon STRIPS would close it.`,
						]
					: [];
			})(),
		],
		risk: {
			targetPresentValue: target.presentValue,
			targetKeyRateDurations: target.keyRateDurations,
			achievedKeyRateDurations: solved.keyRateDurations,
			residualDv01: solved.residualDv01,
			durationResidual: solved.durationResidual,
		},
	};
};

/** Immunise a liability stream: its present value and key-rate profile on today's curve. */
export const immuniseLiabilities = ({
	universe,
	liabilities,
	curve,
	settlementDate,
	denomination,
}: {
	universe: TPlannedSecurity[];
	liabilities: TLiabilityInput[];
	curve: TCurveParams;
	settlementDate: string;
	denomination?: number;
}) =>
	immuniseTarget({
		universe,
		target: keyRateProfile(
			liabilities.map((l) => ({
				years: yearFraction(settlementDate, l.date),
				amount: l.amount,
			})),
			curve,
		),
		curve,
		settlementDate,
		denomination,
		method: "Immunisation",
	});

/**
 * Horizon matching: cash-match the liabilities inside the horizon, where timing
 * matters and reinvestment risk is real, and immunise the rest. What most
 * practitioners actually do (saferate-treasury docs/dedication-brief.md, where
 * it was planned and not built).
 */
export const horizonMatch = ({
	universe,
	liabilities,
	curve,
	settlementDate,
	horizonYears,
	denomination = 100,
}: {
	universe: TPlannedSecurity[];
	liabilities: TLiabilityInput[];
	curve: TCurveParams;
	settlementDate: string;
	horizonYears: number;
	denomination?: number;
}): (TPlan & { risk: TRiskMatch | null }) | TMatchingFailure => {
	const cutoff = new Date(`${settlementDate}T00:00:00Z`);
	cutoff.setUTCFullYear(cutoff.getUTCFullYear() + Math.floor(horizonYears));
	const edge = cutoff.toISOString().slice(0, 10);
	const near = liabilities.filter((l) => l.date <= edge);
	const far = liabilities.filter((l) => l.date > edge);
	const matched =
		near.length === 0
			? null
			: matchLiabilities({ universe, liabilities: near, denomination });
	if (matched !== null && "kind" in matched) return matched;
	const immunised =
		far.length === 0
			? null
			: immuniseLiabilities({
					universe,
					liabilities: far,
					curve,
					settlementDate,
					denomination,
				});
	const merged = new Map<string, TPlanPosition>();
	for (const p of [
		...(matched?.positions ?? []),
		...(immunised?.positions ?? []),
	]) {
		const existing = merged.get(p.cusip);
		merged.set(
			p.cusip,
			existing
				? {
						...existing,
						faceAmount: existing.faceAmount + p.faceAmount,
						cost: existing.cost + p.cost,
					}
				: p,
		);
	}
	const positions = [...merged.values()].sort((a, b) =>
		a.security.maturityDate.localeCompare(b.security.maturityDate),
	);
	return {
		method: `Horizon matching (cash-matched to ${edge}, immunised beyond)`,
		positions,
		cost: positions.reduce((s, p) => s + p.cost, 0),
		notes: [...(matched?.notes ?? []), ...(immunised?.notes ?? [])],
		matching: matched?.matching,
		risk: immunised?.risk ?? null,
	};
};

/**
 * Track an index: a sparse portfolio with the index's key-rate profile, for a
 * budget. saferate-treasury scripts/replicate-index.ts, as a function: the
 * active set leaves most weights at zero, so it holds at most as many
 * securities as there are constraints (fourteen).
 */
export const trackIndex = ({
	universe,
	indexKeyRateDurations,
	budget,
	curve,
	settlementDate,
	denomination,
	indexName,
}: {
	universe: TPlannedSecurity[];
	indexKeyRateDurations: number[];
	budget: number;
	curve: TCurveParams;
	settlementDate: string;
	denomination?: number;
	indexName: string;
}) =>
	immuniseTarget({
		universe,
		target: { presentValue: budget, keyRateDurations: indexKeyRateDurations },
		curve,
		settlementDate,
		denomination,
		method: `Track the ${indexName} index`,
	});

/**
 * A portfolio you choose: CUSIPs and face amounts, costed on the same universe.
 * Any CUSIP not in it (a TIPS, a floater, one not priced today) is reported.
 */
export const customPlan = ({
	universe,
	rows,
}: {
	universe: TPlannedSecurity[];
	rows: { cusip: string; faceAmount: number }[];
}): TPlan => {
	const byCusip = new Map(universe.map((s) => [s.cusip, s]));
	const missing = rows.filter((r) => !byCusip.has(r.cusip)).map((r) => r.cusip);
	const positions = rows
		.filter((r) => byCusip.has(r.cusip) && r.faceAmount > 0)
		.map((r) => {
			const security = byCusip.get(r.cusip) as TPlannedSecurity;
			return {
				cusip: r.cusip,
				faceAmount: r.faceAmount,
				cost: (r.faceAmount * security.dirtyPrice) / 100,
				security,
			};
		});
	return {
		method: "Your portfolio",
		positions,
		cost: positions.reduce((s, p) => s + p.cost, 0),
		notes:
			missing.length > 0
				? [
						`Not in today's bill, note and bond universe, so left out: ${missing.join(", ")}.`,
					]
				: [],
	};
};

/** A plan's own risk: its present value and key-rate profile on the curve. */
export const planRisk = (
	plan: TPlan,
	curve: TCurveParams,
	settlementDate: string,
) => {
	const profile = keyRateProfile(
		plan.positions.flatMap((p) =>
			p.security.payments.map((pay) => ({
				years: yearFraction(settlementDate, pay.date),
				amount: (p.faceAmount / 100) * pay.amount,
			})),
		),
		curve,
	);
	const duration = profile.keyRateDurations.reduce((s, d) => s + d, 0);
	return {
		...profile,
		duration,
		dv01: (profile.presentValue * duration) / 10_000,
	};
};

/* ─── Strategy templates ─────────────────────────────────────────────────── */

export type TStrategyKey =
	| "ladder"
	| "billRoll"
	| "shortEnd"
	| "bullet"
	| "barbell"
	| "intermediate"
	| "long";

export type TStrategy = {
	key: TStrategyKey;
	name: string;
	summary: string;
	pros: string[];
	cons: string[];
};

export const STRATEGIES: readonly TStrategy[] = [
	{
		key: "billRoll",
		name: "Bill roll (cash-heavy)",
		summary:
			"Equal amounts in 4-, 13-, 26- and 52-week bills, rolled as they mature.",
		pros: [
			"Almost no price risk",
			"Very liquid; money back within a year",
			"Exempt from state and local tax, like all Treasuries",
		],
		cons: [
			"Income falls straight away when the Fed cuts",
			"Usually yields less than longer bonds when the curve slopes up",
		],
	},
	{
		key: "shortEnd",
		name: "Short end (1 to 3 years)",
		summary: "A ladder of notes maturing each year from one to three years.",
		pros: [
			"More yield than bills for little duration",
			"Holds its value well through rate moves",
		],
		cons: ["Still exposed when rates are cut", "Reinvestment every year"],
	},
	{
		key: "ladder",
		name: "Ladder",
		summary:
			"Equal amounts maturing every year out to your horizon; each maturity is reinvested at the long end.",
		pros: [
			"Steady maturities spread reinvestment across rate cycles",
			"Simple to run and to explain",
			"Some money always coming due",
		],
		cons: [
			"Not fitted to any particular liability",
			"A middling yield: neither the short end nor the long",
		],
	},
	{
		key: "intermediate",
		name: "Intermediate (3 to 7 years)",
		summary: "A ladder across the belly of the curve, the 3- to 7-year sector.",
		pros: [
			"Most of the long end's yield for about half its duration",
			"The belly is often the richest carry and roll-down",
		],
		cons: [
			"Meaningful losses when rates rise fast (2022)",
			"No money back for three years",
		],
	},
	{
		key: "long",
		name: "Long duration (10 to 30 years)",
		summary: "Bonds from 10 to 30 years: the most duration for the money.",
		pros: [
			"Locks in today's yields for decades",
			"Gains most when rates fall; hedges long liabilities",
		],
		cons: [
			"Large price swings: long Treasuries lost about 30% in 2022",
			"Low convexity cushion per unit of yield",
		],
	},
	{
		key: "bullet",
		name: "Bullet",
		summary: "Concentrated around one maturity: the target year you choose.",
		pros: ["Matches a single future need exactly", "One maturity to watch"],
		cons: [
			"All the reinvestment risk sits on one date",
			"No diversification along the curve",
		],
	},
	{
		key: "barbell",
		name: "Barbell",
		summary: "Half in bills, half in 20- to 30-year bonds, nothing in between.",
		pros: [
			"Liquidity at one end and convexity at the other",
			"Does well when rates move a lot",
		],
		cons: [
			"Loses when the curve reshapes around the belly",
			"More volatile than a ladder of the same duration",
		],
	},
];

const addYears = (iso: string, years: number) => {
	const d = new Date(`${iso}T00:00:00Z`);
	const whole = Math.floor(years);
	d.setUTCFullYear(d.getUTCFullYear() + whole);
	d.setUTCDate(d.getUTCDate() + Math.round((years - whole) * 365.25));
	return d.toISOString().slice(0, 10);
};

/** The security maturing nearest a target date, within a window, preferring notes and bonds past a year. */
const nearest = (
	universe: TPlannedSecurity[],
	target: string,
	families: TFamily[],
) => {
	const candidates = universe.filter(
		(s) => s.family !== null && families.includes(s.family),
	);
	let best: TPlannedSecurity | null = null;
	let gap = Number.POSITIVE_INFINITY;
	for (const s of candidates) {
		const g = Math.abs(
			yearFraction(
				target < s.maturityDate ? target : s.maturityDate,
				target < s.maturityDate ? s.maturityDate : target,
			),
		);
		if (g < gap) {
			gap = g;
			best = s;
		}
	}
	return best;
};

/** Spend `amount` on a security at its dirty price, face rounded down to the denomination. */
const buy = (
	security: TPlannedSecurity,
	amount: number,
	denomination: number,
): TPlanPosition | null => {
	const face =
		Math.floor(((amount / security.dirtyPrice) * 100) / denomination) *
		denomination;
	return face <= 0
		? null
		: {
				cusip: security.cusip,
				faceAmount: face,
				cost: (face * security.dirtyPrice) / 100,
				security,
			};
};

/** Build a strategy's portfolio for a budget. Each rung gets an equal share. */
export const buildStrategy = ({
	strategy,
	universe,
	budget,
	settlementDate,
	horizonYears = 10,
	denomination = 100,
}: {
	strategy: TStrategyKey;
	universe: TPlannedSecurity[];
	budget: number;
	settlementDate: string;
	/** Ladder horizon, or the bullet's target, in years. */
	horizonYears?: number;
	denomination?: number;
}): TPlan => {
	const at = (years: number) => addYears(settlementDate, years);
	const targets: { years: number; families: TFamily[]; weight: number }[] =
		(() => {
			const coupon: TFamily[] = ["note", "bond"];
			const equal = (years: number[], families: TFamily[]) =>
				years.map((y) => ({ years: y, families, weight: 1 / years.length }));
			switch (strategy) {
				case "billRoll":
					return equal([4 / 52, 13 / 52, 26 / 52, 1], ["bill"]);
				case "shortEnd":
					return equal([1, 2, 3], coupon);
				case "intermediate":
					return equal([3, 4, 5, 6, 7], coupon);
				case "long":
					return equal([10, 15, 20, 25, 30], coupon);
				case "ladder": {
					const n = Math.max(2, Math.min(30, Math.round(horizonYears)));
					return equal(
						Array.from({ length: n }, (_, i) => i + 1),
						coupon,
					);
				}
				case "bullet":
					return [
						{ years: horizonYears - 0.5, families: coupon, weight: 1 / 3 },
						{ years: horizonYears, families: coupon, weight: 1 / 3 },
						{ years: horizonYears + 0.5, families: coupon, weight: 1 / 3 },
					];
				case "barbell":
					return [
						...equal([13 / 52, 26 / 52, 1], ["bill"]).map((t) => ({
							...t,
							weight: 0.5 / 3,
						})),
						...equal([20, 25, 30], ["bond"]).map((t) => ({ ...t, weight: 0.5 / 3 })),
					];
			}
		})();
	const chosen = new Map<string, TPlanPosition>();
	for (const t of targets) {
		const security = nearest(universe, at(t.years), t.families);
		if (security === null) continue;
		const bought = buy(security, budget * t.weight, denomination);
		if (bought === null) continue;
		const existing = chosen.get(security.cusip);
		chosen.set(
			security.cusip,
			existing
				? {
						...existing,
						faceAmount: existing.faceAmount + bought.faceAmount,
						cost: existing.cost + bought.cost,
					}
				: bought,
		);
	}
	const positions = [...chosen.values()].sort((a, b) =>
		a.security.maturityDate.localeCompare(b.security.maturityDate),
	);
	return {
		method: STRATEGIES.find((s) => s.key === strategy)?.name ?? strategy,
		positions,
		cost: positions.reduce((s, p) => s + p.cost, 0),
		notes: [],
	};
};

/* ─── What a plan delivers ───────────────────────────────────────────────── */

/** Every payment the plan's positions make, by date. */
export const planCashflows = (plan: TPlan) => {
	const byDate = new Map<string, number>();
	for (const p of plan.positions)
		for (const pay of p.security.payments)
			byDate.set(
				pay.date,
				(byDate.get(pay.date) ?? 0) + (p.faceAmount / 100) * pay.amount,
			);
	return [...byDate]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, amount]) => ({ date, amount }));
};

/** Internal rate of return of paying `cost` at settlement for these cashflows, annual, compounded semiannually as a bond-equivalent yield. */
export const planYield = (plan: TPlan, settlementDate: string) => {
	const flows = planCashflows(plan).map((f) => ({
		t: yearFraction(settlementDate, f.date),
		amount: f.amount,
	}));
	if (plan.cost <= 0 || flows.length === 0) return null;
	const pv = (y: number) =>
		flows.reduce((s, f) => s + f.amount / (1 + y / 2) ** (2 * f.t), 0) -
		plan.cost;
	let low = -0.05;
	let high = 0.5;
	if (pv(low) * pv(high) > 0) return null;
	for (let i = 0; i < 200; i += 1) {
		const mid = (low + high) / 2;
		if (pv(low) * pv(mid) <= 0) high = mid;
		else low = mid;
	}
	return (low + high) / 2;
};

/* ─── Where each order can be placed ─────────────────────────────────────── */

/** The regularly auctioned terms, in years, and how often. */
export const AUCTION_TERMS: readonly {
	label: string;
	years: number;
	family: TFamily;
	cadence: string;
}[] = [
	{ label: "4-week bill", years: 4 / 52, family: "bill", cadence: "weekly" },
	{ label: "8-week bill", years: 8 / 52, family: "bill", cadence: "weekly" },
	{ label: "13-week bill", years: 13 / 52, family: "bill", cadence: "weekly" },
	{ label: "17-week bill", years: 17 / 52, family: "bill", cadence: "weekly" },
	{ label: "26-week bill", years: 26 / 52, family: "bill", cadence: "weekly" },
	{
		label: "52-week bill",
		years: 1,
		family: "bill",
		cadence: "every four weeks",
	},
	{ label: "2-year note", years: 2, family: "note", cadence: "monthly" },
	{ label: "3-year note", years: 3, family: "note", cadence: "monthly" },
	{ label: "5-year note", years: 5, family: "note", cadence: "monthly" },
	{ label: "7-year note", years: 7, family: "note", cadence: "monthly" },
	{
		label: "10-year note",
		years: 10,
		family: "note",
		cadence: "monthly (new issue quarterly)",
	},
	{
		label: "20-year bond",
		years: 20,
		family: "bond",
		cadence: "monthly (new issue quarterly)",
	},
	{
		label: "30-year bond",
		years: 30,
		family: "bond",
		cadence: "monthly (new issue quarterly)",
	},
];

/** TreasuryDirect's non-competitive limit, per security per auction. */
export const TREASURY_DIRECT_LIMIT = 10_000_000;

/**
 * The TreasuryDirect alternative for a position: TreasuryDirect buys only NEW
 * issues at auction (non-competitive, up to $10M a security an auction) and
 * cannot sell, so an existing CUSIP is never TreasuryDirect-eligible. The
 * alternative is the auctioned term maturing nearest the position, bought at
 * its next auction; its date and rate are not known until then.
 */
export const treasuryDirectAlternative = (
	position: { faceAmount: number; maturityDate: string },
	settlementDate: string,
) => {
	const years = yearFraction(settlementDate, position.maturityDate);
	let best = AUCTION_TERMS[0];
	for (const term of AUCTION_TERMS)
		if (Math.abs(term.years - years) < Math.abs(best.years - years)) best = term;
	const mismatchYears = best.years - years;
	return {
		term: best.label,
		cadence: best.cadence,
		mismatchYears,
		/** Close enough that the new issue stands in for the position. */
		isClose: Math.abs(mismatchYears) <= Math.max(0.1, years * 0.1),
		overLimit: position.faceAmount > TREASURY_DIRECT_LIMIT,
	};
};

export { settlementFor };
