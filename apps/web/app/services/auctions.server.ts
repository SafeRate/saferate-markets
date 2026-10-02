import {
	readAuctionsBetween,
	readLatestPriceDate,
	type TEnv,
	TreasuryAbsent,
} from "@markets/mcp-tools";
import type {
	TSecurityAuction,
	TSecurityKind,
} from "@saferate/treasury-client/types";

/**
 * Treasury auctions, from treasury-api's `auctionsBetween` (one dated read of
 * security_auctions, deployed 2026-10-02): 400 days back for the history and
 * the averages, 60 ahead for what is announced. It replaced a fan-out over the
 * on-the-run queues that could not see a NEW issue until its auction day and
 * held only three prior 4-week auctions where six exist.
 *
 * NEW ISSUES ARE KEPT. The read left-joins security_details, so a security not
 * yet issued comes back with maturity and coupon null (a new note's coupon is
 * not set until its auction clears); the page describes it by its offered term.
 *
 * BILLS GROUP BY THE TERM OFFERED, everything else by original term. Found on
 * first render: grouping bills by their queue put a 4-week auction in the
 * "17-Week" row and compared it with 17-week auctions. A reopened 10-year is
 * still a 10-year auction ("9-Year 11-Month" as offered), so coupons group by
 * the original.
 */

/** The group an auction belongs to: bills by the term offered, the rest by original term. */
export const groupOf = (auction: {
	kind: TSecurityKind | null;
	term: string;
	securityTerm: string | null;
}) =>
	auction.kind === "Bill"
		? `Bill ${auction.securityTerm ?? auction.term}`
		: `${auction.kind ?? "Other"} ${auction.term}`;

const weeksOf = (key: string) => Number(key.match(/(\d+)-Week/)?.[1] ?? 999);

export type TAuction = TSecurityAuction & {
	cusip: string;
	/** Derived upstream from the auction; null only when it cannot be told. */
	kind: TSecurityKind | null;
	/** The original term, for grouping coupons ("10-Year" for a reopening too). */
	term: string;
	/** Null for a new issue not yet in security_details (coupon not yet set). */
	couponPercent: number | null;
	maturityDate: string | null;
	spreadPercent: number | null;
};

/** How far back the history reaches, and forward the announcements. Six
 *  priors of a monthly 52-week bill span most of a year, hence 400 days
 *  (the same window saferate.com uses). */
const BACK_DAYS = 400;
const AHEAD_DAYS = 60;

/** Per isolate, keyed by the price date: auctions only change when a day lands. */
let windowCache: { on: string; rows: TAuction[] } | null = null;

const shiftDays = (iso: string, days: number) =>
	new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000)
		.toISOString()
		.slice(0, 10);

const KIND_ORDER: TSecurityKind[] = ["Bill", "Note", "Bond", "TIPS", "FRN"];
const yearsOf = (term: string) => Number(term.match(/(\d+)-Year/)?.[1] ?? 999);

/**
 * The rate an auction clears on, by family, in percent, with its name.
 *
 * Bills lead with the DISCOUNT rate, with the investment rate beside it
 * (agreed with saferate.com, 2026-10-02, so both sites quote the same figure
 * first): the discount rate is what Treasury's results lead with and the only
 * bill rate with a published median, so high-less-median is computed on it;
 * the investment rate is coupon-equivalent, the one comparable with a note's
 * yield. `investment` is null for every other family.
 */
export const clearingRate = (auction: TAuction) => {
	if (auction.kind === "Bill")
		return {
			label: "discount",
			value: auction.highDiscountRate,
			median: auction.medianDiscountRate,
			investment: auction.highInvestmentRate,
		};
	if (auction.kind === "FRN")
		return {
			label: "discount margin",
			value: auction.highDiscountMargin,
			median: null,
			investment: null,
		};
	return {
		label: auction.kind === "TIPS" ? "real yield" : "yield",
		value: auction.highYield,
		median: auction.medianYield,
		investment: null,
	};
};

/**
 * Shares of the COMPETITIVE award (dealers + direct + indirect), the base
 * auction commentary uses: SOMA and non-competitive bids are not bidding on
 * price. Null when the auction has not reported them.
 */
export const bidderShares = (auction: TAuction) => {
	const dealers = auction.primaryDealerAccepted;
	const direct = auction.directBidderAccepted;
	const indirect = auction.indirectBidderAccepted;
	if (dealers === null || direct === null || indirect === null) return null;
	const competitive = dealers + direct + indirect;
	if (!(competitive > 0)) return null;
	return {
		dealers: dealers / competitive,
		direct: direct / competitive,
		indirect: indirect / competitive,
	};
};

const mean = (xs: number[]) =>
	xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

export const loadAuctions = async (env: TEnv) => {
	const on = await readLatestPriceDate(env);
	let auctions: TAuction[];
	if (windowCache !== null && windowCache.on === on) auctions = windowCache.rows;
	else {
		try {
			const rows = await readAuctionsBetween(env, {
				from: shiftDays(on, -BACK_DAYS),
				to: shiftDays(on, AHEAD_DAYS),
			});
			auctions = rows.map((row) => ({
				...row,
				term: row.originalSecurityTerm,
				spreadPercent: null,
			}));
		} catch (error) {
			// A treasury-api without the method is a deploy gap, not "no auctions":
			// say so on the page rather than render an empty schedule.
			if (error instanceof TreasuryAbsent) return null;
			throw error;
		}
		auctions.sort(
			(a, b) =>
				b.auctionDate.localeCompare(a.auctionDate) ||
				a.cusip.localeCompare(b.cusip),
		);
		windowCache = { on, rows: auctions };
	}

	// Bills: every term offered, shortest first. The rest: by kind, then length,
	// from the auctions themselves (the queues no longer feed this page).
	const billKeys = [
		...new Set(auctions.filter((a) => a.kind === "Bill").map(groupOf)),
	].sort((a, b) => weeksOf(a) - weeksOf(b));
	const couponTerms = [
		...new Map(
			auctions
				.filter((a) => a.kind !== "Bill")
				.map((a) => [groupOf(a), { kind: a.kind, term: a.term }] as const),
		),
	]
		.map(([key, t]) => ({ key, ...t }))
		.sort(
			(a, b) =>
				(a.kind === null ? 99 : KIND_ORDER.indexOf(a.kind)) -
					(b.kind === null ? 99 : KIND_ORDER.indexOf(b.kind)) ||
				yearsOf(a.term) - yearsOf(b.term),
		);
	const terms = [
		...billKeys.map((key) => ({
			kind: "Bill" as TSecurityKind | null,
			term: key.slice("Bill ".length),
			key,
		})),
		...couponTerms,
	];
	const ofTerm = (key: string) => auctions.filter((a) => groupOf(a) === key);

	const held = (a: TAuction) => a.auctionDate <= on;
	const latestByTerm = terms.flatMap(({ key, kind, term }) => {
		const history = ofTerm(key).filter(held);
		const latest = history[0];
		if (latest === undefined) return [];
		const prior = history.slice(1, 7);
		const shares = bidderShares(latest);
		const priorShares = prior
			.map(bidderShares)
			.filter((s): s is NonNullable<typeof s> => s !== null);
		const cover = latest.bidToCoverRatio;
		const priorCovers = prior
			.map((a) => a.bidToCoverRatio)
			.filter((x): x is number => x !== null);
		const priorCover = mean(priorCovers);
		const priorDealers = mean(priorShares.map((s) => s.dealers));
		const rate = clearingRate(latest);
		return [
			{
				key,
				kind,
				term,
				auction: latest,
				rate,
				shares,
				// How many prior auctions each change actually averaged: up to six,
				// fewer when the fan-out holds fewer of that term (a 4-week bill's
				// history is only as deep as the 17-week bills it reopens). Shown
				// beside each change, since "vs six" over three is a false label.
				comparedWith: prior.length,
				coverComparedWith: priorCovers.length,
				dealersComparedWith: priorShares.length,
				coverVsPrior:
					cover === null || priorCover === null ? null : cover - priorCover,
				dealersVsPrior:
					shares === null || priorDealers === null
						? null
						: shares.dealers - priorDealers,
				// High less median, in basis points: how far the stop sat above the
				// middle of the accepted bids. Not the tail (that is against the
				// when-issued yield, which Safe Rate does not hold).
				highLessMedianBp:
					rate.value === null || rate.median === null
						? null
						: (rate.value - rate.median) * 100,
			},
		];
	});

	return {
		on,
		terms,
		auctions,
		latestByTerm,
		announced: auctions
			.filter((a) => a.auctionDate > on)
			.sort((a, b) => a.auctionDate.localeCompare(b.auctionDate)),
		settling: auctions
			.filter((a) => a.auctionDate <= on && a.issueDate > on)
			.sort((a, b) => a.issueDate.localeCompare(b.issueDate)),
		historyOf: (key: string) => ofTerm(key).filter(held).slice(0, 16),
	};
};
