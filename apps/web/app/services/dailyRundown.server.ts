import {
	analyseAuctions,
	call,
	demandKey,
	publishAuction,
	readAuctionDemand,
	readAuctionsBetween,
	shiftDays,
	type TAuctionDemand,
} from "@markets/mcp-tools";
import { z } from "zod";

type TEnv = Env;

/**
 * The Treasury daily rundown for one price date: the closing par curve and
 * how it moved, that day's auction results with treasury's demand reading,
 * and the auctions scheduled for the week after. One loader for the public
 * page (/daily-rundown/treasury/:date) and the email, so the email can say
 * "the same as on the page" and mean it.
 *
 * THE DATE IS A PRICE DATE: the close the curve was fitted on. A day with no
 * fitted curve (a weekend, a holiday, or a close not yet fetched, which is
 * the next business morning) has no rundown, and the loader says so with
 * null rather than rendering an empty one.
 *
 * Every figure comes from the readers the other surfaces use: par yields from
 * `parYieldSeries` (the curve and 2s10s/5s30s pages), auctions from
 * `auctionsBetween` published by `publishAuction` (the auctions page, REST
 * and MCP), demand from treasury's `auctionDemand` on the same date.
 */

export const RUNDOWN_TENORS = [1, 2, 3, 5, 7, 10, 20, 30] as const;
const AHEAD_DAYS = 7;
/** How far back to look for the previous fitted day: a long holiday weekend. */
const BACK_DAYS = 10;

const ZParRow = z
	.object({ date: z.string(), tenor_years: z.number(), par_yield: z.number() })
	.passthrough();

export type TRundownTenor = {
	years: number;
	/** Percent. */
	parYield: number;
	/** Basis points against the previous fitted day; null without one. */
	changeBp: number | null;
};

export type TRundownSpread = {
	name: "2s10s" | "5s30s";
	path: string;
	bp: number;
	changeBp: number | null;
};

const spreadOf = (
	name: TRundownSpread["name"],
	short: number,
	long: number,
	today: Map<number, number>,
	before: Map<number, number> | null,
): TRundownSpread | null => {
	const s = today.get(short);
	const l = today.get(long);
	if (s === undefined || l === undefined) return null;
	const bp = (l - s) * 100;
	const ps = before?.get(short);
	const pl = before?.get(long);
	return {
		name,
		path: `/curve/${name}`,
		bp,
		changeBp: ps === undefined || pl === undefined ? null : bp - (pl - ps) * 100,
	};
};

const readCurve = async (env: TEnv, date: string) => {
	const rows = z.array(ZParRow).parse(
		await call(
			env,
			"parYieldSeries",
		)({
			tenors: [...RUNDOWN_TENORS],
			from: shiftDays(date, -BACK_DAYS),
			to: date,
		}),
	);
	const byDate = new Map<string, Map<number, number>>();
	for (const r of rows) {
		const day = byDate.get(r.date) ?? new Map<number, number>();
		day.set(r.tenor_years, r.par_yield);
		byDate.set(r.date, day);
	}
	const today = byDate.get(date);
	if (!today) return null;
	const previousDate =
		[...byDate.keys()]
			.filter((d) => d < date)
			.sort()
			.at(-1) ?? null;
	const before = previousDate ? (byDate.get(previousDate) ?? null) : null;
	const tenors: TRundownTenor[] = RUNDOWN_TENORS.flatMap((years) => {
		const y = today.get(years);
		if (y === undefined) return [];
		const p = before?.get(years);
		return [
			{
				years,
				parYield: y,
				changeBp: p === undefined ? null : (y - p) * 100,
			},
		];
	});
	return {
		previousDate,
		tenors,
		spreads: [
			spreadOf("2s10s", 2, 10, today, before),
			spreadOf("5s30s", 5, 30, today, before),
		].filter((s): s is TRundownSpread => s !== null),
	};
};

export type TRundownDemand = Pick<
	TAuctionDemand,
	| "verdict"
	| "unranked"
	| "sampleSize"
	| "minSample"
	| "windowMonths"
	| "daysSinceLast"
>;

const demandOf = (d: TAuctionDemand | undefined): TRundownDemand | null =>
	d === undefined
		? null
		: {
				verdict: d.verdict,
				unranked: d.unranked,
				sampleSize: d.sampleSize,
				minSample: d.minSample,
				windowMonths: d.windowMonths,
				daysSinceLast: d.daysSinceLast,
			};

/** The rundown for `date`, or null when no curve was fitted on it. */
export const loadRundown = async (env: TEnv, date: string) => {
	const [curve, auctions, demand] = await Promise.all([
		readCurve(env, date),
		readAuctionsBetween(env, {
			from: date,
			to: shiftDays(date, AHEAD_DAYS),
		}),
		readAuctionDemand(env, date),
	]);
	if (curve === null) return null;
	const analysed = analyseAuctions(auctions, date);
	const results = analysed.latestByTerm
		.filter((row) => row.auction.auctionDate === date)
		.map((row) => ({
			group: row.key,
			auction: publishAuction(row.auction, date),
			demand: demandOf(
				demand.get(demandKey(row.auction.cusip, row.auction.auctionDate)),
			),
		}));
	const ahead = auctions
		.filter((a) => a.auctionDate > date)
		.sort(
			(a, b) =>
				a.auctionDate.localeCompare(b.auctionDate) ||
				a.cusip.localeCompare(b.cusip),
		)
		.map((a) => publishAuction(a, date));
	return {
		date,
		previousDate: curve.previousDate,
		tenors: curve.tenors,
		spreads: curve.spreads,
		results,
		ahead,
		aheadDays: AHEAD_DAYS,
	};
};

export type TRundown = NonNullable<Awaited<ReturnType<typeof loadRundown>>>;

/**
 * The newest date with a fitted curve, which is the newest rundown. Asked of
 * the curve rather than the prices: a close's prices land before its curve is
 * fitted, and a rundown dated by price alone would open on "not published".
 */
export const latestRundownDate = async (
	env: TEnv,
	now = new Date(),
): Promise<string | null> => {
	const today = now.toISOString().slice(0, 10);
	const rows = z
		.array(ZParRow)
		.parse(
			await call(
				env,
				"parYieldSeries",
			)({ tenors: [10], from: shiftDays(today, -BACK_DAYS * 2), to: today }),
		);
	return (
		rows
			.map((r) => r.date)
			.sort()
			.at(-1) ?? null
	);
};
