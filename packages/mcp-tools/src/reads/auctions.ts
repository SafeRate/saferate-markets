import {
	type TSecurityAuction,
	type TSecurityKind,
	ZSecurityAuction,
} from "@saferate/treasury-client/types";
import { z } from "zod";
import { readLatestPriceDate } from "./securities";
import { call, type TEnv, TreasuryAbsent } from "./treasury";

/**
 * Treasury auctions for every surface: the dashboard's Auctions page,
 * GET /v1/auctions and /v1/auctions/latest, and the get_treasury_auctions MCP
 * tool. One reader and one analysis, so the three cannot quote different
 * figures for the same auction (and saferate.com, which follows the same rules,
 * matches them: checked on 912797VP9, 2026-10-02).
 *
 * The source is treasury-api's `auctionsBetween` (deployed 2026-10-02), one
 * dated read of security_auctions LEFT JOINED to security_details.
 *
 * NEW ISSUES ARE KEPT. A security not yet issued comes back with maturity and
 * coupon null (a new note's coupon is set at its auction); describe it by its
 * offered term, never drop it.
 *
 * BILLS GROUP BY THE TERM OFFERED, everything else by original term: a 4-week
 * reopening of a 17-week bill is a 4-week auction, and a reopened 10-year is
 * still a 10-year auction ("9-Year 11-Month" as offered).
 */

/** One `auctionsBetween` row: the auction, its CUSIP, and what details exist. */
const ZAuctionInWindow = z
	.object({
		cusip: z.string().min(1),
		kind: z.enum(["Bill", "Bond", "FRN", "Note", "TIPS"]).nullable(),
		maturity_date: z.string().nullable().default(null),
		interest_rate: z.number().nullable().default(null),
	})
	.passthrough();

export type TAuction = TSecurityAuction & {
	cusip: string;
	/** Derived upstream from the auction; null only when it cannot be told. */
	kind: TSecurityKind | null;
	/** The original term, for grouping coupons ("10-Year" for a reopening too). */
	term: string;
	/** Percent. Null for a new issue not yet in security_details. */
	couponPercent: number | null;
	maturityDate: string | null;
};

/**
 * Every auction with an auction date in [from, to], NEWEST first.
 * `interest_rate` upstream is a PERCENT, as on the detail row. Throws
 * TreasuryAbsent when the deployment lacks the method (see treasury.ts: an RPC
 * stub only shows that on the call).
 */
export const readAuctionsBetween = async (
	env: TEnv,
	input: { from: string; to: string },
): Promise<TAuction[]> => {
	const rows = z
		.array(z.unknown())
		.parse((await call(env, "auctionsBetween")(input)) ?? []);
	return rows
		.map((raw) => {
			const extra = ZAuctionInWindow.parse(raw);
			const auction = ZSecurityAuction.parse(raw);
			return {
				...auction,
				cusip: extra.cusip,
				kind: extra.kind,
				term: auction.originalSecurityTerm,
				maturityDate: extra.maturity_date,
				couponPercent: extra.interest_rate,
			};
		})
		.sort(
			(a, b) =>
				b.auctionDate.localeCompare(a.auctionDate) ||
				a.cusip.localeCompare(b.cusip),
		);
};

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
const yearsOf = (term: string) => Number(term.match(/(\d+)-Year/)?.[1] ?? 999);
const KIND_ORDER: TSecurityKind[] = ["Bill", "Note", "Bond", "TIPS", "FRN"];

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
			label: "discount" as const,
			value: auction.highDiscountRate,
			median: auction.medianDiscountRate,
			investment: auction.highInvestmentRate,
		};
	if (auction.kind === "FRN")
		return {
			label: "discount margin" as const,
			value: auction.highDiscountMargin,
			median: null,
			investment: null,
		};
	return {
		label: auction.kind === "TIPS" ? ("real yield" as const) : ("yield" as const),
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

/** How many prior auctions a change averages, at most. */
export const AUCTION_PRIORS = 6;

/**
 * Everything the surfaces show, from auctions NEWEST first and the day `on`
 * (the newest price date: held means auction date on or before it). Pure.
 *
 * Changes are against the mean of up to six prior auctions of the same group,
 * each counted separately (`coverComparedWith`, `dealersComparedWith`): an
 * auction missing a figure is skipped, so "6 prior" is only said when six were
 * averaged.
 */
export const analyseAuctions = (auctions: TAuction[], on: string) => {
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
	const held = (a: TAuction) => a.auctionDate <= on;
	const ofTerm = (key: string) =>
		auctions.filter((a) => groupOf(a) === key && held(a));

	const latestByTerm = terms.flatMap(({ key, kind, term }) => {
		const history = ofTerm(key);
		const latest = history[0];
		if (latest === undefined) return [];
		const prior = history.slice(1, 1 + AUCTION_PRIORS);
		const shares = bidderShares(latest);
		const priorShares = prior
			.map(bidderShares)
			.filter((s): s is NonNullable<typeof s> => s !== null);
		const priorCovers = prior
			.map((a) => a.bidToCoverRatio)
			.filter((x): x is number => x !== null);
		const priorCover = mean(priorCovers);
		const priorDealers = mean(priorShares.map((s) => s.dealers));
		const cover = latest.bidToCoverRatio;
		const rate = clearingRate(latest);
		return [
			{
				key,
				kind,
				term,
				auction: latest,
				rate,
				shares,
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
		latestByTerm,
		announced: auctions
			.filter((a) => a.auctionDate > on)
			.sort((a, b) => a.auctionDate.localeCompare(b.auctionDate)),
		settling: auctions
			.filter((a) => a.auctionDate <= on && a.issueDate > on)
			.sort((a, b) => a.issueDate.localeCompare(b.issueDate)),
		historyOf: (key: string) => ofTerm(key),
	};
};

/** How far back the history reaches (six priors of a monthly 52-week bill span
 *  most of a year; saferate.com uses the same), and forward the announcements. */
export const AUCTION_BACK_DAYS = 400;
export const AUCTION_AHEAD_DAYS = 60;

export const shiftDays = (iso: string, days: number) =>
	new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000)
		.toISOString()
		.slice(0, 10);

/** Per isolate, keyed by the price date: auctions only change when a day lands. */
let windowCache: { on: string; rows: TAuction[] } | null = null;

/**
 * DEMAND: how strong each term's latest auction was, from treasury's
 * `auctionDemand` (2026-10-09), the ONE producer of it. saferate.com's
 * /treasury/auctions computes the same thing and is to read it too; this
 * module never recomputes it, so the two sites cannot disagree on a rank.
 *
 * Four measures ranked as percentiles against the same term's trailing
 * `windowMonths` (24), the auction itself excluded: bid-to-cover, indirect
 * share, dealer takedown and high-less-median. Treasury flips the last two
 * before publishing, so 100 is strong demand on every row; do not re-invert.
 * The verdict counts measures in the top and bottom thirds, it does not
 * average. A term with fewer than eight priors has no row. Not a "tail":
 * that needs when-issued yields, which no one here holds.
 *
 * Optional: a treasury deployment without the method, or a failed read,
 * leaves every row's `demand` null and the pages say nothing about strength.
 */
const ZDemandRow = z.object({
	auction: z
		.object({ cusip: z.string(), auctionDate: z.string() })
		.passthrough(),
	measures: z.array(
		z.object({
			key: z.string(),
			label: z.string(),
			percentile: z.number().nullable(),
			sampleSize: z.number(),
			value: z.number().nullable(),
		}),
	),
	sampleSize: z.number(),
	termLabel: z.string(),
	verdict: z.enum(["strong", "average", "weak"]).nullable(),
	windowMonths: z.number(),
});
export type TAuctionDemand = Omit<z.infer<typeof ZDemandRow>, "auction">;

const demandKey = (cusip: string, auctionDate: string) =>
	`${cusip}|${auctionDate.slice(0, 10)}`;

/** Demand by `cusip|auctionDate`, or an empty map when it cannot be read. */
export const readAuctionDemand = async (
	env: TEnv,
	on: string,
): Promise<Map<string, TAuctionDemand>> => {
	try {
		const rows = z
			.array(ZDemandRow)
			.parse(await call(env, "auctionDemand")({ on }));
		return new Map(
			rows.map(({ auction, ...demand }) => [
				demandKey(auction.cusip, auction.auctionDate),
				demand,
			]),
		);
	} catch (error) {
		if (!(error instanceof TreasuryAbsent))
			console.error("[auctions] demand unavailable:", error);
		return new Map();
	}
};

let demandCache: { on: string; byAuction: Map<string, TAuctionDemand> } | null =
	null;

/**
 * The full window around the newest price day, analysed: what the Auctions page
 * and /v1/auctions/latest serve. Null when treasury-api lacks auctionsBetween,
 * which the caller must say rather than show an empty schedule.
 */
export const loadAuctionWindow = async (env: TEnv) => {
	const on = await readLatestPriceDate(env);
	if (windowCache === null || windowCache.on !== on) {
		try {
			windowCache = {
				on,
				rows: await readAuctionsBetween(env, {
					from: shiftDays(on, -AUCTION_BACK_DAYS),
					to: shiftDays(on, AUCTION_AHEAD_DAYS),
				}),
			};
		} catch (error) {
			if (error instanceof TreasuryAbsent) return null;
			throw error;
		}
	}
	if (demandCache === null || demandCache.on !== on)
		demandCache = { on, byAuction: await readAuctionDemand(env, on) };
	const analysed = analyseAuctions(windowCache.rows, on);
	const byAuction = demandCache.byAuction;
	return {
		auctions: windowCache.rows,
		...analysed,
		latestByTerm: analysed.latestByTerm.map((row) => ({
			...row,
			demand:
				byAuction.get(demandKey(row.auction.cusip, row.auction.auctionDate)) ??
				null,
		})),
	};
};

/** Forget the cached window: for tests, which swap the fake service per case. */
export const resetAuctionWindowCache = () => {
	windowCache = null;
	demandCache = null;
};

// ── The published shape (REST and MCP) ─────────────────────────────────────────

const round = (value: number | null, digits: number) =>
	value === null ? null : Number(value.toFixed(digits));

/**
 * One auction as REST and MCP publish it, snake_case. `status` is against `on`
 * (the newest price date): announced (not yet held), auctioned (held, not yet
 * issued) or settled. Rates are percent; amounts are dollars; bidder shares
 * are percent of the competitive award.
 */
export const publishAuction = (auction: TAuction, on: string) => {
	const rate = clearingRate(auction);
	const shares = bidderShares(auction);
	return {
		cusip: auction.cusip,
		kind: auction.kind,
		term:
			auction.kind === "Bill"
				? (auction.securityTerm ?? auction.term)
				: auction.term,
		original_security_term: auction.originalSecurityTerm,
		security_term: auction.securityTerm,
		is_reopening: auction.isReopening,
		status:
			auction.auctionDate > on
				? ("announced" as const)
				: auction.issueDate > on
					? ("auctioned" as const)
					: ("settled" as const),
		auction_date: auction.auctionDate,
		issue_date: auction.issueDate,
		maturity_date: auction.maturityDate,
		coupon_percent: auction.couponPercent,
		offering_amount: auction.offeringAmount,
		total_tendered: auction.totalTendered,
		total_accepted: auction.totalAccepted,
		bid_to_cover_ratio: auction.bidToCoverRatio,
		clearing_rate: {
			measure: rate.label,
			high_percent: rate.value,
			median_percent: rate.median,
			investment_rate_percent: rate.investment,
		},
		high_less_median_basis_points:
			rate.value === null || rate.median === null
				? null
				: round((rate.value - rate.median) * 100, 4),
		bidders:
			shares === null
				? null
				: {
						primary_dealer_percent: round(shares.dealers * 100, 4),
						direct_percent: round(shares.direct * 100, 4),
						indirect_percent: round(shares.indirect * 100, 4),
					},
		soma_accepted: auction.somaAccepted,
		allocation_percent: auction.allocationPercentage,
	};
};

export type TPublishedAuction = ReturnType<typeof publishAuction>;

/** One term's latest held auction with its changes, as REST and MCP publish it. */
export const publishLatestByTerm = (
	row: ReturnType<typeof analyseAuctions>["latestByTerm"][number] & {
		demand?: TAuctionDemand | null;
	},
	on: string,
) => ({
	group: row.key,
	kind: row.kind,
	term: row.term,
	auction: publishAuction(row.auction, on),
	bid_to_cover_change: round(row.coverVsPrior, 4),
	bid_to_cover_compared_with: row.coverComparedWith,
	primary_dealer_change_points:
		row.dealersVsPrior === null ? null : round(row.dealersVsPrior * 100, 4),
	primary_dealer_compared_with: row.dealersComparedWith,
	demand:
		row.demand === undefined || row.demand === null
			? null
			: {
					verdict: row.demand.verdict,
					sample_size: row.demand.sampleSize,
					window_months: row.demand.windowMonths,
					measures: row.demand.measures.map((m) => ({
						key: m.key,
						label: m.label,
						percentile: m.percentile,
						value: m.value,
						sample_size: m.sampleSize,
					})),
				},
});
