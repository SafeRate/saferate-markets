import { accruedPer100, couponDates, settlementFor } from "./dates";

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

export type TCashflowKind = "buy" | "sell" | "coupon" | "redemption";

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
	marketValue: number;
	/** Cost of the day's purchases, including accrued interest paid. */
	contributions: number;
	/** Sale proceeds, coupons and redemptions credited that day. */
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
};

const dirtyPer100 = (terms: TSecurityTerms, close: number, markDate: string) =>
	close +
	accruedPer100({
		couponRate: terms.couponRate,
		maturityDate: terms.maturityDate,
		settlementDate: settlementFor(markDate),
		frequency: terms.frequency,
	});

/** Trade cash per 100 of face: clean plus the accrued interest that changes hands. */
export const tradeDirtyPer100 = (terms: TSecurityTerms, trade: TTrade) =>
	trade.cleanPrice +
	accruedPer100({
		couponRate: terms.couponRate,
		maturityDate: terms.maturityDate,
		settlementDate: trade.settleDate,
		frequency: terms.frequency,
	});

/**
 * Everything wrong with a set of trades, before any valuation. An empty list
 * is the precondition for buildLedger; the caller shows the rest.
 */
export const checkTrades = (
	trades: TTrade[],
	terms: Map<string, TSecurityTerms>,
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
		if (!SUPPORTED_FAMILIES.includes(security.family)) {
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
}: {
	trades: TTrade[];
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
	if (firstTrade === null) return { days, cashflows, holdings, staleMarks };

	const valuationDays = calendar.filter((d) => d <= asOf);
	const firstDay = valuationDays.findIndex((d) => d >= firstTrade);
	if (firstDay === -1) return { days, cashflows, holdings, staleMarks };

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

	// Each security's coupon dates, once, from before the first trade.
	const coupons = new Map<string, string[]>();
	for (const [cusip, security] of terms) {
		coupons.set(
			cusip,
			security.couponRate > 0
				? couponDates({
						maturityDate: security.maturityDate,
						from: firstTrade,
						frequency: security.frequency,
					})
				: [],
		);
	}

	let previousValue = 0;
	// Nothing is held going into the first day, so its window is never read.
	let previousSettlement = settlementFor(valuationDays[firstDay]);

	for (const date of valuationDays.slice(firstDay)) {
		const settlement = settlementFor(date);
		let distributions = 0;
		let contributions = 0;

		// 1. Income on the holdings carried in: coupons and redemptions whose
		//    date falls in (previous settlement, this settlement].
		for (const [cusip, face] of holdings) {
			const security = terms.get(cusip);
			if (security === undefined || face <= 0) continue;
			if (security.couponRate > 0) {
				for (const couponDate of coupons.get(cusip) ?? []) {
					if (couponDate > settlement) break;
					if (couponDate > previousSettlement) {
						const amount =
							(face / 100) * ((security.couponRate * 100) / security.frequency);
						distributions += amount;
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
			}
			if (
				security.maturityDate > previousSettlement &&
				security.maturityDate <= settlement
			) {
				distributions += face;
				cashflows.push({
					date: security.maturityDate,
					bookedOn: date,
					cusip,
					kind: "redemption",
					amount: face,
					faceAmount: face,
				});
				holdings.set(cusip, 0);
			}
		}

		// 2. The day's trades: buys first, so a same-day round trip nets.
		const todays = [...(bookedOn.get(date) ?? [])].sort((a, b) =>
			a.side === b.side ? 0 : a.side === "buy" ? -1 : 1,
		);
		for (const trade of todays) {
			const security = terms.get(trade.cusip);
			if (security === undefined) continue;
			const cash = (trade.faceAmount / 100) * tradeDirtyPer100(security, trade);
			const face = holdings.get(trade.cusip) ?? 0;
			if (trade.side === "buy") {
				contributions += cash;
				holdings.set(trade.cusip, face + trade.faceAmount);
				cashflows.push({
					date: trade.settleDate,
					bookedOn: date,
					cusip: trade.cusip,
					kind: "buy",
					amount: -cash,
					faceAmount: trade.faceAmount,
				});
			} else {
				distributions += cash;
				holdings.set(trade.cusip, face - trade.faceAmount);
				cashflows.push({
					date: trade.settleDate,
					bookedOn: date,
					cusip: trade.cusip,
					kind: "sell",
					amount: cash,
					faceAmount: trade.faceAmount,
				});
			}
		}

		// 3. Mark what is held at the close.
		let marketValue = 0;
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
			marketValue += (face / 100) * dirtyPer100(security, mark, date);
		}

		const base = previousValue + contributions;
		days.push({
			date,
			marketValue,
			contributions,
			distributions,
			dailyReturn:
				base > 1e-9 ? (marketValue + distributions - base) / base : null,
		});
		previousValue = marketValue;
		previousSettlement = settlement;
	}

	return { days, cashflows, holdings, staleMarks };
};
