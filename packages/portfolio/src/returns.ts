import { addMonths, daysBetween, settlementFor, toDate, toIso } from "./dates";
import type { TLedger, TSecurityTerms, TTrade, TValuationDay } from "./ledger";
import { pricersFor, tradeDirtyPer100 } from "./ledger";
import type { TPricer } from "./pricers";

/**
 * Returns off a ledger.
 *
 * TIME-WEIGHTED (the reporting standard, and what a benchmark is compared on):
 * daily returns chained geometrically, so the size and timing of the holder's
 * purchases and sales do not move it. MONEY-WEIGHTED: the internal rate of
 * return on the holder's actual cash, which they do.
 *
 * A period is (start, end]: it opens at the close of `start` and includes every
 * day after it through `end`, which is how a month-to-date return reads (from
 * the last close of the prior month).
 */

export type TPeriodKey =
	| "mtd"
	| "qtd"
	| "ytd"
	| "1y"
	| "3y"
	| "5y"
	| "inception"
	| "custom";

export const PERIOD_LABEL: Record<TPeriodKey, string> = {
	mtd: "Month to date",
	qtd: "Quarter to date",
	ytd: "Year to date",
	"1y": "1 year",
	"3y": "3 years",
	"5y": "5 years",
	inception: "Since inception",
	custom: "Custom",
};

const endOfPreviousMonth = (iso: string, monthsBack: number) => {
	const date = toDate(iso);
	return toIso(
		new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - monthsBack, 0)),
	);
};

/** The close a period opens at, for a period ending on `asOf`. Null for inception. */
export const periodStart = (
	key: Exclude<TPeriodKey, "custom">,
	asOf: string,
) => {
	const date = toDate(asOf);
	switch (key) {
		case "mtd":
			return endOfPreviousMonth(asOf, 0);
		case "qtd":
			return endOfPreviousMonth(asOf, date.getUTCMonth() % 3);
		case "ytd":
			return `${date.getUTCFullYear() - 1}-12-31`;
		case "1y":
			return toIso(addMonths(date, -12));
		case "3y":
			return toIso(addMonths(date, -36));
		case "5y":
			return toIso(addMonths(date, -60));
		case "inception":
			return null;
	}
};

export type TPeriodReturn = {
	start: string | null;
	end: string;
	/** Time-weighted, over the period. Null when nothing was held in it. */
	cumulative: number | null;
	/** Annualised when the period is longer than a year; otherwise equal to cumulative. */
	annualised: number | null;
	/** False when the portfolio began after the period opened: the return is since inception. */
	isFullPeriod: boolean;
};

/** Chain the daily returns over (start, end]. */
export const chainReturns = (
	days: TValuationDay[],
	start: string | null,
	end: string,
): TPeriodReturn => {
	const inPeriod = days.filter(
		(d) => (start === null || d.date > start) && d.date <= end,
	);
	const scored = inPeriod.filter((d) => d.dailyReturn !== null);
	const first = days[0]?.date ?? null;
	const isFullPeriod = start === null || (first !== null && first <= start);
	if (scored.length === 0)
		return { start, end, cumulative: null, annualised: null, isFullPeriod };
	const cumulative =
		scored.reduce((growth, d) => growth * (1 + (d.dailyReturn ?? 0)), 1) - 1;
	const opened = start ?? first ?? end;
	const years = daysBetween(toDate(opened), toDate(end)) / 365.25;
	return {
		start,
		end,
		cumulative,
		annualised: years > 1 ? (1 + cumulative) ** (1 / years) - 1 : cumulative,
		isFullPeriod,
	};
};

/** A benchmark's return over (start, end] from its daily levels, oldest first. */
export const levelReturn = (
	levels: { date: string; level: number }[],
	start: string | null,
	end: string,
) => {
	const atOrBefore = (date: string) =>
		[...levels].reverse().find((l) => l.date <= date);
	const opened = start === null ? levels[0] : atOrBefore(start);
	const closed = atOrBefore(end);
	if (opened === undefined || closed === undefined || closed.date <= opened.date)
		return null;
	const cumulative = closed.level / opened.level - 1;
	const years = daysBetween(toDate(opened.date), toDate(end)) / 365.25;
	return {
		cumulative,
		annualised: years > 1 ? (1 + cumulative) ** (1 / years) - 1 : cumulative,
	};
};

/**
 * Money-weighted return: the annual rate r at which every cashflow, and the
 * value still held at `asOf`, discounts to zero. Newton's method with a
 * bisection fallback. Null when there is nothing to solve (no outflow).
 */
export const moneyWeightedReturn = (
	cashflows: { date: string; amount: number }[],
	asOf: string,
	endingValue: number,
) => {
	const flows = [...cashflows, { date: asOf, amount: endingValue }].filter(
		(f) => f.amount !== 0,
	);
	if (!flows.some((f) => f.amount < 0) || !flows.some((f) => f.amount > 0))
		return null;
	const origin = toDate(
		flows.reduce((min, f) => (f.date < min ? f.date : min), flows[0].date),
	);
	const timed = flows.map((f) => ({
		t: daysBetween(origin, toDate(f.date)) / 365.25,
		amount: f.amount,
	}));
	const npv = (r: number) =>
		timed.reduce((sum, f) => sum + f.amount / (1 + r) ** f.t, 0);
	const slope = (r: number) =>
		timed.reduce((sum, f) => sum - (f.t * f.amount) / (1 + r) ** (f.t + 1), 0);

	let r = 0.03;
	for (let i = 0; i < 50; i += 1) {
		const value = npv(r);
		if (Math.abs(value) < 1e-9) return r;
		const step = value / slope(r);
		if (!Number.isFinite(step)) break;
		r -= step;
		if (r <= -0.9999) break;
	}
	let low = -0.9999;
	let high = 10;
	if (npv(low) * npv(high) > 0) return null;
	for (let i = 0; i < 200; i += 1) {
		const mid = (low + high) / 2;
		if (npv(low) * npv(mid) <= 0) high = mid;
		else low = mid;
	}
	return (low + high) / 2;
};

export type TPosition = {
	cusip: string;
	faceAmount: number;
	/** FIFO average clean cost of the face still held, per 100. */
	averageCleanCost: number;
	close: number | null;
	markDate: string | null;
	accruedPer100: number;
	marketValue: number;
	/** face x (close - average cost) / 100: price gain on what is held. */
	unrealisedPriceGain: number | null;
};

/**
 * What is held at the end of the ledger, with FIFO cost. Not tax accounting:
 * no accretion of a discount or amortisation of a premium, so for a bill the
 * whole pull to par shows as price gain.
 */
export const positionsAt = ({
	ledger,
	trades: userTrades,
	terms,
	lastMarks,
	asOf,
	pricers: supplied,
}: {
	ledger: TLedger;
	trades: TTrade[];
	terms: Map<string, TSecurityTerms>;
	lastMarks: Map<string, { date: string; close: number }>;
	asOf: string;
	/** The same TIPS and FRN pricers the ledger ran on. */
	pricers?: Map<string, TPricer>;
}): TPosition[] => {
	const pricers = pricersFor(terms, supplied);
	const trades = [...userTrades, ...ledger.reinvestments];
	const lots = new Map<string, { face: number; clean: number }[]>();
	const ordered = [...trades]
		.filter((t) => t.tradeDate <= asOf)
		.sort(
			(a, b) =>
				a.tradeDate.localeCompare(b.tradeDate) ||
				(a.side === b.side ? 0 : a.side === "buy" ? -1 : 1),
		);
	for (const trade of ordered) {
		const queue = lots.get(trade.cusip) ?? [];
		if (trade.side === "buy")
			queue.push({ face: trade.faceAmount, clean: trade.cleanPrice });
		else {
			let remaining = trade.faceAmount;
			while (remaining > 1e-9 && queue.length > 0) {
				const take = Math.min(remaining, queue[0].face);
				queue[0].face -= take;
				remaining -= take;
				if (queue[0].face <= 1e-9) queue.shift();
			}
		}
		lots.set(trade.cusip, queue);
	}
	const settlement = settlementFor(asOf);
	return [...ledger.holdings]
		.filter(([, face]) => face > 1e-9)
		.map(([cusip, face]) => {
			const pricer = pricers.get(cusip) as TPricer;
			const queue = lots.get(cusip) ?? [];
			const cost = queue.reduce((sum, lot) => sum + lot.face * lot.clean, 0);
			const averageCleanCost = cost / Math.max(face, 1e-9);
			const mark = lastMarks.get(cusip) ?? null;
			const accruedNow = pricer.accrued(settlement);
			return {
				cusip,
				faceAmount: face,
				averageCleanCost,
				close: mark?.close ?? null,
				markDate: mark?.date ?? null,
				accruedPer100: accruedNow,
				marketValue:
					mark === null ? 0 : (face / 100) * pricer.dirty(mark.close, asOf),
				unrealisedPriceGain:
					mark === null ? null : (face * (mark.close - averageCleanCost)) / 100,
			};
		})
		.sort((a, b) => b.marketValue - a.marketValue);
};

/**
 * Price gain realised by sales, per CUSIP, against FIFO cost: face sold x
 * (sale clean - lot clean) / 100. Accrued interest is income, not gain, so it
 * is left out on both sides. Includes positions since sold out or matured
 * (a redemption realises 100 against the lot cost).
 */
export const realisedPriceGains = (
	userTrades: TTrade[],
	ledger: TLedger,
	asOf: string,
) => {
	// Reinvested coupons are purchases too: they are lots with their own cost.
	const trades = [...userTrades, ...ledger.reinvestments];
	const lots = new Map<string, { face: number; clean: number }[]>();
	const gains = new Map<string, number>();
	const events = [
		...trades
			.filter((t) => t.tradeDate <= asOf)
			.map((t) => ({
				date: t.tradeDate,
				cusip: t.cusip,
				side: t.side,
				face: t.faceAmount,
				clean: t.cleanPrice,
			})),
		...ledger.cashflows
			.filter((f) => f.kind === "redemption")
			.map((f) => ({
				date: f.bookedOn,
				cusip: f.cusip,
				side: "sell" as const,
				face: f.faceAmount,
				clean: 100,
			})),
	].sort(
		(a, b) =>
			a.date.localeCompare(b.date) ||
			(a.side === b.side ? 0 : a.side === "buy" ? -1 : 1),
	);
	for (const event of events) {
		const queue = lots.get(event.cusip) ?? [];
		if (event.side === "buy")
			queue.push({ face: event.face, clean: event.clean });
		else {
			let remaining = event.face;
			while (remaining > 1e-9 && queue.length > 0) {
				const take = Math.min(remaining, queue[0].face);
				gains.set(
					event.cusip,
					(gains.get(event.cusip) ?? 0) +
						(take * (event.clean - queue[0].clean)) / 100,
				);
				queue[0].face -= take;
				remaining -= take;
				if (queue[0].face <= 1e-9) queue.shift();
			}
		}
		lots.set(event.cusip, queue);
	}
	return gains;
};

export type TProjectedFlow = {
	date: string;
	cusip: string;
	kind: "coupon" | "redemption";
	amount: number;
	/** A TIPS or FRN figure resting on today's ratio or rate held flat. */
	isEstimate: boolean;
};

/** Coupons and principal still to come on what is held after `asOf`. */
export const projectedIncome = ({
	holdings,
	terms,
	asOf,
	pricers: supplied,
}: {
	holdings: Map<string, number>;
	terms: Map<string, TSecurityTerms>;
	asOf: string;
	pricers?: Map<string, TPricer>;
}): TProjectedFlow[] => {
	const pricers = pricersFor(terms, supplied);
	const settlement = settlementFor(asOf);
	const flows: TProjectedFlow[] = [];
	for (const [cusip, face] of holdings) {
		const security = terms.get(cusip);
		const pricer = pricers.get(cusip);
		if (security === undefined || pricer === undefined || face <= 1e-9) continue;
		for (const date of pricer.couponDates(settlement)) {
			if (date > settlement)
				flows.push({
					date,
					cusip,
					kind: "coupon",
					amount: (face / 100) * pricer.coupon(date),
					isEstimate: pricer.isEstimate(date),
				});
		}
		flows.push({
			date: security.maturityDate,
			cusip,
			kind: "redemption",
			amount: (face / 100) * pricer.redemption(),
			isEstimate: pricer.isEstimate(security.maturityDate),
		});
	}
	return flows.sort(
		(a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind),
	);
};

export type TSummary = {
	asOf: string;
	/** Securities plus cash. */
	marketValue: number;
	cash: number;
	/** New money put in: purchases not met from the portfolio's own cash. */
	invested: number;
	/** Money paid out to the holder. */
	received: number;
	/** marketValue + received - invested: the dollars made. */
	totalGain: number;
	/** Coupons earned, whether paid out, held or reinvested, plus interest on cash. */
	incomeEarned: number;
};

export const summarise = (ledger: TLedger, asOf: string): TSummary => {
	const last = ledger.days.at(-1);
	const invested = ledger.days.reduce((s, d) => s + d.contributions, 0);
	const received = ledger.days.reduce((s, d) => s + d.distributions, 0);
	const marketValue = last?.marketValue ?? 0;
	return {
		asOf: last?.date ?? asOf,
		marketValue,
		cash: last?.cash ?? 0,
		invested,
		received,
		totalGain: marketValue + received - invested,
		incomeEarned: ledger.cashflows
			.filter((f) => f.kind === "coupon" || f.kind === "interest")
			.reduce((s, f) => s + f.amount, 0),
	};
};

/** The dated external cashflows, for the money-weighted return. */
export const externalFlows = (ledger: TLedger) =>
	ledger.days
		.filter((d) => d.contributions !== 0 || d.distributions !== 0)
		.map((d) => ({ date: d.date, amount: d.distributions - d.contributions }));

export { tradeDirtyPer100 };
