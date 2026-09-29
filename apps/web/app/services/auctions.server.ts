import {
	readLatestPriceDate,
	readRunQueuesOn,
	readSecurityDetail,
	type TEnv,
} from "@markets/mcp-tools";
import type {
	TSecurityAuction,
	TSecurityKind,
} from "@saferate/treasury-client/types";

/**
 * Treasury auctions, from what the treasury service already exposes: the
 * auction-basis on-the-run queues name each term's recent securities, and
 * each security's record carries every auction of it (reopenings included).
 *
 * WHAT THIS CANNOT SEE, said on the page. There is no "auctions between two
 * dates" read upstream, so an auction appears once its security is in a
 * queue: a NEW security's announced auction is invisible until the day it is
 * held (a reopening of a security already held shows as soon as it is
 * announced). The queues carry only the 17-, 26- and 52-week bills, but the
 * shorter bills are nearly all offered as REOPENINGS of those, so a 4-week
 * auction arrives in the record of the 17-week bill it reopens. A short bill
 * that is not one is missed. Both gaps want a dated auctions read in
 * treasury-api, which is frozen with production (2026-09-29).
 *
 * BILLS GROUP BY THE TERM OFFERED, everything else by original term. Found on
 * first render: grouping bills by their queue put a 4-week auction in the
 * "17-Week" row and compared it with 17-week auctions. A reopened 10-year is
 * still a 10-year auction ("9-Year 11-Month" as offered), so coupons group by
 * the original.
 */

/**
 * How many securities of each queue to read. Every tracked bill (upstream
 * ranks 0 to 10): each is reopened as several shorter terms, and those terms
 * need their own history. Six of each coupon queue gives six new issues and
 * their reopenings.
 */
const depthOf = (kind: TSecurityKind) => (kind === "Bill" ? 11 : 6);

/** The group an auction belongs to: bills by the term offered, the rest by original term. */
export const groupOf = (auction: {
	kind: TSecurityKind;
	term: string;
	securityTerm: string | null;
}) =>
	auction.kind === "Bill"
		? `Bill ${auction.securityTerm ?? auction.term}`
		: `${auction.kind} ${auction.term}`;

const weeksOf = (key: string) => Number(key.match(/(\d+)-Week/)?.[1] ?? 999);

export type TAuction = TSecurityAuction & {
	cusip: string;
	kind: TSecurityKind;
	/** The queue it belongs to (the original term), for grouping. */
	term: string;
	couponPercent: number | null;
	maturityDate: string;
	spreadPercent: number | null;
};

/** Per isolate, keyed by the run date: auctions only change when a new day lands. */
const detailCache = new Map<
	string,
	{ on: string; detail: Awaited<ReturnType<typeof readSecurityDetail>> }
>();

const cachedDetail = async (env: TEnv, cusip: string, on: string) => {
	const hit = detailCache.get(cusip);
	if (hit !== undefined && hit.on === on) return hit.detail;
	const detail = await readSecurityDetail(env, cusip);
	detailCache.set(cusip, { on, detail });
	if (detailCache.size > 400) {
		const oldest = detailCache.keys().next().value;
		if (oldest !== undefined) detailCache.delete(oldest);
	}
	return detail;
};

/** The rate an auction clears on, by family, in percent, with its name. */
export const clearingRate = (auction: TAuction) => {
	if (auction.kind === "Bill")
		return {
			label: "discount rate",
			value: auction.highDiscountRate,
			median: auction.medianDiscountRate,
		};
	if (auction.kind === "FRN")
		return {
			label: "discount margin",
			value: auction.highDiscountMargin,
			median: null,
		};
	return {
		label: auction.kind === "TIPS" ? "real yield" : "yield",
		value: auction.highYield,
		median: auction.medianYield,
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
	// The run record follows the prices; the newest price day can lack it, as
	// the /v1/on-the-run route allows for.
	let on = await readLatestPriceDate(env);
	let queues = await readRunQueuesOn(env, { date: on, basis: "auction" });
	for (let step = 1; queues.length === 0 && step < 7; step += 1) {
		on = new Date(Date.parse(`${on}T00:00:00Z`) - 86_400_000)
			.toISOString()
			.slice(0, 10);
		queues = await readRunQueuesOn(env, { date: on, basis: "auction" });
	}

	const wanted = queues.flatMap((members) =>
		members.slice(0, depthOf(members[0].securityKind)).map((member) => ({
			cusip: member.cusip,
			kind: member.securityKind,
			term: member.originalSecurityTerm,
		})),
	);
	const details = await Promise.all(
		wanted.map(async (w) => ({
			...w,
			detail: await cachedDetail(env, w.cusip, on),
		})),
	);

	const seen = new Set<string>();
	const auctions: TAuction[] = [];
	for (const { cusip, kind, term, detail } of details) {
		if (detail === null) continue;
		for (const auction of detail.auctions) {
			const key = `${cusip}|${auction.auctionDate}`;
			if (seen.has(key)) continue;
			seen.add(key);
			auctions.push({
				...auction,
				cusip,
				kind,
				term,
				couponPercent: detail.couponPercent ?? null,
				maturityDate: detail.maturityDate,
				spreadPercent: detail.spread ?? null,
			});
		}
	}
	auctions.sort((a, b) => b.auctionDate.localeCompare(a.auctionDate));

	// Bills: every term offered, shortest first. The rest: the queues, in order.
	const billKeys = [
		...new Set(auctions.filter((a) => a.kind === "Bill").map(groupOf)),
	].sort((a, b) => weeksOf(a) - weeksOf(b));
	const terms = [
		...billKeys.map((key) => ({
			kind: "Bill" as TSecurityKind,
			term: key.slice("Bill ".length),
			key,
		})),
		...queues
			.filter((members) => members[0].securityKind !== "Bill")
			.map((members) => ({
				kind: members[0].securityKind,
				term: members[0].originalSecurityTerm,
				key: `${members[0].securityKind} ${members[0].originalSecurityTerm}`,
			})),
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
		const priorCover = mean(
			prior.map((a) => a.bidToCoverRatio).filter((x): x is number => x !== null),
		);
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
				comparedWith: prior.length,
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
