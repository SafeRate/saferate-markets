import {
	securityFamilyFromPriceType,
	type TSecurityFamily,
	ZSecurityAnalytics,
	ZTipsAnalytics,
} from "@saferate/treasury-client/types";
import { z } from "zod";
import { readLatestPriceDate, readPricesOn } from "./securities";
import { call, type TEnv } from "./treasury";

/**
 * Rich/cheap: every security's distance from the fitted curve on one day,
 * ranked by how unusual that distance is for the security.
 *
 * Built the way the treasury-integration session specified (2026-09-28): the
 * day's analytics (`analyticsOn` / `tipsAnalyticsOn`) joined to the day's
 * prices (`pricesOn`) for the terms, ranked on the z-score and not the size of
 * the residual. Upstream's `dislocationsOn` ranks the same way but returns only
 * the top N nominal rows with no terms, so a caller could not filter by
 * maturity without the whole day anyway.
 *
 * The conventions, each a way to misread the numbers:
 *  - residual_basis_points is YIELD minus curve: positive means cheap (the
 *    security yields more than the curve says it should).
 *    price_residual_cents is PRICE minus model: positive means rich. Opposite
 *    signs for the same fact, so each row also says it in words: vsCurve.
 *  - vsCurve and vsHistory are different questions and can disagree: a bond
 *    that always trades rich can be rich today and still cheaper than usual.
 *  - residual_z_score is that residual against the security's own history.
 *    Positive: cheaper than it usually is; negative: richer.
 *  - A null z-score is NOT zero. Bills are never scored, a security inside its
 *    first twenty observations is not yet, and upstream withholds the residual
 *    and the z inside a month of maturity, where annualising stops meaning
 *    anything. Unscored securities are counted and returned separately, never
 *    ranked as "ordinary".
 */

export type TRichCheapBasis = "nominal" | "tips";
export type TRichCheapSide = "rich" | "cheap";

export type TRichCheapRow = {
	cusip: string;
	family: TSecurityFamily | null;
	couponPercent: number;
	maturityDate: string;
	yearsToMaturity: number;
	price: number;
	yieldPercent: number | null;
	residualBasisPoints: number | null;
	priceResidualCents: number;
	zScore: number | null;
	/** Today, against the fitted curve: the sign of residualBasisPoints. */
	vsCurve: TRichCheapSide | null;
	/** Against its own history: the sign of zScore. */
	vsHistory: "richer" | "cheaper" | null;
};

/** Upstream rows carry the CUSIP beside fields the client's schema drops. */
const ZCusip = z.object({ cusip: z.string().min(1) }).passthrough();

const yearsBetween = (from: string, to: string) =>
	(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
	(365.25 * 86_400_000);

/** One basis's analytics for a day, with the CUSIP kept. Empty when none. */
const readAnalyticsOn = async (
	env: TEnv,
	basis: TRichCheapBasis,
	date: string,
) => {
	if (basis === "tips") {
		const rows = await call(env, "tipsAnalyticsOn")({ date });
		return z
			.array(ZTipsAnalytics)
			.parse(rows ?? [])
			.map((row) => ({
				cusip: row.cusip,
				yieldPercent: row.realYield,
				residualBasisPoints: row.residualBasisPoints,
				priceResidualCents: row.priceResidualCents,
				zScore: row.residualZScore,
			}));
	}
	const rows = z
		.array(ZCusip)
		.parse((await call(env, "analyticsOn")(date)) ?? []);
	return rows.map((raw) => {
		const row = ZSecurityAnalytics.parse(raw);
		return {
			cusip: raw.cusip,
			yieldPercent: row.ytm,
			residualBasisPoints: row.residualBasisPoints,
			priceResidualCents: row.priceResidualCents,
			zScore: row.residualZScore,
		};
	});
};

/**
 * The default years-to-maturity floor. Measured on 2026-09-25 (344 scored
 * notes and bonds): median |z| was 3.04 under three months, 1.81 at three to
 * six, 1.02 at six to twelve, and the whole top of the list sat inside four
 * months of maturity, at residuals of 20bp from price errors of 2 to 3 cents.
 * The nominal curve's fitted domain starts at one year, so those residuals are
 * against an extrapolation, annualised over a vanishing horizon. Below one
 * year a caller asks for them explicitly.
 */
export const RICH_CHEAP_MIN_YEARS = 1;

/** How far back an omitted date looks for a day with analytics. */
export const RICH_CHEAP_LOOKBACK_DAYS = 7;

const dayBefore = (date: string) =>
	new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000)
		.toISOString()
		.slice(0, 10);

/**
 * The day's rows, or null when the day has none.
 *
 * With no date, starts from the latest price date and steps back a day at a
 * time: analytics are computed after prices, so the newest price day can
 * briefly have none, and weekends and holidays never do.
 */
export const readRichCheap = async (
	env: TEnv,
	input: { basis: TRichCheapBasis; date?: string },
) => {
	let date = input.date ?? (await readLatestPriceDate(env));

	let analytics = await readAnalyticsOn(env, input.basis, date);
	for (
		let step = 1;
		input.date === undefined &&
		analytics.length === 0 &&
		step < RICH_CHEAP_LOOKBACK_DAYS;
		step += 1
	) {
		date = dayBefore(date);
		analytics = await readAnalyticsOn(env, input.basis, date);
	}
	if (analytics.length === 0) return null;

	const prices = new Map(
		(await readPricesOn(env, date)).map((row) => [row.cusip, row]),
	);

	const rows: TRichCheapRow[] = [];
	let unpriced = 0;
	for (const row of analytics) {
		const price = prices.get(row.cusip);
		// An analytics row with no price that day is an upstream inconsistency.
		// Counted, not guessed at: its terms would have to come from elsewhere.
		if (price === undefined) {
			unpriced += 1;
			continue;
		}
		rows.push({
			cusip: row.cusip,
			family: securityFamilyFromPriceType(price.securityType),
			couponPercent: price.couponPercent,
			maturityDate: price.maturityDate,
			yearsToMaturity: yearsBetween(date, price.maturityDate),
			price: price.close,
			yieldPercent: row.yieldPercent,
			residualBasisPoints: row.residualBasisPoints,
			priceResidualCents: row.priceResidualCents,
			zScore: row.zScore,
			vsCurve:
				row.residualBasisPoints === null || row.residualBasisPoints === 0
					? null
					: row.residualBasisPoints > 0
						? "cheap"
						: "rich",
			vsHistory:
				row.zScore === null || row.zScore === 0
					? null
					: row.zScore > 0
						? "cheaper"
						: "richer",
		});
	}
	return { date, rows, unpriced };
};

export type TScoredRow = TRichCheapRow & {
	zScore: number;
	residualBasisPoints: number;
	yieldPercent: number;
	vsCurve: TRichCheapSide;
	vsHistory: "richer" | "cheaper";
};

export type TRichCheapFilter = {
	/** Filter on vsHistory: what has cheapened or richened unusually. */
	direction?: "richer" | "cheaper";
	families?: TSecurityFamily[];
	minYears?: number;
	maxYears?: number;
	limit: number;
};

/**
 * Filter, then rank the scored rows by |z| (largest first) and split off the
 * unscored ones. `direction` filters on the z-score's sign (vsHistory), not
 * on today's residual (vsCurve).
 */
export const rankRichCheap = (
	rows: TRichCheapRow[],
	filter: TRichCheapFilter,
) => {
	const kept = rows.filter(
		(row) =>
			(filter.families === undefined ||
				(row.family !== null && filter.families.includes(row.family))) &&
			(filter.minYears === undefined || row.yearsToMaturity >= filter.minYears) &&
			(filter.maxYears === undefined || row.yearsToMaturity <= filter.maxYears),
	);
	// Scored means a z AND the residual and yield it came from. Upstream nulls
	// all three together; requiring all three keeps a partial row out of the
	// ranking instead of publishing a z with no residual beside it.
	const isScored = (row: TRichCheapRow): row is TScoredRow =>
		row.zScore !== null &&
		row.residualBasisPoints !== null &&
		row.yieldPercent !== null;
	const scored = kept
		.filter(isScored)
		.filter(
			(row) =>
				filter.direction === undefined ||
				(filter.direction === "cheaper" ? row.zScore > 0 : row.zScore < 0),
		)
		.sort((left, right) => Math.abs(right.zScore) - Math.abs(left.zScore));
	const unscoredCount = kept.filter((row) => !isScored(row)).length;
	return {
		matchedCount: scored.length,
		unscoredCount,
		ranked: scored.slice(0, filter.limit),
	};
};

/**
 * The maturity bands of the Safe Rate indices, for a day's rich/cheap at a
 * glance. Lower bound inclusive, upper exclusive, so a security sits in one
 * band. Built as the consumer site's internal relative-value page is
 * (saferate-ai apps/consumer services/treasuryRelativeValue.ts, 2026-10-01).
 */
export const RICH_CHEAP_BANDS = [
	{ key: "0001", label: "Under 1 year", minYears: 0, maxYears: 1 },
	{ key: "0103", label: "1 to 3 years", minYears: 1, maxYears: 3 },
	{ key: "0307", label: "3 to 7 years", minYears: 3, maxYears: 7 },
	{ key: "0710", label: "7 to 10 years", minYears: 7, maxYears: 10 },
	{ key: "1020", label: "10 to 20 years", minYears: 10, maxYears: 20 },
	{
		key: "20PL",
		label: "20 years and over",
		minYears: 20,
		maxYears: Number.POSITIVE_INFINITY,
	},
] as const;

/**
 * Notes and bonds by band, the most unusually cheap and rich of each RANKED ON
 * z (how unusual today's residual is for that security), not on the residual
 * itself: the level is structure. On 2026-09-25 the richest bond by price was
 * +91.8 cents with a z of -0.24, persistently rich and ordinary that day.
 *
 * `scoreable` counts every row with a z, a z of exactly 0 included (a
 * security at its own average); it is in neither list, since it is neither.
 * A null z is not zero: counted in `total`, never ranked.
 *
 * BILLS ARE APART. Their z is null by construction, so a z-ranked list would
 * silently drop them; they are ranked by price residual instead, which
 * answers a different question (how far from the curve, not how unusual).
 * Price residual is positive when rich, so the cheapest are the most negative.
 */
export const bandRichCheap = (rows: TRichCheapRow[], perSide = 5) => {
	const coupons = rows.filter((row) => row.family !== "bill");
	const bands = RICH_CHEAP_BANDS.map((band) => {
		const inBand = coupons.filter(
			(row) =>
				row.yearsToMaturity >= band.minYears && row.yearsToMaturity < band.maxYears,
		);
		const all = rankRichCheap(inBand, { limit: 0 });
		return {
			...band,
			total: inBand.length,
			scoreable: inBand.length - all.unscoredCount,
			cheap: rankRichCheap(inBand, { direction: "cheaper", limit: perSide })
				.ranked,
			rich: rankRichCheap(inBand, { direction: "richer", limit: perSide }).ranked,
		};
	});
	const bills = rows.filter(
		(row) => row.family === "bill" && Number.isFinite(row.priceResidualCents),
	);
	const byCents = [...bills].sort(
		(a, b) => a.priceResidualCents - b.priceResidualCents,
	);
	return {
		bands,
		bills: {
			total: bills.length,
			cheap: byCents.slice(0, perSide),
			rich: [...byCents].reverse().slice(0, perSide),
		},
	};
};

/**
 * TIPS on the real curve, ranked on z within TIPS only: never merged with the
 * nominal bands. A TIPS z measures its residual to the fitted REAL curve, a
 * nominal's to the nominal one, so the two residuals are different quantities;
 * the z is comparable only as "how unusual is today for this security". The
 * same one-year floor as the nominal bands (RICH_CHEAP_MIN_YEARS).
 */
export const rankTipsRichCheap = (rows: TRichCheapRow[], perSide = 5) => {
	const kept = rows.filter((row) => row.yearsToMaturity >= RICH_CHEAP_MIN_YEARS);
	const all = rankRichCheap(kept, { limit: 0 });
	return {
		total: kept.length,
		scoreable: kept.length - all.unscoredCount,
		cheap: rankRichCheap(kept, { direction: "cheaper", limit: perSide }).ranked,
		rich: rankRichCheap(kept, { direction: "richer", limit: perSide }).ranked,
	};
};
