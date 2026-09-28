import {
	coverageStart,
	DISCLOSURE_TREASURY,
	noData,
	runTreasury,
	snakeKeys,
	TREASURY_URLS,
	type TDepsTreasury,
} from "./shared";
import {
	getMoneyMarketSeries,
	getRealCurveSeries,
	getZeroCurveSeries,
} from "@saferate/treasury-client/client";
import { z } from "zod";

/**
 * `get_treasury_rate_history` — one curve across a date range.
 *
 * THE RANGE IS THE WHOLE COST. These return one row per trading day, so a
 * fifteen-year request is ~3,800 rows of multi-tenor curve and will swamp a
 * model's context long before it helps. The range is required rather than
 * defaulted for that reason: an assistant that has to type the dates has to
 * think about how many it is asking for.
 *
 * A NOTE ON "IS THIS HIGH?". The interesting question about a rate history is
 * almost never the series itself but where today sits inside it, so the tool
 * computes that percentile rather than leaving a model to eyeball 3,800 rows —
 * the same statistic the /treasury tenor pages publish.
 */

const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ZInputGetTreasuryRateHistory = z.object({
	curve: z.enum(["money_market", "real", "zero"]).optional(),
	from: zIsoDate,
	to: zIsoDate,
});
type TInputGetTreasuryRateHistory = z.input<
	typeof ZInputGetTreasuryRateHistory
>;

export async function getTreasuryRateHistory(
	_input: TInputGetTreasuryRateHistory,
	_deps: TDepsTreasury,
) {
	const input = ZInputGetTreasuryRateHistory.parse(_input);
	const { env } = _deps;
	const curve = input.curve ?? "zero";

	if (input.from > input.to) {
		return {
			ok: false as const,
			error: "bad_range",
			message: `"from" (${input.from}) is after "to" (${input.to}).`,
		};
	}
	if (input.from < coverageStart) {
		return {
			ok: false as const,
			error: "before_coverage",
			message: `Safe Rate's fitted Treasury history starts ${coverageStart}, so ${input.from} is outside it. Ask from ${coverageStart} onward. The start date is not arbitrary — it is where the underlying daily price series begins.`,
		};
	}

	const range = { env, from: input.from, to: input.to };
	// The generic is spelled out because the three series return DIFFERENT row
	// shapes — the money-market rows carry a nested `rates` array and fit
	// diagnostics that the zero rows do not — and inference would otherwise pin
	// the union to whichever branch is written first.
	const series = await runTreasury<
		| Awaited<ReturnType<typeof getMoneyMarketSeries>>
		| Awaited<ReturnType<typeof getRealCurveSeries>>
		| Awaited<ReturnType<typeof getZeroCurveSeries>>
	>(() => {
		if (curve === "money_market") return getMoneyMarketSeries(range);
		if (curve === "real") return getRealCurveSeries(range);
		return getZeroCurveSeries(range);
	});
	if (_isFailure(series)) return series;

	const rows = Array.isArray(series) ? series : [];
	if (rows.length === 0) {
		return noData(`${curve} curve history`, `${input.from} to ${input.to}`);
	}

	return {
		ok: true,
		curve,
		from: input.from,
		to: input.to,
		trading_days: rows.length,
		what_this_is: _describe(curve),
		series: snakeKeys(rows),
		disclosure: DISCLOSURE_TREASURY,
		next_steps: {
			curve_page_url: TREASURY_URLS.curves,
			methodology_url: TREASURY_URLS.methodology,
		},
	};
}

function _describe(curve: "money_market" | "real" | "zero") {
	if (curve === "money_market") {
		return "The money-market curve, which covers the short end below one year. It is a different fit on different instruments than the zero curve, not a continuation of it — the two are not interchangeable at the overlap.";
	}
	if (curve === "real") {
		return "The TIPS real curve. Yields sit ABOVE inflation rather than including it, so they are not comparable to nominal yields without the breakeven.";
	}
	return "The fitted nominal zero-coupon (spot) curve — the standard answer to 'what was the N-year Treasury yield on this date'.";
}

function _isFailure(value: unknown): value is { ok: false } {
	return (
		typeof value === "object" &&
		value !== null &&
		"ok" in value &&
		(value as { ok: unknown }).ok === false
	);
}

export { ZInputGetTreasuryRateHistory };
