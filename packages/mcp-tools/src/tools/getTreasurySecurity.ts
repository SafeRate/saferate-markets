import {
	DISCLOSURE_TREASURY,
	runTreasury,
	snakeKeys,
	todayIso,
	TREASURY_URLS,
	type TDepsTreasury,
} from "./shared";
import {
	getSecurity,
	getSecurityOutstanding,
} from "@saferate/treasury-client/client";
import { z } from "zod";

/**
 * `get_treasury_security` — one security, by CUSIP.
 *
 * Returns its terms, its price history, its analytics (duration, convexity,
 * DV01, key-rate durations) and, for the two families that have their own, the
 * TIPS and FRN analytics as well.
 *
 * ⚠️ THE HISTORY IS CAPPED UPSTREAM AND SAYS SO IN A FLAG, NOT IN ITS LENGTH.
 * `is_price_history_truncated` / `is_analytics_history_truncated` are returned
 * verbatim because a truncated series looks exactly like a short one: a bond
 * issued in 2010 whose history begins in 2019 has been cut, and an assistant
 * that reads the first row as the issue date will state a wrong fact
 * confidently. When the flag is set, the series is the MOST RECENT window, not
 * the whole life of the bond.
 *
 * `summarize: true` drops the two long arrays. A single 30-year bond carries
 * thousands of daily rows, which is the right payload for a chart and the wrong
 * one for a model that was asked what the coupon is.
 */

const ZInputGetTreasurySecurity = z.object({
	cusip: z.string().min(1),
	outstanding_on: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
	summarize: z.boolean().optional(),
});
type TInputGetTreasurySecurity = z.input<typeof ZInputGetTreasurySecurity>;

export async function getTreasurySecurity(
	_input: TInputGetTreasurySecurity,
	_deps: TDepsTreasury,
) {
	const input = ZInputGetTreasurySecurity.parse(_input);
	const { env } = _deps;
	const cusip = input.cusip.trim().toUpperCase();

	if (!/^[0-9A-Z]{9}$/.test(cusip)) {
		return {
			ok: false as const,
			error: "bad_cusip",
			message: `"${input.cusip}" is not a CUSIP. A Treasury CUSIP is exactly nine alphanumeric characters, e.g. "91282CJL6". If you have a description rather than an identifier ("the current 10-year"), use list_treasury_securities to find it.`,
		};
	}

	const security = await runTreasury(() => getSecurity({ cusip, env }));
	if (_isFailure(security)) return security;
	if (security === null) {
		return {
			ok: false as const,
			error: "unknown_cusip",
			message: `No Treasury security with CUSIP ${cusip}. It may be a non-Treasury security, or one that matured before Safe Rate's coverage.`,
		};
	}

	const outstandingOn = input.outstanding_on ?? todayIso();
	const outstanding = await runTreasury(() =>
		getSecurityOutstanding({ cusip, env, on: outstandingOn }),
	);
	if (_isFailure(outstanding)) return outstanding;

	const summarize = input.summarize ?? false;
	const full = snakeKeys(security) as Record<string, unknown>;
	if (summarize) {
		full.analytics = undefined;
		full.prices = undefined;
		full.frn_analytics = undefined;
		full.tips_analytics = undefined;
		full.history_omitted =
			"Daily price and analytics series were omitted because summarize was true. The latest_* fields are still present. Call again with summarize false for the full series.";
	}

	return {
		ok: true,
		cusip,
		security: full,
		amount_outstanding:
			outstanding === null
				? null
				: {
						...(snakeKeys(outstanding) as Record<string, unknown>),
						as_of: outstandingOn,
						note:
							"Read from the month-end statement IN FORCE on the date asked, not one matching it, so a mid-month date returns the prior month-end figure. `stripped` is the portion held in STRIPS form.",
					},
		disclosure: DISCLOSURE_TREASURY,
		next_steps: {
			security_page_url: `${TREASURY_URLS.securities}/${cusip}`,
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

export { ZInputGetTreasurySecurity };
