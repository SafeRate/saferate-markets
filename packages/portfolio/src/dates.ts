import { isAHoliday } from "@18f/us-federal-holidays";

/**
 * Calendar and coupon-date primitives, PORTED from saferate-treasury
 * packages/utils/src/functions/settlement.ts and treasuryYtm.ts (at e2e7c7e,
 * 2026-09-29), so a position here accrues and settles exactly as the index and
 * the stored analytics do. tests/dates.test.ts holds the accrual to production
 * analytics rows. Change them there first, then here.
 *
 * Dates are ISO strings at the edges and UTC midnights inside.
 */

const MS_PER_DAY = 86_400_000;

export const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
export const toIso = (date: Date) => date.toISOString().slice(0, 10);

export const daysBetween = (from: Date, to: Date) =>
	Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);

const isWeekend = (date: Date) => {
	const day = date.getUTCDay();
	return day === 0 || day === 6;
};

export const isBusinessDay = (date: Date) =>
	!isWeekend(date) && !isAHoliday(date, { utc: true });

export const nextBusinessDay = (date: Date) => {
	const next = new Date(date.getTime());
	do next.setUTCDate(next.getUTCDate() + 1);
	while (!isBusinessDay(next));
	return next;
};

/** T+1: what a trade or a mark on this date settles on. */
export const settlementFor = (iso: string) =>
	toIso(nextBusinessDay(toDate(iso)));

const lastDayOfMonth = (year: number, month: number) =>
	new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** Shift by whole months, carrying month ends (a 31 Aug maturity pays 28 Feb). */
export const addMonths = (date: Date, months: number) => {
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	const day = date.getUTCDate();
	const isMonthEnd = day === lastDayOfMonth(year, month);
	const targetMonth = month + months;
	const targetYear = year + Math.floor(targetMonth / 12);
	const normalised = ((targetMonth % 12) + 12) % 12;
	const targetLast = lastDayOfMonth(targetYear, normalised);
	return new Date(
		Date.UTC(
			targetYear,
			normalised,
			isMonthEnd ? targetLast : Math.min(day, targetLast),
		),
	);
};

/**
 * Every coupon date of a security, walked BACK from maturity to at or before
 * `from`, oldest first. Anchored to maturity like the treasury repo's
 * couponSchedule, so no security master is needed; an odd first period sits at
 * the far end, before anyone here holds it.
 */
export const couponDates = ({
	maturityDate,
	from,
	frequency,
}: {
	maturityDate: string;
	from: string;
	frequency: number;
}) => {
	const monthsPerPeriod = 12 / frequency;
	const floor = toDate(from);
	const dates: Date[] = [toDate(maturityDate)];
	let cursor = addMonths(dates[0], -monthsPerPeriod);
	while (cursor > floor) {
		dates.push(cursor);
		cursor = addMonths(cursor, -monthsPerPeriod);
	}
	dates.push(cursor);
	return dates.reverse().map(toIso);
};

/**
 * Accrued interest per 100 of face at a settlement date: actual/actual on the
 * real period, as Treasury accrues it. Zero at or after maturity and for a
 * zero coupon.
 */
export const accruedPer100 = ({
	couponRate,
	maturityDate,
	settlementDate,
	frequency,
}: {
	/** Decimal: 0.04625 for a 4 5/8% note. */
	couponRate: number;
	maturityDate: string;
	settlementDate: string;
	frequency: number;
}) => {
	if (couponRate === 0 || settlementDate >= maturityDate) return 0;
	const dates = couponDates({ maturityDate, from: settlementDate, frequency });
	// dates[0] is the last coupon at or before settlement, dates[1] the next.
	const previous = toDate(dates[0]);
	const next = toDate(dates[1]);
	const settle = toDate(settlementDate);
	return (
		((couponRate * 100) / frequency) *
		(daysBetween(previous, settle) / daysBetween(previous, next))
	);
};

const isLeapYear = (year: number) =>
	(year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * Years between two ISO dates, actual/actual (ISDA): each calendar year's days
 * over that year's length. The basis the treasury repo's cashflow times and
 * attribution periods are measured on (treasuryYtm.ts yearFraction).
 */
export const yearFraction = (fromIso: string, toIso: string) => {
	const from = toDate(fromIso);
	const to = toDate(toIso);
	if (to <= from) return 0;
	let total = 0;
	let cursor = from;
	while (cursor < to) {
		const year = cursor.getUTCFullYear();
		const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
		const segmentEnd = yearEnd < to ? yearEnd : to;
		total += daysBetween(cursor, segmentEnd) / (isLeapYear(year) ? 366 : 365);
		cursor = segmentEnd;
	}
	return total;
};
