import { call } from "@markets/mcp-tools";
import { z } from "zod";

type TEnv = Env;

/**
 * A Treasury curve spread (2s10s, 5s30s) from Safe Rate's fitted par curve:
 * the long tenor's par yield minus the short's, in basis points, every
 * business day since September 2008.
 *
 * PAR, NOT ZERO: the market quotes these spreads in par (coupon) yields, and
 * the fitted par curve tracks the Federal Reserve's within 2.28 bp RMSE
 * (methodology page). Read through treasury's `parYieldSeries`, one row per
 * date per tenor, which refuses a tenor it does not store rather than
 * returning a quiet gap.
 *
 * Treasury's H.15 constant-maturity spread is NOT drawn here yet: the gap
 * between the two curves is being measured, and a second line goes on the
 * chart only once that number exists.
 */

export const SPREADS = {
	"2s10s": { short: 2, long: 10, name: "2s10s" },
	"5s30s": { short: 5, long: 30, name: "5s30s" },
} as const;
export type TSpreadKey = keyof typeof SPREADS;

export const HISTORY_START = "2008-09-01";

const ZRow = z
	.object({
		date: z.string(),
		tenor_years: z.number(),
		par_yield: z.number(),
	})
	.passthrough();

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysBefore = (date: string, days: number) => {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - days);
	return iso(d);
};

/** The spread on the last date on or before `date`, or null. */
const onOrBefore = (points: { date: string; bp: number }[], date: string) => {
	let found: { date: string; bp: number } | null = null;
	for (const p of points) {
		if (p.date > date) break;
		found = p;
	}
	return found;
};

/**
 * What the chart is sent: every day for the last 400 days, one day a week
 * before that. Max and 5Y views stay faithful to the shape at a quarter of
 * the bytes; the statistics are always computed on the full daily series.
 */
const thin = (points: { date: string; bp: number }[]) => {
	const recent = daysBefore(points.at(-1)?.date ?? HISTORY_START, 400);
	// The record high and low are always drawn, so the Max view's range
	// matches the low and high the page states.
	let low = 0;
	let high = 0;
	points.forEach((p, i) => {
		if (p.bp < points[low].bp) low = i;
		if (p.bp > points[high].bp) high = i;
	});
	return points.filter(
		(p, i) =>
			p.date >= recent ||
			i % 5 === 0 ||
			i === low ||
			i === high ||
			i === points.length - 1,
	);
};

export const loadSpread = async (env: TEnv, key: TSpreadKey) => {
	const spread = SPREADS[key];
	const rows = z.array(ZRow).parse(
		await call(
			env,
			"parYieldSeries",
		)({
			tenors: [spread.short, spread.long],
			from: HISTORY_START,
			to: iso(new Date()),
		}),
	);
	const byDate = new Map<string, { short?: number; long?: number }>();
	for (const r of rows) {
		const day = byDate.get(r.date) ?? {};
		if (r.tenor_years === spread.short) day.short = r.par_yield;
		if (r.tenor_years === spread.long) day.long = r.par_yield;
		byDate.set(r.date, day);
	}
	const points = [...byDate]
		.filter(([, d]) => d.short !== undefined && d.long !== undefined)
		.map(([date, d]) => ({
			date,
			bp: ((d.long as number) - (d.short as number)) * 100,
			short: d.short as number,
			long: d.long as number,
		}))
		.sort((a, b) => a.date.localeCompare(b.date));
	const last = points.at(-1);
	if (!last) throw new Error(`no ${key} history`);

	const changeOver = (days: number) => {
		const then = onOrBefore(points, daysBefore(last.date, days));
		return then ? last.bp - then.bp : null;
	};
	const previous = points.at(-2) ?? null;
	const min = points.reduce((m, p) => (p.bp < m.bp ? p : m), last);
	const max = points.reduce((m, p) => (p.bp > m.bp ? p : m), last);
	const atOrBelow = points.filter((p) => p.bp <= last.bp).length;

	return {
		key,
		name: spread.name,
		shortYears: spread.short,
		longYears: spread.long,
		asOf: last.date,
		bp: last.bp,
		shortYield: last.short,
		longYield: last.long,
		changes: {
			day: previous ? last.bp - previous.bp : null,
			week: changeOver(7),
			month: changeOver(30),
			year: changeOver(365),
		},
		min: { date: min.date, bp: min.bp },
		max: { date: max.date, bp: max.bp },
		percentile: (atOrBelow / points.length) * 100,
		days: points.length,
		since: points[0].date,
		history: thin(points).map((p) => ({ date: p.date, bp: p.bp })),
	};
};

export type TSpread = Awaited<ReturnType<typeof loadSpread>>;
