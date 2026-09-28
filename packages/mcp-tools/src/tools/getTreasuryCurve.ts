import {
	DISCLOSURE_TREASURY,
	coverageStart,
	noData,
	runTreasury,
	snakeKeys,
	TREASURY_URLS,
	type TDepsTreasury,
	type TTreasuryFailure,
} from "./shared";
import {
	getBreakevenOn,
	getCurvesOn,
	getCurvesWithPriorOn,
	getLatestCurve,
	getQueueYields,
	getRealCurveOn,
} from "@saferate/treasury-client/client";
import { z } from "zod";

/**
 * `get_treasury_curve` — the yield curve on one day.
 *
 * ONE DAY, SEVERAL CURVES. Treasury does not publish "the" curve: there is a
 * fitted zero curve, a par curve, a money-market curve for the short end, a
 * real (TIPS) curve, and the breakeven inflation implied by the gap between the
 * last two. They are different fits on different instruments, not variations on
 * one number, so `include` selects among them rather than the tool guessing.
 *
 * WHY `date` IS OPTIONAL AND MEANS "LATEST". Weekends and federal holidays have
 * no curve, so defaulting to today would return nothing roughly a third of the
 * year — and an assistant asked "what are Treasury yields" on a Sunday would
 * report that Safe Rate has no data. Omitting the date asks for the most recent
 * FITTED day, which is the question almost everyone means.
 */

const ZInputGetTreasuryCurve = z.object({
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
	include: z
		.array(z.enum(["breakeven", "prior", "queue_yields", "real", "zero"]))
		.optional(),
	queue_kind: z.enum(["Bill", "Bond", "FRN", "Note", "TIPS"]).optional(),
});
type TInputGetTreasuryCurve = z.input<typeof ZInputGetTreasuryCurve>;

export async function getTreasuryCurve(
	_input: TInputGetTreasuryCurve,
	_deps: TDepsTreasury,
) {
	const input = ZInputGetTreasuryCurve.parse(_input);
	const { env } = _deps;
	const include = new Set(input.include ?? ["zero"]);

	// No date: resolve the latest fitted day first, then answer everything else
	// against THAT day rather than against today. Mixing the two would pair a
	// Friday zero curve with an empty Sunday breakeven and present them as one
	// day's reading.
	let date = input.date;
	if (date === undefined) {
		const latest = await runTreasury(() => getLatestCurve({ env }));
		if (_isFailure(latest)) return latest;
		if (latest === null) {
			return {
				ok: false as const,
				error: "no_data",
				message:
					"Safe Rate has no fitted Treasury curve on any date. That is a service or binding problem rather than a gap in coverage — every business day since " +
					`${coverageStart} should have one.`,
			};
		}
		date = latest.date;
	}

	const curves = await runTreasury(() => getCurvesOn({ date, env }));
	if (_isFailure(curves)) return curves;
	if (curves === null) return noData("curve", date);
	if (!curves.hasAnyCurve) return noData("fitted curve", date);

	const result: Record<string, unknown> = {
		ok: true,
		date,
		is_latest_published: !input.date,
	};

	if (include.has("zero")) {
		result.zero_curve = {
			points: snakeKeys(curves.zero),
			fit_diagnostics: snakeKeys(curves.zeroDiagnostics),
			what_this_is:
				"The fitted zero-coupon (spot) curve — the yield on a single payment at each maturity. This is the curve to read a rate off for a given tenor.",
		};
		result.par_curve = snakeKeys(curves.par);
		result.money_market_curve = snakeKeys(curves.moneyMarket);
		result.nelson_siegel_curve = snakeKeys(curves.lsc);
	}

	if (include.has("real")) {
		const real = await runTreasury(() => getRealCurveOn({ date, env }));
		if (_isFailure(real)) return real;
		result.real_curve =
			real === null
				? null
				: {
						...(snakeKeys(real) as Record<string, unknown>),
						what_this_is:
							"The TIPS (inflation-indexed) curve. Yields are REAL — they sit above inflation rather than including it, and are not comparable to the nominal zero curve without the breakeven below.",
					};
	}

	if (include.has("breakeven")) {
		const breakeven = await runTreasury(() => getBreakevenOn({ date, env }));
		if (_isFailure(breakeven)) return breakeven;
		result.breakeven_inflation =
			breakeven === null
				? null
				: {
						...(snakeKeys(breakeven) as Record<string, unknown>),
						what_this_is:
							"Nominal yield minus real yield at each tenor: the average annual inflation the market would need over that horizon for TIPS and nominal Treasuries to break even. It is an expectation priced by the market, not a forecast Safe Rate makes.",
					};
	}

	if (include.has("prior")) {
		const withPrior = await runTreasury(() =>
			getCurvesWithPriorOn({ date, env }),
		);
		if (_isFailure(withPrior)) return withPrior;
		result.prior_trading_day =
			withPrior === null
				? null
				: {
						date: withPrior.priorDate,
						curves: snakeKeys(withPrior.priorCurves),
						why: "The previous day WITH A FITTED CURVE, which is not the calendar day before — after a long weekend it is three days back. Use it for day-over-day moves.",
					};
	}

	if (include.has("queue_yields")) {
		const kind = input.queue_kind ?? "Note";
		const queue = await runTreasury(() => getQueueYields({ date, env, kind }));
		if (_isFailure(queue)) return queue;
		result.queue_yields = {
			kind,
			...(snakeKeys(queue) as Record<string, unknown>),
			what_this_is:
				"Per-CUSIP yields for outstanding securities of this kind on the date, with each one's residual against the fitted curve. A large residual is a security trading away from the curve, which is a data point about that bond rather than about the curve.",
		};
	}

	return {
		...result,
		disclosure: DISCLOSURE_TREASURY,
		next_steps: {
			curve_page_url: TREASURY_URLS.curves,
			methodology_url: TREASURY_URLS.methodology,
		},
	};
}

/** Narrow the refusal envelope out of a package result. */
function _isFailure(value: unknown): value is TTreasuryFailure {
	return (
		typeof value === "object" &&
		value !== null &&
		"ok" in value &&
		(value as { ok: unknown }).ok === false
	);
}

export { ZInputGetTreasuryCurve };
