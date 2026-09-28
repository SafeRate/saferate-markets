import {
	DISCLOSURE_TREASURY,
	noData,
	runTreasury,
	snakeKeys,
	TREASURY_URLS,
	type TDepsTreasury,
} from "./shared";
import {
	getConstituentDates,
	getFundComparison,
	getIndexBaseDate,
	getIndexConstituents,
	getIndexLevelOn,
	getIndexLevelsDaily,
	getIndexLevelsOn,
	getIndexSeries,
	getLatestIndexLevels,
} from "@saferate/treasury-client/client";
import { INDEX_DISPLAY_ORDER } from "@saferate/treasury-client/types";
import { z } from "zod";

/**
 * `get_treasury_index` — Safe Rate's own Treasury total-return indices.
 *
 * ⚠️ THE ONE THING TO GET RIGHT: these are TOTAL RETURN indices, not yields. A
 * level of 180 does not mean 180% or 1.8%; it means a portfolio worth 100 at
 * the base date is worth 180 now, coupons reinvested. Comparing an index level
 * to a yield, or reading a rise in the level as a rise in rates, inverts the
 * relationship — bond prices rise when yields FALL, so a rising index usually
 * means rates fell. The tool says so in-band on every response because this is
 * the single most likely misreading.
 *
 * ⚠️ AND THEY ARE SAFE RATE'S, NOT TREASURY'S. These are constructed here from
 * published Treasury prices. They are not an official government statistic and
 * not a licensed commercial index; do not present a level as something a reader
 * can verify at treasury.gov, and do not compare one to a Bloomberg or ICE
 * index as though the construction matched.
 *
 * `omit` with no `code` lists every index at its latest level, which is the
 * right first call — the codes are not guessable.
 */

const ZInputGetTreasuryIndex = z.object({
	code: z.string().min(1).max(16).optional(),
	constituents_on: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
	include: z
		.array(z.enum(["constituents", "daily_history", "fund_comparison"]))
		.optional(),
	on: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
	since: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
});
type TInputGetTreasuryIndex = z.input<typeof ZInputGetTreasuryIndex>;

/** Said on every response; see the header. */
const TOTAL_RETURN_WARNING =
	"These are TOTAL RETURN index levels, not yields and not percentages. A level is the value of a portfolio that started at the base level on the base date with coupons reinvested. A RISING level usually means yields FELL, because bond prices move inversely to yields. Never present a level as a rate, and never subtract two levels and call the result a yield change.";

const NOT_OFFICIAL =
	"Constructed by Safe Rate from published Treasury prices. Not an official U.S. Treasury statistic and not a licensed commercial index — a reader cannot verify these levels at treasury.gov, and they are not directly comparable to Bloomberg or ICE indices, which are built differently.";

export async function getTreasuryIndex(
	_input: TInputGetTreasuryIndex,
	_deps: TDepsTreasury,
) {
	const input = ZInputGetTreasuryIndex.parse(_input);
	const { env } = _deps;
	const include = new Set(input.include ?? []);

	// No code: the catalogue. Every index at its latest level, which is both the
	// overview and the way to discover the codes.
	if (input.code === undefined) {
		// `on` switches the catalogue from "latest" to "as at that date", which is
		// how a caller compares every index across one day rather than reading
		// them one at a time.
		const levels = await runTreasury(() =>
			input.on === undefined
				? getLatestIndexLevels({ env })
				: getIndexLevelsOn({ date: input.on, env }),
		);
		if (_isFailure(levels)) return levels;
		const result: Record<string, unknown> = {
			ok: true,
			as_of: input.on ?? "latest published day",
			indices: snakeKeys(levels),
			available_codes: [...INDEX_DISPLAY_ORDER],
			total_return_warning: TOTAL_RETURN_WARNING,
			not_official: NOT_OFFICIAL,
		};
		if (include.has("fund_comparison")) {
			const funds = await runTreasury(() => getFundComparison({ env }));
			if (_isFailure(funds)) return funds;
			result.fund_comparison = {
				funds: snakeKeys(funds),
				note:
					"Each index set beside comparable public bond funds. The gap between an index and a fund tracking the same segment is fees and tracking difference, not alpha.",
			};
		}
		return {
			...result,
			disclosure: DISCLOSURE_TREASURY,
			next_steps: { indices_url: TREASURY_URLS.indices },
		};
	}

	// RESOLVED CASE-INSENSITIVELY AGAINST THE REAL CODE LIST, not upper-cased.
	// The codes are MIXED case — "broad" is lowercase while "TIPS", "AGG" and
	// "20PL" are upper — so a blanket toUpperCase() turned the single most
	// obvious code a caller would type into one upstream does not know.
	const code = INDEX_DISPLAY_ORDER.find(
		(known) => known.toLowerCase() === input.code?.trim().toLowerCase(),
	);

	// Validated HERE rather than upstream, and that is not belt-and-braces: an
	// unknown code does not come back as an `unknown_index` refusal, it comes
	// back as a retried 503, which reaches the assistant as the string
	// "[object Response]". Checking a fixed eleven-item list locally turns that
	// into a usable answer and costs no round trip.
	if (code === undefined) {
		return {
			ok: false as const,
			error: "unknown_index",
			message: `No index with code "${input.code}". Available codes: ${INDEX_DISPLAY_ORDER.join(", ")}. Call this tool without a code to list them all with their current levels.`,
		};
	}

	const series = await runTreasury(() => getIndexSeries({ code, env }));
	if (_isFailure(series)) return series;
	if (series === null || series.length === 0) {
		return {
			ok: false as const,
			error: "no_data",
			message: `Index "${code}" is a valid code but has no published levels.`,
		};
	}

	const result: Record<string, unknown> = {
		ok: true,
		code,
		monthly_levels: snakeKeys(series),
		total_return_warning: TOTAL_RETURN_WARNING,
		not_official: NOT_OFFICIAL,
	};

	if (include.has("daily_history")) {
		const daily = await runTreasury(() =>
			getIndexLevelsDaily({ code, env, since: input.since }),
		);
		if (_isFailure(daily)) return daily;
		result.daily_history =
			daily === null
				? null
				: {
						levels: snakeKeys(daily),
						since: input.since ?? "start of the index",
					};
	}

	if (include.has("constituents")) {
		const dates = await runTreasury(() => getConstituentDates({ code, env }));
		if (_isFailure(dates)) return dates;
		const available = Array.isArray(dates) ? dates : [];
		// Constituents exist only on rebalance dates, so an arbitrary date
		// returns nothing. Default to the most recent one rather than to today.
		const on = input.constituents_on ?? available.at(-1);
		if (on === undefined) {
			result.constituents = noData("constituent snapshots", `index ${code}`);
		} else {
			const [constituents, levelOn] = await Promise.all([
				runTreasury(() => getIndexConstituents({ code, date: on, env })),
				runTreasury(() => getIndexLevelOn({ code, date: on, env })),
			]);
			if (_isFailure(constituents)) return constituents;
			if (_isFailure(levelOn)) return levelOn;
			result.constituents = {
				on,
				available_dates: available,
				level_on_that_date: snakeKeys(levelOn),
				holdings: snakeKeys(constituents),
				note:
					"Constituents are published on REBALANCE dates only, not daily. An arbitrary date has no snapshot, so this defaults to the most recent rebalance.",
			};
		}
	}

	// Only asked when there IS a first level to key on. The lookup takes the
	// index's earliest published date, and inventing a placeholder to satisfy
	// the signature would ask upstream a question about a date that never
	// existed.
	const firstLevelDate = series[0]?.date;
	const base =
		firstLevelDate === undefined
			? null
			: await runTreasury(() => getIndexBaseDate({ env, firstLevelDate }));
	if (base !== null && !_isFailure(base)) {
		result.base_date = {
			date: base,
			note:
				"The date the index was set to its base level. Every level is relative to this date, so two indices with different base dates cannot be compared by level alone — compare percentage changes over a shared window instead.",
		};
	}

	return {
		...result,
		disclosure: DISCLOSURE_TREASURY,
		next_steps: {
			index_url: `${TREASURY_URLS.indices}/${code.toLowerCase()}`,
			indices_url: TREASURY_URLS.indices,
		},
	};
}

function _isFailure(value: unknown): value is { ok: false } {
	return (
		typeof value === "object" &&
		value !== null &&
		"ok" in value &&
		(value as { ok: unknown }).ok === false
	);
}

export { ZInputGetTreasuryIndex };
