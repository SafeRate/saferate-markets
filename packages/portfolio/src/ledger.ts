import { daysBetween, settlementFor, toDate } from "./dates";
import { nominalPricer, type TPricer } from "./pricers";

/**
 * A portfolio's life, day by day, from its trades and the market's closes.
 *
 * THE CONVENTIONS, chosen to agree with Safe Rate's indices so a portfolio and
 * its benchmark are measured the same way (saferate-treasury treasuryIndex.ts,
 * scripts/index-period.ts):
 *  - Marks are the FedInvest END OF DAY close (indexCleanPrice), plus interest
 *    accrued to the T+1 settlement of the mark date.
 *  - A coupon or redemption is credited on the valuation day whose settlement
 *    window (previous settlement, this settlement] contains its date: half
 *    open, so a coupon on a boundary counts once.
 *  - Trade-date holdings. A trade settles T+1 (or on the settlement date
 *    given), so a coupon falling in the day's window belongs to the holdings
 *    BEFORE that day's trades: the buyer settles after it and the seller still
 *    owns it. Accrued interest paid or received in a trade is part of its cash.
 *  - Coupons, redemptions and sale proceeds leave the portfolio as
 *    distributions; purchases enter as contributions. So the return is the
 *    return on the securities themselves, independent of what the holder did
 *    with the cash, and the portfolio carries no cash line.
 *
 * Supported: bills, notes and bonds. A TIPS pays on an inflation-adjusted
 * principal and a floater on a weekly reset, so each needs the valuation the
 * index gives it; the caller refuses them until that is ported.
 */

export type TFamily = "bill" | "note" | "bond" | "tips" | "frn";

export const SUPPORTED_FAMILIES: readonly TFamily[] = ["bill", "note", "bond"];

export type TSecurityTerms = {
	cusip: string;
	family: TFamily;
	/** Decimal. 0 for a bill. */
	couponRate: number;
	maturityDate: string;
	/** Coupons a year: 2 for notes and bonds; unused for bills. */
	frequency: number;
};

export type TTrade = {
	idTransaction: string;
	cusip: string;
	side: "buy" | "sell";
	tradeDate: string;
	settleDate: string;
	faceAmount: number;
	/** Clean, per 100 of face. */
	cleanPrice: number;
};

export type TMark = { date: string; close: number };

export type TCashflowKind =
	| "buy"
	| "sell"
	| "coupon"
	| "redemption"
	| "reinvestment"
	| "interest";

/** The CUSIP a cash line's flows are booked against. */
export const CASH = "CASH";

/**
 * Where coupons, redemptions and sale proceeds go. A portfolio setting, because
 * each is right for a different holder:
 *  - "cash": into a cash line earning the bill rate; purchases draw on it.
 *    How a fund's books run, and close to the index's held-as-cash.
 *  - "reinvest": each coupon buys more of the security that paid it, at that
 *    day's close; principal and sale proceeds go to cash as above.
 *  - "distribute": everything is paid out to the holder; nothing is kept.
 */
export type TIncomePolicy = "cash" | "reinvest" | "distribute";

export const INCOME_POLICY_LABEL: Record<TIncomePolicy, string> = {
	cash: "Held as cash, earning the 1-month bill rate",
	reinvest: "Coupons reinvested in the paying security",
	distribute: "Paid out",
};

export type TCashflow = {
	/** The date the cash moves: settlement for a trade, the coupon date for income. */
	date: string;
	/** The valuation day it is booked on. */
	bookedOn: string;
	cusip: string;
	kind: TCashflowKind;
	/** Positive into the holder's hands, negative out of them. */
	amount: number;
	faceAmount: number;
};

export type TValuationDay = {
	date: string;
	/** Securities at the close, plus cash. */
	marketValue: number;
	cash: number;
	/** New money: purchases not met from cash, including accrued interest paid. */
	contributions: number;
	/** Money paid out to the holder: everything, under "distribute"; nothing otherwise. */
	distributions: number;
	/** Null when nothing was held going in and nothing was bought. */
	dailyReturn: number | null;
};

export type TLedgerProblem =
	| { kind: "unsupported_family"; cusip: string; family: TFamily }
	| {
			kind: "oversold";
			cusip: string;
			tradeDate: string;
			heldFace: number;
			soldFace: number;
	  }
	| { kind: "trade_after_maturity"; cusip: string; tradeDate: string }
	| { kind: "no_terms"; cusip: string }
	| { kind: "no_marks"; cusip: string };

export type TLedger = {
	days: TValuationDay[];
	cashflows: TCashflow[];
	/** Face held per CUSIP after the last day. Matured positions are gone. */
	holdings: Map<string, number>;
	/** Days a held security had no close and was marked at its previous one. */
	staleMarks: { cusip: string; date: string }[];
	/** Cash held after the last day. */
	cash: number;
	/** Coupons bought back into their security, as buys, under "reinvest". */
	reinvestments: TTrade[];
	income: TIncomePolicy;
};

/** The pricers a ledger runs on: those supplied, and the coupon formula for the rest. */
export const pricersFor = (
	terms: Map<string, TSecurityTerms>,
	supplied: Map<string, TPricer> = new Map(),
) => {
	const all = new Map<string, TPricer>();
	for (const [cusip, security] of terms)
		all.set(cusip, supplied.get(cusip) ?? nominalPricer(security));
	return all;
};

/** Trade cash per 100 of face: clean plus the accrued interest that changes hands. */
export const tradeDirtyPer100 = (pricer: TPricer, trade: TTrade) =>
	pricer.tradeDirty(trade.cleanPrice, trade.settleDate);

/**
 * Everything wrong with a set of trades, before any valuation. An empty list
 * is the precondition for buildLedger; the caller shows the rest.
 */
export const checkTrades = (
	trades: TTrade[],
	terms: Map<string, TSecurityTerms>,
	/** CUSIPs with a pricer supplied: a TIPS or FRN is valued only with one. */
	priced: Set<string> = new Set(),
): TLedgerProblem[] => {
	const problems: TLedgerProblem[] = [];
	const held = new Map<string, number>();
	const ordered = [...trades].sort(
		(a, b) =>
			a.tradeDate.localeCompare(b.tradeDate) ||
			(a.side === b.side ? 0 : a.side === "buy" ? -1 : 1),
	);
	for (const trade of ordered) {
		const security = terms.get(trade.cusip);
		if (security === undefined) {
			problems.push({ kind: "no_terms", cusip: trade.cusip });
			continue;
		}
		if (
			!SUPPORTED_FAMILIES.includes(security.family) &&
			!priced.has(trade.cusip)
		) {
			problems.push({
				kind: "unsupported_family",
				cusip: trade.cusip,
				family: security.family,
			});
			continue;
		}
		if (trade.settleDate >= security.maturityDate) {
			problems.push({
				kind: "trade_after_maturity",
				cusip: trade.cusip,
				tradeDate: trade.tradeDate,
			});
			continue;
		}
		const before = held.get(trade.cusip) ?? 0;
		if (trade.side === "sell" && trade.faceAmount > before + 1e-6) {
			problems.push({
				kind: "oversold",
				cusip: trade.cusip,
				tradeDate: trade.tradeDate,
				heldFace: before,
				soldFace: trade.faceAmount,
			});
		}
		held.set(
			trade.cusip,
			before + (trade.side === "buy" ? trade.faceAmount : -trade.faceAmount),
		);
	}
	return problems;
};

/**
 * Value the portfolio on every day in `calendar` from its first trade to
 * `asOf`. `calendar` is the market's priced days, oldest first; a trade on a
 * day that is not in it is booked on the next day that is.
 */
export const buildLedger = ({
	trades,
	terms,
	marks,
	calendar,
	asOf,
	income,
	cashRate = () => 0,
	pricers: supplied,
}: {
	trades: TTrade[];
	/** TIPS and FRN pricers, from their stored analytics. Nominals need none. */
	pricers?: Map<string, TPricer>;
	income: TIncomePolicy;
	/** Annual rate, decimal, that cash earns on a date. */
	cashRate?: (date: string) => number;
	terms: Map<string, TSecurityTerms>;
	/** Closes per CUSIP, oldest first. */
	marks: Map<string, TMark[]>;
	calendar: string[];
	asOf: string;
}): TLedger => {
	const firstTrade = trades.reduce<string | null>(
		(first, t) => (first === null || t.tradeDate < first ? t.tradeDate : first),
		null,
	);
	const days: TValuationDay[] = [];
	const cashflows: TCashflow[] = [];
	const staleMarks: { cusip: string; date: string }[] = [];
	const holdings = new Map<string, number>();
	const empty = {
		days,
		cashflows,
		holdings,
		staleMarks,
		cash: 0,
		reinvestments: [],
		income,
	};
	if (firstTrade === null) return empty;

	const valuationDays = calendar.filter((d) => d <= asOf);
	const firstDay = valuationDays.findIndex((d) => d >= firstTrade);
	if (firstDay === -1) return empty;

	// Trades booked on the first calendar day at or after their trade date.
	const bookedOn = new Map<string, TTrade[]>();
	for (const trade of trades) {
		const day = valuationDays.find((d) => d >= trade.tradeDate);
		if (day === undefined) continue;
		bookedOn.set(day, [...(bookedOn.get(day) ?? []), trade]);
	}

	// Marks as a per-CUSIP cursor, advanced as the days go by.
	const markIndex = new Map<string, number>();
	const lastClose = new Map<string, number>();
	const closeOn = (cusip: string, date: string) => {
		const series = marks.get(cusip) ?? [];
		let i = markIndex.get(cusip) ?? 0;
		while (i < series.length && series[i].date <= date) {
			lastClose.set(cusip, series[i].close);
			i += 1;
		}
		markIndex.set(cusip, i);
		const exact = i > 0 && series[i - 1].date === date;
		return { close: lastClose.get(cusip), isStale: !exact };
	};

	const pricers = pricersFor(terms, supplied);
	// Each security's coupon dates, once, from before the first trade.
	const coupons = new Map<string, string[]>();
	for (const [cusip, pricer] of pricers)
		coupons.set(cusip, pricer.couponDates(firstTrade));

	let previousValue = 0;
	let previousDate: string | null = null;
	let cash = 0;
	const reinvestments: TTrade[] = [];
	// Nothing is held going into the first day, so its window is never read.
	let previousSettlement = settlementFor(valuationDays[firstDay]);

	for (const date of valuationDays.slice(firstDay)) {
		const settlement = settlementFor(date);
		let distributions = 0;
		let contributions = 0;

		// 0. Interest on cash held overnight: actual/365 at the previous day's
		//    rate, the bill curve's bond-equivalent convention.
		if (cash > 1e-9 && previousDate !== null) {
			const interest =
				(cash *
					cashRate(previousDate) *
					daysBetween(toDate(previousDate), toDate(date))) /
				365;
			if (interest !== 0) {
				cash += interest;
				cashflows.push({
					date,
					bookedOn: date,
					cusip: CASH,
					kind: "interest",
					amount: interest,
					faceAmount: 0,
				});
			}
		}

		// 1. Income on the holdings carried in: coupons and redemptions whose
		//    date falls in (previous settlement, this settlement].
		const couponsToday: { cusip: string; amount: number }[] = [];
		let principal = 0;
		for (const [cusip, face] of holdings) {
			const security = terms.get(cusip);
			if (security === undefined || face <= 0) continue;
			const pricer = pricers.get(cusip) as TPricer;
			for (const couponDate of coupons.get(cusip) ?? []) {
				if (couponDate > settlement) break;
				if (couponDate > previousSettlement) {
					const amount = (face / 100) * pricer.coupon(couponDate);
					couponsToday.push({ cusip, amount });
					cashflows.push({
						date: couponDate,
						bookedOn: date,
						cusip,
						kind: "coupon",
						amount,
						faceAmount: face,
					});
				}
			}
			if (
				security.maturityDate > previousSettlement &&
				security.maturityDate <= settlement
			) {
				const repaid = (face / 100) * pricer.redemption();
				principal += repaid;
				cashflows.push({
					date: security.maturityDate,
					bookedOn: date,
					cusip,
					kind: "redemption",
					amount: repaid,
					faceAmount: face,
				});
				holdings.set(cusip, 0);
			}
		}

		// 2. The day's trades. Sales are proceeds; purchases are costs, met from
		//    cash first under the cash and reinvest policies.
		const todays = [...(bookedOn.get(date) ?? [])].sort((a, b) =>
			a.side === b.side ? 0 : a.side === "buy" ? -1 : 1,
		);
		let purchases = 0;
		for (const trade of todays) {
			const security = terms.get(trade.cusip);
			if (security === undefined) continue;
			const amount =
				(trade.faceAmount / 100) *
				tradeDirtyPer100(pricers.get(trade.cusip) as TPricer, trade);
			const face = holdings.get(trade.cusip) ?? 0;
			if (trade.side === "buy") {
				purchases += amount;
				holdings.set(trade.cusip, face + trade.faceAmount);
			} else {
				principal += amount;
				holdings.set(trade.cusip, face - trade.faceAmount);
			}
			cashflows.push({
				date: trade.settleDate,
				bookedOn: date,
				cusip: trade.cusip,
				kind: trade.side,
				amount: trade.side === "buy" ? -amount : amount,
				faceAmount: trade.faceAmount,
			});
		}

		// 3. Where the income goes.
		const couponCash = couponsToday.reduce((sum, c) => sum + c.amount, 0);
		if (income === "distribute") {
			distributions += couponCash + principal;
			contributions += purchases;
		} else {
			cash += principal;
			if (income === "cash") cash += couponCash;
			else {
				// Each coupon buys more of the security that paid it, at the
				// day's close, if it is still outstanding after settlement.
				for (const coupon of couponsToday) {
					const security = terms.get(coupon.cusip) as TSecurityTerms;
					const { close } = closeOn(coupon.cusip, date);
					if (close === undefined || security.maturityDate <= settlement) {
						cash += coupon.amount;
						continue;
					}
					const dirty = (pricers.get(coupon.cusip) as TPricer).dirty(close, date);
					const face = (coupon.amount / dirty) * 100;
					holdings.set(coupon.cusip, (holdings.get(coupon.cusip) ?? 0) + face);
					reinvestments.push({
						idTransaction: `reinvest:${coupon.cusip}:${date}`,
						cusip: coupon.cusip,
						side: "buy",
						tradeDate: date,
						settleDate: settlement,
						faceAmount: face,
						cleanPrice: close,
					});
					cashflows.push({
						date,
						bookedOn: date,
						cusip: coupon.cusip,
						kind: "reinvestment",
						amount: -coupon.amount,
						faceAmount: face,
					});
				}
			}
			const fromCash = Math.min(cash, purchases);
			cash -= fromCash;
			contributions += purchases - fromCash;
		}

		// 4. Mark what is held at the close.
		let marketValue = cash;
		for (const [cusip, face] of holdings) {
			if (face <= 1e-9) {
				holdings.delete(cusip);
				continue;
			}
			const security = terms.get(cusip);
			if (security === undefined) continue;
			const { close, isStale } = closeOn(cusip, date);
			// Bought today with no close on file yet: its own trade price.
			const trade = todays.find((t) => t.cusip === cusip && t.side === "buy");
			const mark = close ?? trade?.cleanPrice;
			if (mark === undefined) continue;
			if (isStale && close !== undefined) staleMarks.push({ cusip, date });
			marketValue +=
				(face / 100) * (pricers.get(cusip) as TPricer).dirty(mark, date);
		}

		const base = previousValue + contributions;
		days.push({
			date,
			marketValue,
			cash,
			contributions,
			distributions,
			dailyReturn:
				base > 1e-9 ? (marketValue + distributions - base) / base : null,
		});
		previousValue = marketValue;
		previousSettlement = settlement;
		previousDate = date;
	}

	return { days, cashflows, holdings, staleMarks, cash, reinvestments, income };
};
