import { levelReturn, periodStart } from "./returns";

/**
 * Trailing returns of an index from its DAILY levels, the way the consumer
 * site's index pages learned to (treasury-integration, 2026-10-01):
 *
 *  - ENDED ON THE NEWEST VALUATION, not the last month-end. Month-end
 *    anchoring is a fund convention, and it flipped a one-year return's sign
 *    there: +1.18% to 31 Aug against -1.43% to 24 Sep.
 *  - CHAINED FROM THE BASE, not the first published level. The daily series
 *    starts the day after the base (2008-10-01 at 100.35 for the Aggregate),
 *    so starting from its first row deletes that day; the monthly series'
 *    first level is a whole month in. The base is read off the first row
 *    itself: its rebalance date, at level / (1 + return since rebalance),
 *    which is 100 by construction and is computed rather than assumed.
 */

export type TIndexDailyLevel = {
	date: string;
	level: number;
	rebalanceDate: string;
	returnSinceRebalancePercent: number;
};

export const INDEX_PERIODS = [
	"mtd",
	"qtd",
	"ytd",
	"1y",
	"3y",
	"5y",
	"inception",
] as const;
export type TIndexPeriod = (typeof INDEX_PERIODS)[number];

/** The series with its base prepended: the level the first row was struck from. */
export const fromBase = (levels: TIndexDailyLevel[]) => {
	const sorted = [...levels].sort((a, b) => a.date.localeCompare(b.date));
	const first = sorted[0];
	if (first === undefined) return [];
	const base = {
		date: first.rebalanceDate,
		level: first.level / (1 + first.returnSinceRebalancePercent / 100),
	};
	return [base, ...sorted.map((l) => ({ date: l.date, level: l.level }))].filter(
		(l, i, all) => i === 0 || l.date > all[i - 1].date,
	);
};

/**
 * Each period's return to the newest level. Null where the series does not
 * reach back to the period's start (a 5-year return of a younger index).
 */
export const trailingReturns = (series: { date: string; level: number }[]) => {
	const end = series.at(-1)?.date;
	if (end === undefined) return null;
	const first = series[0].date;
	return {
		end,
		periods: INDEX_PERIODS.map((key) => {
			const start = key === "inception" ? first : periodStart(key, end);
			const r =
				start === null || start < first ? null : levelReturn(series, start, end);
			return {
				key,
				start,
				cumulative: r?.cumulative ?? null,
				annualised: r?.annualised ?? null,
			};
		}),
	};
};
