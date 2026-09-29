import {
	planUniverse,
	strategyRungs,
	type TLotRules,
	type TStrategyKey,
	type TUniverseSecurity,
} from "./builder";
import { daysBetween, settlementFor, toDate, yearFraction } from "./dates";
import type { TPricer } from "./pricers";
import {
	buildLedger,
	pricersFor,
	type TLedger,
	type TSecurityTerms,
	type TTrade,
	tradeDirtyPer100,
} from "./ledger";

/**
 * A strategy template, run through history: on each rebalance date the
 * template is rebuilt from THAT day's priced universe with the book's own
 * value, and the book trades to it. Everything between rebalances (coupons,
 * maturities, cash earning the bill curve's 1-month rate) is the ledger's,
 * the same code that values a customer's portfolio, so a backtest and a
 * tracked portfolio cannot disagree about what a position earned.
 *
 * SELF-FINANCING. After the first purchase no money comes in: a rebuild whose
 * trades would cost more than the cash on hand (sales included) is scaled
 * down until they do not. The ledger books any shortfall as a contribution
 * anyway, and `externalCash` reports it, so a leak is loud.
 *
 * MANAGED BY SLOTS (slotsFor): a position is held while it sits in one of
 * the template's rungs and sold when it leaves the template's range; the cash
 * (maturities, coupons, sales) buys whichever rungs are short of their equal
 * share of the book. So it is self-financing by construction.
 *
 * COSTS. Every trade crosses a spread: bought at the close plus `costPer100`,
 * sold at the close less it.
 */

export type TRebalanceFrequency = "monthly" | "quarterly" | "annual";

export const REBALANCE_LABEL: Record<TRebalanceFrequency, string> = {
	monthly: "Monthly",
	quarterly: "Quarterly",
	annual: "Yearly",
};

type TMarks = Map<string, { date: string; close: number }[]>;

const addYears = (iso: string, years: number) => {
	const d = toDate(iso);
	const whole = Math.floor(years);
	d.setUTCFullYear(d.getUTCFullYear() + whole);
	d.setUTCDate(d.getUTCDate() + Math.round((years - whole) * 365.25));
	return d.toISOString().slice(0, 10);
};

export type TBacktestData = {
	/** The securities priced on the first market day on or after `date`, and that day. */
	universeOn: (
		date: string,
	) => Promise<{ date: string; securities: TUniverseSecurity[] } | null>;
	/** Terms and closes for these CUSIPs. */
	securities: (
		cusips: string[],
	) => Promise<{ terms: Map<string, TSecurityTerms>; marks: TMarks }>;
	/** Every market day in the window, ascending. */
	calendar: string[];
	/** What cash earns on a date, a decimal. */
	cashRate: (date: string) => number;
};

export type TBacktestInput = {
	strategy: TStrategyKey;
	horizonYears: number;
	start: string;
	end: string;
	frequency: TRebalanceFrequency;
	initial: number;
	/** Half the bid/offer, per 100 of face, paid on every trade. */
	costPer100: number;
	lots: TLotRules;
	data: TBacktestData;
};

/** The nominal rebalance dates from start to end, before moving to market days. */
export const rebalanceSchedule = (
	start: string,
	end: string,
	frequency: TRebalanceFrequency,
) => {
	const months =
		frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : 12;
	const out: string[] = [];
	const first = toDate(start);
	for (let k = 0; ; k++) {
		const d = new Date(
			Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + k * months, 1),
		);
		const iso = k === 0 ? start : d.toISOString().slice(0, 10);
		if (iso > end) break;
		out.push(iso);
	}
	return out;
};

type TRebalance = {
	date: string;
	/** The book's value going in: what the template was rebuilt with. */
	value: number;
	bought: number;
	sold: number;
	trades: number;
	/** Positions in the rebuilt template. */
	held: number;
	notes: string[];
};

const stdev = (xs: number[]) => {
	if (xs.length < 2) return null;
	const m = xs.reduce((s, x) => s + x, 0) / xs.length;
	return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

/**
 * The template's rungs as maturity SLOTS, in years from settlement. A held
 * security whose remaining maturity lies in a slot of its family is that
 * rung, and is held; one that fits no slot has left the template's range and
 * is sold. Slots meet halfway between rungs.
 *
 * Found on the first real run (2026-09-29): rebuilding the template from
 * scratch each quarter picked new securities for every rung, since "one year
 * from now" moves, and turned the book over 300 to 400% a year. A ladder is
 * not run that way: its bonds are held to maturity and the proceeds buy the
 * longest rung. HOLD TO MATURITY: bill roll, short end, ladder, bullet, the
 * barbell's bills (their first slot starts at zero). SOLD ON LEAVING THE
 * SECTOR: intermediate below 2.5 years, long below 9.5, the barbell's bonds
 * below 19.5.
 */
export const slotsFor = (
	strategy: TStrategyKey,
	horizonYears: number,
	/** The bullet's rungs, re-measured to today from their fixed dates. */
	fixedYears: number[] | null,
) => {
	const rungs = strategyRungs(strategy, horizonYears).map((r, i) => ({
		...r,
		years: fixedYears?.[i] ?? r.years,
	}));
	const groups = new Map<string, typeof rungs>();
	for (const r of rungs) {
		const key = r.families.join("+");
		groups.set(key, [...(groups.get(key) ?? []), r]);
	}
	const sellsBelow =
		strategy === "intermediate" || strategy === "long" || strategy === "barbell";
	return [...groups.values()].flatMap((group) => {
		const sorted = [...group].sort((a, b) => a.years - b.years);
		const isBills = sorted[0].families.includes("bill");
		return (
			sorted
				.map((r, i) => {
					const below = sorted[i - 1]?.years;
					const above = sorted[i + 1]?.years;
					const halfBelow = below === undefined ? null : (r.years - below) / 2;
					const halfAbove = above === undefined ? null : (above - r.years) / 2;
					const edge = Math.min(halfBelow ?? halfAbove ?? 0.5, 0.5);
					return {
						label:
							r.years < 1
								? `${Math.round(r.years * 52)}-week`
								: `${Number(r.years.toFixed(1))}-year`,
						years: r.years,
						families: r.families,
						weight: r.weight,
						lo:
							i === 0
								? sellsBelow && !isBills
									? r.years - edge
									: 0
								: r.years - (halfBelow ?? edge),
						hi:
							i === sorted.length - 1
								? r.years + (halfBelow ?? edge)
								: r.years + (halfAbove ?? edge),
						value: 0,
					};
				})
				// A bullet rung whose date has passed is done: its share stays in cash.
				.filter((slot) => slot.years > 0)
		);
	});
};

export const runBacktest = async (input: TBacktestInput) => {
	const {
		strategy,
		horizonYears,
		start,
		end,
		frequency,
		initial,
		costPer100,
		lots,
		data,
	} = input;
	const trades: TTrade[] = [];
	const terms = new Map<string, TSecurityTerms>();
	const marks: TMarks = new Map();
	const ensure = async (cusips: string[]) => {
		const missing = [...new Set(cusips)].filter((c) => !terms.has(c));
		if (missing.length === 0) return;
		const got = await data.securities(missing);
		for (const [c, t] of got.terms) terms.set(c, t);
		for (const [c, m] of got.marks) marks.set(c, m);
	};
	const ledgerTo = (asOf: string): TLedger | null => {
		const first = trades[0]?.tradeDate;
		if (first === undefined) return null;
		return buildLedger({
			trades,
			terms,
			marks,
			calendar: data.calendar.filter((d) => d >= first && d <= asOf),
			asOf,
			income: "cash",
			cashRate: data.cashRate,
			pricers: pricersFor(terms),
			// The whole starting amount is in the book from day one; what the
			// template cannot place waits in cash.
			openingCash: initial,
		});
	};

	// The bullet's rungs are fixed in time from the start; every other
	// template's rungs are measured from each rebalance's settlement.
	const startSettlement = settlementFor(start);
	const bulletDates =
		strategy === "bullet"
			? strategyRungs("bullet", horizonYears).map((r) =>
					addYears(startSettlement, r.years),
				)
			: [];

	const rebalances: TRebalance[] = [];
	const used = new Set<string>();
	for (const nominal of rebalanceSchedule(start, end, frequency)) {
		const day = await data.universeOn(nominal);
		if (day === null || day.date > end || used.has(day.date)) continue;
		used.add(day.date);
		const date = day.date;
		const settlement = settlementFor(date);
		const close = new Map(day.securities.map((s) => [s.cusip, s.price]));
		const universe = planUniverse({
			securities: day.securities,
			settlementDate: settlement,
			markup: costPer100,
		});
		const yearsTo = (maturity: string) => yearFraction(settlement, maturity);

		const ledger = ledgerTo(date);
		const value = ledger?.days.at(-1)?.marketValue ?? initial;
		let available = ledger === null ? initial : ledger.cash;
		const slots = slotsFor(
			strategy,
			horizonYears,
			strategy === "bullet" ? bulletDates.map(yearsTo) : null,
		);
		const pricers = pricersFor(terms);
		const orders: TTrade[] = [];
		const notes: string[] = [];
		let bought = 0;
		let sold = 0;

		// 1. What is held: in a slot it stays; out of the template's range it
		//    is sold. Maturing inside settlement: the ledger redeems it.
		for (const [cusip, face] of ledger?.holdings ?? []) {
			const security = terms.get(cusip);
			const price = close.get(cusip);
			if (face <= 1e-6 || security === undefined) continue;
			if (security.maturityDate <= settlement) continue;
			const remaining = yearsTo(security.maturityDate);
			const slot = slots.find(
				(s) =>
					s.families.includes(security.family) &&
					remaining >= s.lo &&
					remaining < s.hi,
			);
			if (price === undefined) {
				if (slot) slot.value += face; // no close today: carried at par, held
				continue;
			}
			const dirty = (pricers.get(cusip) as TPricer).dirty(price, date);
			if (slot !== undefined) {
				slot.value += (face / 100) * dirty;
				continue;
			}
			const sale: TTrade = {
				idTransaction: `bt:${date}:${cusip}:sell`,
				cusip,
				side: "sell",
				tradeDate: date,
				settleDate: settlement,
				faceAmount: face,
				cleanPrice: price - costPer100,
			};
			const proceeds =
				(face / 100) * tradeDirtyPer100(pricers.get(cusip) as TPricer, sale);
			orders.push(sale);
			available += proceeds;
			sold += proceeds;
		}

		// 2. What each slot is short of its equal share of the book, bought with
		//    the cash there is (pro rata when there is not enough).
		const short = slots.map((s) => Math.max(0, s.weight * value - s.value));
		const wanted = short.reduce((a, b) => a + b, 0);
		const scale = wanted > available ? available / wanted : 1;
		slots.forEach((slot, i) => {
			const amount = short[i] * scale;
			if (amount < lots.minimumOrder) return;
			const candidates = universe.filter(
				(u) =>
					u.family !== null &&
					slot.families.includes(u.family) &&
					yearsTo(u.maturityDate) >= slot.lo &&
					yearsTo(u.maturityDate) < slot.hi,
			);
			const pick = candidates.sort(
				(a, b) =>
					Math.abs(yearsTo(a.maturityDate) - slot.years) -
					Math.abs(yearsTo(b.maturityDate) - slot.years),
			)[0];
			if (pick === undefined) {
				notes.push(
					`Nothing priced for the ${slot.label} rung; its share stays in cash.`,
				);
				return;
			}
			const face =
				Math.floor(((amount / pick.dirtyPrice) * 100) / lots.increment) *
				lots.increment;
			if (face < lots.minimumOrder) return;
			orders.push({
				idTransaction: `bt:${date}:${pick.cusip}:buy`,
				cusip: pick.cusip,
				side: "buy",
				tradeDate: date,
				settleDate: settlement,
				faceAmount: face,
				cleanPrice: pick.planPrice,
			});
			bought += (face / 100) * pick.dirtyPrice;
		});
		await ensure(orders.map((o) => o.cusip));
		trades.push(...orders);
		rebalances.push({
			date,
			value,
			bought,
			sold,
			trades: orders.length,
			held: slots.filter(
				(s, i) => s.value > 0 || short[i] * scale >= lots.minimumOrder,
			).length,
			notes,
		});
	}

	const ledger = ledgerTo(end);
	if (ledger === null || ledger.days.length === 0)
		return {
			ok: false as const,
			message: "Nothing could be bought on the start date.",
		};

	// The growth of $1 and what it says.
	let growth = 1;
	let peak = 1;
	let maxDrawdown = 0;
	const series: { date: string; growth: number }[] = [];
	const daily: number[] = [];
	for (const d of ledger.days) {
		if (d.dailyReturn !== null) {
			growth *= 1 + d.dailyReturn;
			daily.push(d.dailyReturn);
		}
		peak = Math.max(peak, growth);
		maxDrawdown = Math.min(maxDrawdown, growth / peak - 1);
		series.push({ date: d.date, growth });
	}
	const first = ledger.days[0];
	const last = ledger.days.at(-1) ?? first;
	const years = daysBetween(toDate(first.date), toDate(last.date)) / 365.25;
	const cumulative = growth - 1;
	const averageValue =
		ledger.days.reduce((s, d) => s + d.marketValue, 0) / ledger.days.length;
	const traded = rebalances.slice(1).reduce((s, r) => s + r.bought + r.sold, 0);
	const invested = first.contributions;
	const externalCash = ledger.days
		.slice(1)
		.reduce((s, d) => s + d.contributions, 0);
	const vol = stdev(daily);
	const annualised =
		years > 1 ? (1 + cumulative) ** (1 / years) - 1 : cumulative;
	return {
		ok: true as const,
		start: first.date,
		end: last.date,
		invested,
		finalValue: last.marketValue,
		cumulative,
		annualised,
		volatility: vol === null ? null : vol * Math.sqrt(252),
		maxDrawdown,
		/** Buys plus sells after the first purchase, a year, over the average value. */
		turnover:
			years > 0 && averageValue > 0 ? traded / 2 / averageValue / years : null,
		externalCash,
		income: ledger.cashflows
			.filter((f) => f.kind === "coupon" || f.kind === "interest")
			.reduce((s, f) => s + f.amount, 0),
		trades: trades.length,
		rebalances,
		series,
		cashAtEnd: ledger.cash,
	};
};

export type TBacktestResult = Extract<
	Awaited<ReturnType<typeof runBacktest>>,
	{ ok: true }
>;
