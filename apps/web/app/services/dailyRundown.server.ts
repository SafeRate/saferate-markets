import {
	analyseAuctions,
	call,
	demandKey,
	publishAuction,
	readAuctionDemand,
	readAuctionsBetween,
	readDailyLevelsOn,
	shiftDays,
	type TAuctionDemand,
} from "@markets/mcp-tools";
import { getCurvesOn, getRealCurveOn } from "@saferate/treasury-client/client";
import {
	INDEX_META,
	INDEX_SLUG,
	type TIndexCode,
} from "@saferate/treasury-client/types";
import { z } from "zod";

type TEnv = Env;

/**
 * The Treasury daily rundown for one price date: the closing par curve and
 * how it moved, that day's auction results with treasury's demand reading,
 * and the auctions scheduled for the week after. Beside the par curve, the
 * zero and real (TIPS) curves at the same tenors, and the bill-fitted money
 * market curve below a year. One loader for the public
 * page (/daily-rundown/treasury/:date) and the email, so the email can say
 * "the same as on the page" and mean it.
 *
 * THE EDITION IS DATED BY THE MORNING IT GOES OUT, the next weekday after
 * the close it covers (`editionOf`): Thursday's close is Friday's
 * rundown, and its sections say "at the close, Thu, Oct 8". The page's URL
 * carries the edition date; everything inside works on the price date.
 *
 * THE PRICE DATE is the close the curve was fitted on. A day with no
 * fitted curve (a weekend, a holiday, or a close not yet fetched, which is
 * the next business morning) has no rundown, and the loader says so with
 * null rather than rendering an empty one.
 *
 * Every figure comes from the readers the other surfaces use: par yields from
 * `parYieldSeries` (the curve and 2s10s/5s30s pages), auctions from
 * `auctionsBetween` published by `publishAuction` (the auctions page, REST
 * and MCP), demand from treasury's `auctionDemand` on the same date, and the
 * zero, real and money market curves from the readers the Rates page uses,
 * and the Safe Rate index levels from the reader /indices uses.
 */

export const RUNDOWN_TENORS = [1, 2, 3, 5, 7, 10, 20, 30] as const;
const AHEAD_DAYS = 7;
/** How far back to look for the previous fitted day: a long holiday weekend. */
const BACK_DAYS = 10;
/** Enough history for the month comparison plus a holiday before it. */
const HISTORY_DAYS = 40;

/** The same day a calendar month earlier ("2026-03-31" → "2026-02-28"). */
const monthBefore = (date: string) => {
	const d = new Date(`${date}T00:00:00Z`);
	const day = d.getUTCDate();
	d.setUTCDate(1);
	d.setUTCMonth(d.getUTCMonth() - 1);
	const last = new Date(
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
	).getUTCDate();
	d.setUTCDate(Math.min(day, last));
	return d.toISOString().slice(0, 10);
};

/** Basis points from `then` to `now`; null without a comparison close. */
const bp = (now: number, then: number | undefined) =>
	then === undefined ? null : (now - then) * 100;

/** The newest fitted date on or before `limit`, the comparison close. */
const closeOnOrBefore = (dates: string[], limit: string) =>
	dates.filter((d) => d <= limit).at(-1) ?? null;

const ZParRow = z
	.object({
		date: z.string(),
		tenor_years: z.number(),
		par_yield: z.number(),
		zero_rate: z.number().nullable().optional(),
	})
	.passthrough();

export type TRundownTenor = {
	years: number;
	/** Percent. */
	parYield: number;
	/** Basis points against the previous fitted day; null without one. */
	changeBp: number | null;
	/** Basis points against the close a week earlier (on or before date − 7 days). */
	weekBp: number | null;
	/** Basis points against the close a calendar month earlier (on or before). */
	monthBp: number | null;
	/** Percent, continuously compounded. */
	zeroRate: number | null;
	/** Percent, continuously compounded; null where the TIPS curve has no tenor (1y). */
	realRate: number | null;
};

export type TRundownMoneyMarket = {
	rates: {
		label: string;
		rate: number;
		changeBp: number | null;
		weekBp: number | null;
		monthBp: number | null;
	}[];
	billCount: number;
	convention: string;
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
			from: shiftDays(date, -HISTORY_DAYS),
			to: date,
		}),
	);
	const byDate = new Map<string, Map<number, number>>();
	const zeros = new Map<number, number>();
	for (const r of rows) {
		const day = byDate.get(r.date) ?? new Map<number, number>();
		day.set(r.tenor_years, r.par_yield);
		byDate.set(r.date, day);
		if (r.date === date && typeof r.zero_rate === "number")
			zeros.set(r.tenor_years, r.zero_rate);
	}
	const today = byDate.get(date);
	if (!today) return null;
	const dates = [...byDate.keys()].sort();
	const previousDate =
		dates.filter((d) => d < date && d >= shiftDays(date, -BACK_DAYS)).at(-1) ??
		null;
	const weekDate = closeOnOrBefore(dates, shiftDays(date, -7));
	const monthDate = closeOnOrBefore(dates, monthBefore(date));
	const before = previousDate ? (byDate.get(previousDate) ?? null) : null;
	const week = weekDate ? byDate.get(weekDate) : undefined;
	const month = monthDate ? byDate.get(monthDate) : undefined;
	const tenors: TRundownTenor[] = RUNDOWN_TENORS.flatMap((years) => {
		const y = today.get(years);
		if (y === undefined) return [];
		const p = before?.get(years);
		return [
			{
				years,
				parYield: y,
				changeBp: p === undefined ? null : (y - p) * 100,
				weekBp: bp(y, week?.get(years)),
				monthBp: bp(y, month?.get(years)),
				zeroRate: zeros.get(years) ?? null,
				realRate: null as number | null,
			},
		];
	});
	return {
		previousDate,
		weekDate,
		monthDate,
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

/**
 * A curve beside the par curve that failed to load costs its own rows, not
 * the rundown: the email still goes, and the page and email say the curve is
 * unavailable rather than leaving it out.
 */
const optional = async <T>(what: string, read: () => Promise<T | null>) => {
	try {
		return await read();
	} catch (error) {
		console.error(`[rundown] ${what} unavailable:`, error);
		return null;
	}
};

const readMoneyMarket = async (
	env: TEnv,
	date: string,
	compare: (string | null)[],
): Promise<TRundownMoneyMarket | null> => {
	const ratesOn = async (on: string | null) => {
		if (on === null) return null;
		const day = await optional(`money market ${on}`, () =>
			getCurvesOn({ env, date: on }),
		);
		return day?.moneyMarket?.hasConverged ? day.moneyMarket : null;
	};
	const [mm, ...priors] = await Promise.all([
		ratesOn(date),
		...compare.map(ratesOn),
	]);
	if (!mm) return null;
	const [day, week, month] = priors.map((p) =>
		p ? new Map(p.rates.map((r) => [r.label, r.rate])) : null,
	);
	return {
		rates: mm.rates.map((r) => ({
			label: r.label,
			rate: r.rate,
			changeBp: bp(r.rate, day?.get(r.label)),
			weekBp: bp(r.rate, week?.get(r.label)),
			monthBp: bp(r.rate, month?.get(r.label)),
		})),
		billCount: mm.billCount,
		convention: mm.convention,
	};
};

export type TRundownIndex = {
	code: string;
	name: string;
	ticker: string;
	/** Its page on saferate.com, /treasury/indices/<slug>. */
	slug: string;
	/** Total-return level. */
	level: number;
	/** True while the month is open and its prices can still be restated. */
	isProvisional: boolean;
	/** Total return in percent, from the level at each comparison close. */
	changePct: number | null;
	weekPct: number | null;
	monthPct: number | null;
};

/** Percent from `then` to `now`, from total-return levels. */
const returnPct = (now: number, then: number | undefined) =>
	then === undefined ? null : (now / then - 1) * 100;

/**
 * Every index's level at the close and its total return since the same
 * comparison closes as the curve. Levels, not the since-rebalance return:
 * a week can straddle a rebalance, and differencing levels is right across
 * one. Null when the close has no levels yet: they are published by
 * treasury's verify run, about a quarter of an hour after the curve.
 */
const readIndices = async (
	env: TEnv,
	date: string,
	compare: (string | null)[],
): Promise<TRundownIndex[] | null> => {
	const levelsOn = (on: string | null) =>
		on === null
			? Promise.resolve(null)
			: optional(`index levels ${on}`, () => readDailyLevelsOn(env, on));
	const [today, ...priors] = await Promise.all([
		levelsOn(date),
		...compare.map(levelsOn),
	]);
	if (!today || today.length === 0) return null;
	const [day, week, month] = priors.map((p) =>
		p ? new Map(p.map((row) => [row.code, row.level])) : null,
	);
	return today.map((row) => {
		const code = row.code as TIndexCode;
		return {
			code,
			name: INDEX_META[code].name,
			ticker: INDEX_META[code].ticker,
			slug: INDEX_SLUG[code],
			level: row.level,
			isProvisional: row.isProvisional,
			changePct: returnPct(row.level, day?.get(code)),
			weekPct: returnPct(row.level, week?.get(code)),
			monthPct: returnPct(row.level, month?.get(code)),
		};
	});
};

/**
 * The morning a close's rundown goes out: the next weekday. Not the next
 * business day: treasury fetches a close the next morning whether or not it
 * is a holiday (Friday 2026-10-09 is fetched on Columbus Day), so a holiday
 * calendar would date Monday's email Tuesday.
 */
export const editionOf = (priceDate: string) => {
	const d = new Date(`${priceDate}T00:00:00Z`);
	do d.setUTCDate(d.getUTCDate() + 1);
	while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
	return d.toISOString().slice(0, 10);
};

/**
 * The close an edition covers: the newest fitted day whose next business day
 * is `edition`. Null when there is none (a weekend, a holiday, or a morning
 * whose close is not fitted yet).
 */
export const priceDateFor = async (env: TEnv, edition: string) => {
	const rows = z.array(ZParRow).parse(
		await call(
			env,
			"parYieldSeries",
		)({
			tenors: [10],
			from: shiftDays(edition, -BACK_DAYS),
			to: shiftDays(edition, -1),
		}),
	);
	return (
		rows
			.map((r) => r.date)
			.filter((d) => editionOf(d) === edition)
			.sort()
			.at(-1) ?? null
	);
};

/** The rundown for `date`, or null when no curve was fitted on it. */
export const loadRundown = async (env: TEnv, date: string) => {
	const [curve, auctions, demand, real] = await Promise.all([
		readCurve(env, date),
		readAuctionsBetween(env, {
			from: date,
			to: shiftDays(date, AHEAD_DAYS),
		}),
		readAuctionDemand(env, date),
		optional("real curve", () => getRealCurveOn({ env, date })),
	]);
	if (curve === null) return null;
	const realCurve = real?.hasConverged ? real : null;
	const realBy = new Map(realCurve?.rates.map((r) => [r.tenorYears, r.rate]));
	const tenors = curve.tenors.map((t) => ({
		...t,
		realRate: realBy.get(t.years) ?? null,
	}));
	const compare = [curve.previousDate, curve.weekDate, curve.monthDate];
	const [moneyMarket, indices] = await Promise.all([
		readMoneyMarket(env, date, compare),
		readIndices(env, date, compare),
	]);
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
		edition: editionOf(date),
		previousEdition: curve.previousDate ? editionOf(curve.previousDate) : null,
		previousDate: curve.previousDate,
		weekDate: curve.weekDate,
		monthDate: curve.monthDate,
		tenors,
		hasZero: tenors.some((t) => t.zeroRate !== null),
		real: realCurve ? { tipsCount: realCurve.tipsCount } : null,
		spreads: curve.spreads,
		moneyMarket,
		indices,
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
