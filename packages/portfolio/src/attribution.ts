import { type TCurveParams, zeroRate } from "./curve";
import { settlementFor, yearFraction } from "./dates";
import type { TLedger, TSecurityTerms, TTrade } from "./ledger";
import type { TPricer } from "./pricers";

/**
 * Where a portfolio's return came from, over any period.
 *
 * THE PER-SECURITY DECOMPOSITION is saferate-treasury's returnAttribution.ts
 * (Bolder 2015), ported: value is walked from the start price to the end price
 * through exact repricings of the real cashflows, so the pieces sum to what
 * happened with nothing to reconcile.
 *   carry      the start curve's forwards realised: the riskless return,
 *              identical for every bond
 *   rolldown   the curve unchanged, the bond ageing down it
 *   curve      the curve moving to where it went; split, again by exact
 *              repricing, into the Diebold-Li level (shift), slope (twist) and
 *              curvature (butterfly) of the day's zero change, fitted on fixed
 *              loadings (decay 1/1.3684 years, the object the treasury repo's
 *              attributeCurveByFactor and its Diebold-Li curves use), and the
 *              shape left over. NOT by the fitted curve's own parameters:
 *              measured 2026-09-25 to 09-28, theta0 moved +152bp in a day
 *              while theta3 moved -40bp against it, so splitting on them books
 *              large offsetting fictions.
 *   selection  what is left: the change in the security's cheapness to the curve
 *
 * WHAT THIS ADDS: it runs DAILY on the ledger's own holdings, then links the
 * days (Carino), which is the fix the treasury repo's script named for itself
 * ("daily attribution, linked, needs daily holdings nobody has yet"). A trade
 * changes the holdings from the next day on, and its price against that day's
 * close is booked to `trading`.
 *
 * Notes and bonds are decomposed on the nominal zero curve. Bills sit below
 * the curve's fitted domain (it starts at one year), a TIPS is priced off the
 * real curve and a floater off its index, so each of those is split only into
 * income (accrual and coupons) and price. Cash interest is its own line.
 */

export type TAttributionKey =
	| "carry"
	| "rolldown"
	| "curveShift"
	| "curveTwist"
	| "curveButterfly"
	| "curveShape"
	| "selection"
	| "otherIncome"
	| "otherPrice"
	| "trading"
	| "cash";

export const ATTRIBUTION_LABEL: Record<TAttributionKey, string> = {
	carry: "Carry",
	rolldown: "Roll-down",
	curveShift: "Curve: level shift",
	curveTwist: "Curve: slope (twist)",
	curveButterfly: "Curve: curvature (butterfly)",
	curveShape: "Curve: other shape",
	selection: "Selection",
	otherIncome: "Bills, TIPS, FRNs: income",
	otherPrice: "Bills, TIPS, FRNs: price",
	trading: "Trading (trade price vs close)",
	cash: "Interest on cash",
};

export const ATTRIBUTION_KEYS = Object.keys(
	ATTRIBUTION_LABEL,
) as TAttributionKey[];

type TDollars = Record<TAttributionKey, number>;
const zero = (): TDollars =>
	Object.fromEntries(ATTRIBUTION_KEYS.map((k) => [k, 0])) as TDollars;

/** Diebold-Li's decay, in years: the slope loading halves at about 1.37 years. */
const DL_DECAY = 1 / 1.3684;
const FACTOR_TENORS = [1, 2, 3, 5, 7, 10, 15, 20, 25, 30];

/** Level, slope and curvature loadings at a maturity (nelsonSiegelLoadings, ported). */
const loadings = (t: number): [number, number, number] => {
	const u = DL_DECAY * t;
	const decay = (1 - Math.exp(-u)) / u;
	return [1, decay, decay - Math.exp(-u)];
};

/** Least squares of the zero change (bp) on the three loadings: 3x3 normal equations. */
export const fitFactors = (start: TCurveParams, end: TCurveParams) => {
	const rows = FACTOR_TENORS.map((t) => ({
		x: loadings(t),
		y: (zeroRate(end, t) - zeroRate(start, t)) * 100,
	}));
	const a = [0, 1, 2].map((i) =>
		[0, 1, 2].map((j) => rows.reduce((s, r) => s + r.x[i] * r.x[j], 0)),
	);
	const b = [0, 1, 2].map((i) => rows.reduce((s, r) => s + r.x[i] * r.y, 0));
	// Gaussian elimination; the loadings are well conditioned on these tenors.
	const m = a.map((row, i) => [...row, b[i]]);
	for (let c = 0; c < 3; c++) {
		const pivot = m
			.slice(c)
			.reduce(
				(best, row, k) => (Math.abs(row[c]) > Math.abs(m[best][c]) ? c + k : best),
				c,
			);
		[m[c], m[pivot]] = [m[pivot], m[c]];
		for (let r = 0; r < 3; r++) {
			if (r === c) continue;
			const f = m[r][c] / m[c][c];
			for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
		}
	}
	return {
		levelBp: m[0][3] / m[0][0],
		slopeBp: m[1][3] / m[1][1],
		curvatureBp: m[2][3] / m[2][2],
	};
};

type TZero = (t: number) => number;

/**
 * One nominal holding over one step, decomposed. PORTED from
 * attributeSecurityReturn (returnAttribution.ts); the curve term is split by
 * repricing on the start curve plus each fitted factor in turn.
 */
export const decomposeHolding = ({
	face,
	payments,
	paymentsYears,
	startDirty,
	endDirty,
	startCurve,
	endCurve,
	periodYears,
	factors = fitFactors(startCurve, endCurve),
}: {
	face: number;
	/** Per 100 of face, in date order, measured from the step's start settlement. */
	payments: number[];
	paymentsYears: number[];
	startDirty: number;
	endDirty: number;
	startCurve: TCurveParams;
	endCurve: TCurveParams;
	periodYears: number;
	factors?: { levelBp: number; slopeBp: number; curvatureBp: number };
}) => {
	const scale = face / 100;
	const startZ: TZero = (t) => zeroRate(startCurve, t);
	const endZ: TZero = (t) => zeroRate(endCurve, t);
	const df = (z: TZero, t: number) => {
		const time = Math.max(t, 1e-9);
		return Math.exp((-z(time) / 100) * time);
	};
	const shifted =
		(level: number, slope: number, curvature: number): TZero =>
		(t) => {
			const [l, s1, c] = loadings(Math.max(t, 1e-9));
			return startZ(t) + (level * l + slope * s1 + curvature * c) / 100;
		};
	// Coupons inside the step, carried to its end at the start curve's forwards;
	// the same figure enters every counterfactual, so it cancels.
	let reinvested = 0;
	for (let i = 0; i < payments.length; i++)
		if (paymentsYears[i] <= periodYears)
			reinvested +=
				(payments[i] * df(startZ, paymentsYears[i])) / df(startZ, periodYears);
	const remainingAged = (z: TZero) => {
		let total = 0;
		for (let i = 0; i < payments.length; i++)
			if (paymentsYears[i] > periodYears)
				total += payments[i] * df(z, paymentsYears[i] - periodYears);
		return total;
	};
	const startValue = scale * startDirty;
	const endValue = scale * (endDirty + reinvested);
	const growth = 1 / df(startZ, periodYears);
	let onCurveStart = 0;
	for (let i = 0; i < payments.length; i++)
		onCurveStart += payments[i] * df(startZ, paymentsYears[i]);
	const carriedMispricing = (startValue - scale * onCurveStart) * growth;

	const underForwards = startValue * growth;
	const valueOn = (z: TZero) =>
		scale * (remainingAged(z) + reinvested) + carriedMispricing;
	const underStatic = valueOn(startZ);
	const { levelBp, slopeBp, curvatureBp } = factors;
	const withShift = valueOn(shifted(levelBp, 0, 0));
	const withTwist = valueOn(shifted(levelBp, slopeBp, 0));
	const withButterfly = valueOn(shifted(levelBp, slopeBp, curvatureBp));
	const underEnd = valueOn(endZ);
	return {
		carry: underForwards - startValue,
		rolldown: underStatic - underForwards,
		curveShift: withShift - underStatic,
		curveTwist: withTwist - withShift,
		curveButterfly: withButterfly - withTwist,
		curveShape: underEnd - withButterfly,
		selection: endValue - underEnd,
		total: endValue - startValue,
	};
};

export type TAttributionDay = {
	date: string;
	base: number;
	dailyReturn: number | null;
	dollars: TDollars;
};

/**
 * Decompose every day of a ledger. Needs what the ledger ran on, plus the
 * fitted curve for each day (a day without one uses the last fitted day's).
 */
export const attributeLedger = ({
	ledger,
	trades,
	terms,
	pricers,
	marks,
	curves,
	window,
}: {
	/** Only decompose days in (start, end]; the rest are tracked, not priced. */
	window?: { start: string | null; end: string };
	ledger: TLedger;
	trades: TTrade[];
	terms: Map<string, TSecurityTerms>;
	pricers: Map<string, TPricer>;
	marks: Map<string, { date: string; close: number }[]>;
	curves: Map<string, TCurveParams>;
}): TAttributionDay[] => {
	const closeIndex = new Map<string, Map<string, number>>();
	for (const [cusip, series] of marks)
		closeIndex.set(cusip, new Map(series.map((m) => [m.date, m.close])));
	const lastClose = new Map<string, number>();
	const closeOn = (cusip: string, date: string) => {
		const exact = closeIndex.get(cusip)?.get(date);
		if (exact !== undefined) lastClose.set(cusip, exact);
		return lastClose.get(cusip);
	};
	const booked = new Map<string, TTrade[]>();
	const allTrades = [...trades, ...ledger.reinvestments];
	for (const t of allTrades) {
		const day = ledger.days.find((d) => d.date >= t.tradeDate)?.date;
		if (day !== undefined) booked.set(day, [...(booked.get(day) ?? []), t]);
	}
	const interest = new Map<string, number>();
	for (const f of ledger.cashflows)
		if (f.kind === "interest")
			interest.set(f.bookedOn, (interest.get(f.bookedOn) ?? 0) + f.amount);

	let curve: TCurveParams | undefined;
	const held = new Map<string, number>();
	const out: TAttributionDay[] = [];
	let previous: { date: string; marketValue: number } | null = null;
	let previousCloses = new Map<string, number>();

	for (const day of ledger.days) {
		const dollars = zero();
		const startCurve = curve;
		curve = curves.get(day.date) ?? curve;
		// Every close up to today, so a stale mark carries.
		for (const cusip of terms.keys()) closeOn(cusip, day.date);

		const inWindow =
			window === undefined ||
			((window.start === null || day.date > window.start) &&
				day.date <= window.end);
		if (
			inWindow &&
			previous !== null &&
			startCurve !== undefined &&
			curve !== undefined
		) {
			const s0 = settlementFor(previous.date);
			const s1 = settlementFor(day.date);
			const periodYears = yearFraction(s0, s1);
			const factors = fitFactors(startCurve, curve);
			for (const [cusip, face] of held) {
				const security = terms.get(cusip);
				const pricer = pricers.get(cusip);
				const startClose = previousCloses.get(cusip);
				const endClose = lastClose.get(cusip);
				if (
					!security ||
					!pricer ||
					face <= 1e-9 ||
					startClose === undefined ||
					endClose === undefined
				)
					continue;
				const matured = security.maturityDate <= s1;
				const startDirty = pricer.dirty(startClose, previous.date);
				const endDirty = matured ? 0 : pricer.dirty(endClose, day.date);
				// Every payment still to come after the step's start, per 100: coupons
				// on their dates, and the principal (with a final coupon) at maturity.
				const couponDays = new Set(pricer.couponDates(s0).filter((c) => c > s0));
				const dates = [...new Set([...couponDays, security.maturityDate])].sort();
				const payments = dates.map(
					(d) =>
						(d === security.maturityDate ? pricer.redemption() : 0) +
						(couponDays.has(d) ? pricer.coupon(d) : 0),
				);
				const inWindow = payments.reduce(
					(s, p, i) => (dates[i] <= s1 ? s + p : s),
					0,
				);
				if (security.family === "note" || security.family === "bond") {
					const piece = decomposeHolding({
						face,
						payments,
						paymentsYears: dates.map((d) => yearFraction(s0, d)),
						startDirty,
						endDirty,
						startCurve,
						endCurve: curve,
						periodYears,
						factors,
					});
					for (const key of [
						"carry",
						"rolldown",
						"curveShift",
						"curveTwist",
						"curveButterfly",
						"curveShape",
						"selection",
					] as const)
						dollars[key] += piece[key];
				} else {
					// Income: the change in accrued interest plus anything paid;
					// price: the change in clean (times the ratio, for a TIPS).
					const accruedStart = pricer.accrued(s0);
					const accruedEnd = matured ? 0 : pricer.accrued(s1);
					const total = (face / 100) * (endDirty + inWindow - startDirty);
					const income =
						(face / 100) *
						(accruedEnd -
							accruedStart +
							(matured ? inWindow - pricer.redemption() : inWindow));
					dollars.otherIncome += income;
					dollars.otherPrice += total - income;
				}
			}
		}

		// Today's trades: their price against today's close is trading, and
		// they change what is held from tomorrow.
		for (const t of booked.get(day.date) ?? []) {
			const pricer = pricers.get(t.cusip);
			const close = lastClose.get(t.cusip) ?? t.cleanPrice;
			if (pricer === undefined) continue;
			const atClose = pricer.dirty(close, day.date);
			const atTrade = pricer.tradeDirty(t.cleanPrice, t.settleDate);
			dollars.trading +=
				(t.faceAmount / 100) *
				(t.side === "buy" ? atClose - atTrade : atTrade - atClose);
			held.set(
				t.cusip,
				(held.get(t.cusip) ?? 0) +
					(t.side === "buy" ? t.faceAmount : -t.faceAmount),
			);
		}
		for (const [cusip] of held) {
			const security = terms.get(cusip);
			if (security && security.maturityDate <= settlementFor(day.date))
				held.delete(cusip);
		}
		dollars.cash += interest.get(day.date) ?? 0;

		out.push({
			date: day.date,
			base: (previous?.marketValue ?? 0) + day.contributions,
			dailyReturn: day.dailyReturn,
			dollars,
		});
		previousCloses = new Map(lastClose);
		previous = { date: day.date, marketValue: day.marketValue };
	}
	return out;
};

export type TAttributionPeriod = {
	start: string | null;
	end: string;
	/** The period's time-weighted return, chained. */
	totalReturn: number | null;
	/** Each component in dollars and, Carino-linked, as a share of the return. */
	components: {
		key: TAttributionKey;
		label: string;
		dollars: number;
		contribution: number;
	}[];
	/** Return less the linked components: rounding, plus anything unexplained. */
	residual: number;
};

/**
 * Link the days in (start, end] with Carino's method, so the components add to
 * the chained return. Each day's component return is dollars over the day's
 * base (opening value plus new money), the ledger's own denominator.
 */
export const attributionOver = (
	days: TAttributionDay[],
	start: string | null,
	end: string,
): TAttributionPeriod => {
	const inPeriod = days.filter(
		(d) => (start === null || d.date > start) && d.date <= end && d.base > 1e-9,
	);
	const dollars = zero();
	for (const d of inPeriod)
		for (const k of ATTRIBUTION_KEYS) dollars[k] += d.dollars[k];
	if (inPeriod.length === 0)
		return { start, end, totalReturn: null, components: [], residual: 0 };
	const growth = inPeriod.reduce((g, d) => g * (1 + (d.dailyReturn ?? 0)), 1);
	const total = growth - 1;
	const k = (r: number) => (Math.abs(r) < 1e-12 ? 1 : Math.log1p(r) / r);
	const bigK = k(total);
	const linked = zero();
	for (const d of inPeriod) {
		const weight = k(d.dailyReturn ?? 0) / bigK;
		for (const key of ATTRIBUTION_KEYS)
			linked[key] += (weight * d.dollars[key]) / d.base;
	}
	const components = ATTRIBUTION_KEYS.map((key) => ({
		key,
		label: ATTRIBUTION_LABEL[key],
		dollars: dollars[key],
		contribution: linked[key],
	}));
	return {
		start,
		end,
		totalReturn: total,
		components,
		residual: total - components.reduce((s, c) => s + c.contribution, 0),
	};
};
