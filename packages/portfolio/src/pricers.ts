import {
	accruedPer100,
	couponDates,
	daysBetween,
	settlementFor,
	toDate,
	toIso,
} from "./dates";

/**
 * What a security is worth and pays, per 100 of (original) face, in DOLLARS.
 * The ledger asks only these questions, so a nominal note, an inflation-linked
 * note and a floater differ here and nowhere else.
 *
 *  - NOMINAL (bills, notes, bonds): the coupon formula, as the index values them.
 *  - TIPS: the quote is a REAL price. Dollars are real dirty x the index ratio
 *    at settlement; each coupon is the real coupon x the ratio on its date; the
 *    principal repaid is 100 x the ratio, floored at 100 (the deflation floor).
 *    Ratios come from the stored tips analytics, as the index takes them:
 *    never recomputed, which would be a second answer for the same security.
 *  - FRN: accrues daily at max(0, index + spread) actual/360 and pays
 *    quarterly. Accrual comes from the stored frn analytics; between stored days
 *    it runs on at the last stored rate.
 *
 * Future coupons (projected income) for a TIPS or FRN hold the last known ratio
 * or rate flat, and `isEstimate` says so.
 */

export type TPricer = {
	/** Dollars per 100 face held, from a close on a mark date. */
	dirty: (close: number, markDate: string) => number;
	/** Dollars per 100 face that change hands in a trade. */
	tradeDirty: (cleanPrice: number, settlementDate: string) => number;
	/** Accrued interest in dollars per 100 face at a settlement date. */
	accrued: (settlementDate: string) => number;
	/** Dollars per 100 face paid on a coupon date. */
	coupon: (couponDate: string) => number;
	/** Principal repaid at maturity per 100 face. */
	redemption: () => number;
	/** Every coupon date from before `from` to maturity. */
	couponDates: (from: string) => string[];
	/** True when a figure after `date` relies on holding a ratio or rate flat. */
	isEstimate: (date: string) => boolean;
};

export const nominalPricer = (terms: {
	couponRate: number;
	maturityDate: string;
	frequency: number;
}): TPricer => {
	// Per settlement date, for this security's life: a valuation asks the same
	// dates over and over.
	const accruedOn = new Map<string, number>();
	const accrued = (settlementDate: string) => {
		let value = accruedOn.get(settlementDate);
		if (value === undefined) {
			value = accruedPer100({ ...terms, settlementDate });
			accruedOn.set(settlementDate, value);
		}
		return value;
	};
	return {
		dirty: (close, markDate) => close + accrued(settlementFor(markDate)),
		tradeDirty: (clean, settlementDate) => clean + accrued(settlementDate),
		accrued,
		coupon: () => (terms.couponRate * 100) / terms.frequency,
		redemption: () => 100,
		couponDates: (from) =>
			terms.couponRate > 0
				? couponDates({
						maturityDate: terms.maturityDate,
						from,
						frequency: terms.frequency,
					})
				: [],
		isEstimate: () => false,
	};
};

const monthOf = (iso: string) => iso.slice(0, 7);

/** Index of the last element whose key is <= `key` (or < when strict), else -1. Sorted input. */
const lastAtOrBefore = <T>(
	sorted: T[],
	key: string,
	keyOf: (t: T) => string,
	strict = false,
) => {
	let low = 0;
	let high = sorted.length - 1;
	let found = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const k = keyOf(sorted[mid]);
		if (strict ? k < key : k <= key) {
			found = mid;
			low = mid + 1;
		} else high = mid - 1;
	}
	return found;
};

/**
 * The index ratio on any date from stored (settlement date, ratio) points.
 * Within a calendar month the reference CPI, and so the ratio, is linear in
 * the day, so two stored days in the month fix it exactly. Otherwise it is
 * interpolated between the nearest stored days, or held at the last one.
 */
export const indexRatioAt = (points: { date: string; ratio: number }[]) => {
	const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
	const byMonth = new Map<string, { date: string; ratio: number }[]>();
	const exactByDate = new Map(sorted.map((p) => [p.date, p.ratio]));
	for (const p of sorted) {
		const month = byMonth.get(monthOf(p.date));
		if (month) month.push(p);
		else byMonth.set(monthOf(p.date), [p]);
	}
	return (date: string) => {
		const exact = exactByDate.get(date);
		if (exact !== undefined) return exact;
		const sameMonth = byMonth.get(monthOf(date)) ?? [];
		if (sameMonth.length >= 2) {
			const a = sameMonth[0];
			const b = sameMonth[sameMonth.length - 1];
			const slope =
				(b.ratio - a.ratio) / daysBetween(toDate(a.date), toDate(b.date));
			return a.ratio + slope * daysBetween(toDate(a.date), toDate(date));
		}
		const i = lastAtOrBefore(sorted, date, (p) => p.date, true);
		const before = i === -1 ? undefined : sorted[i];
		const after = sorted[i + 1];
		if (before && after) {
			const t =
				daysBetween(toDate(before.date), toDate(date)) /
				daysBetween(toDate(before.date), toDate(after.date));
			return before.ratio + t * (after.ratio - before.ratio);
		}
		return (before ?? after)?.ratio ?? null;
	};
};

export const tipsPricer = (
	terms: { couponRate: number; maturityDate: string; frequency: number },
	/** The stored rows: price date and the ratio at its settlement. */
	rows: { date: string; indexRatio: number }[],
): TPricer => {
	const points = rows.map((r) => ({
		date: settlementFor(r.date),
		ratio: r.indexRatio,
	}));
	const lastKnown = points.reduce((max, p) => (p.date > max ? p.date : max), "");
	const ratioAt = indexRatioAt(points);
	const ratio = (date: string) => ratioAt(date) ?? 1;
	const realAccrued = (settlementDate: string) =>
		accruedPer100({ ...terms, settlementDate });
	return {
		dirty: (close, markDate) => {
			const settlement = settlementFor(markDate);
			return (close + realAccrued(settlement)) * ratio(settlement);
		},
		tradeDirty: (clean, settlementDate) =>
			(clean + realAccrued(settlementDate)) * ratio(settlementDate),
		accrued: (settlementDate) =>
			realAccrued(settlementDate) * ratio(settlementDate),
		coupon: (couponDate) =>
			((terms.couponRate * 100) / terms.frequency) * ratio(couponDate),
		redemption: () => 100 * Math.max(1, ratio(terms.maturityDate)),
		couponDates: (from) =>
			couponDates({
				maturityDate: terms.maturityDate,
				from,
				frequency: terms.frequency,
			}),
		isEstimate: (date) => date > lastKnown,
	};
};

export const frnPricer = (
	terms: { maturityDate: string },
	/** The stored rows: price date, accrued at its settlement, and the rate then (decimals). */
	rows: { date: string; accrued: number; indexRate: number; spread: number }[],
): TPricer => {
	const known = rows
		.map((r) => ({
			settlement: settlementFor(r.date),
			accrued: r.accrued,
			rate: Math.max(0, r.indexRate + r.spread),
		}))
		.sort((a, b) => a.settlement.localeCompare(b.settlement));
	const lastKnown = known.at(-1)?.settlement ?? "";
	const schedule = (from: string) =>
		couponDates({ maturityDate: terms.maturityDate, from, frequency: 4 });
	/** The last coupon date strictly before `date` (the start of its accrual period). */
	const periodStart = (date: string) => {
		// Walked back from the DAY BEFORE, so on a coupon date this is the
		// previous coupon, not the date itself (which made every coupon zero).
		const dayBefore = toIso(new Date(toDate(date).getTime() - 86_400_000));
		return schedule(dayBefore)[0];
	};
	/**
	 * Accrued at `date` (a settlement or a coupon date), per 100.
	 *
	 * A COUPON is the accrual up to its date, so it anchors on rows settling
	 * strictly before it (`strict`). A stored row that settles ON the coupon
	 * date carries the new period's accrued, zero. Found 2026-09-29 by Test 09:
	 * 30 Apr and 31 Jul 2026 (weekdays, so a row settled on each) paid nothing,
	 * while 31 Jan (a Saturday) paid in full, and an all-FRN book showed half
	 * its income: 1.56% since January against its index's 2.99%.
	 */
	const accruedTo = (date: string, strict = false) => {
		const start = periodStart(date);
		const at = lastAtOrBefore(known, date, (k) => k.settlement, strict);
		const anchor =
			at !== -1 && known[at].settlement > start ? known[at] : undefined;
		if (anchor !== undefined)
			return (
				anchor.accrued +
				(anchor.rate * 100 * daysBetween(toDate(anchor.settlement), toDate(date))) /
					360
			);
		// Nothing stored inside this period yet: accrue from its start at the
		// latest rate known before it.
		const rate = (at === -1 ? known[0] : known[at])?.rate ?? 0;
		return (rate * 100 * daysBetween(toDate(start), toDate(date))) / 360;
	};
	const accrued = (settlementDate: string) => {
		// On a coupon date the new period has just begun: nothing accrued.
		if (schedule(settlementDate).includes(settlementDate)) return 0;
		return accruedTo(settlementDate);
	};
	return {
		dirty: (close, markDate) => close + accrued(settlementFor(markDate)),
		tradeDirty: (clean, settlementDate) => clean + accrued(settlementDate),
		accrued,
		coupon: (couponDate) => accruedTo(couponDate, true),
		redemption: () => 100,
		couponDates: schedule,
		isEstimate: (date) => date > lastKnown,
	};
};
