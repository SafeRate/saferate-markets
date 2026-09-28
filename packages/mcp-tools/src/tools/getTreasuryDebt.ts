import {
	DISCLOSURE_TREASURY,
	noData,
	runTreasury,
	snakeKeys,
	todayIso,
	TREASURY_URLS,
	type TDepsTreasury,
} from "./shared";
import {
	getDebtSummaryOn,
	getStripsFloat,
} from "@saferate/treasury-client/client";
import { z } from "zod";

/**
 * `get_treasury_debt` — the size and shape of the federal debt, and the STRIPS
 * float within it.
 *
 * ⚠️ "THE NATIONAL DEBT" IS TWO DIFFERENT NUMBERS AND THE GAP IS TRILLIONS.
 * Debt held by the PUBLIC is what was actually borrowed from investors. TOTAL
 * public debt outstanding adds intragovernmental holdings — chiefly the Social
 * Security and federal retirement trust funds, which are the government owing
 * itself. Commentary quotes whichever is more dramatic, usually the total, and
 * an assistant that repeats a headline figure without saying which one it is
 * will be wrong by several trillion dollars. Both are returned, labelled.
 *
 * ⚠️ THE STATEMENT IS MONTH-END AND IS RETURNED BY FORCE, NOT BY MATCH. Any
 * date returns the statement IN FORCE on it, so a mid-month date gives the
 * prior month-end. `as_of` is the date asked; the record date inside the
 * statement is the date the figures describe, and it is the one to quote.
 */

const ZInputGetTreasuryDebt = z.object({
	include_strips: z.boolean().optional(),
	on: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
});
type TInputGetTreasuryDebt = z.input<typeof ZInputGetTreasuryDebt>;

export async function getTreasuryDebt(
	_input: TInputGetTreasuryDebt,
	_deps: TDepsTreasury,
) {
	const input = ZInputGetTreasuryDebt.parse(_input);
	const { env } = _deps;
	const on = input.on ?? todayIso();

	const summary = await runTreasury(() => getDebtSummaryOn({ env, on }));
	if (_isFailure(summary)) return summary;
	if (summary === null) {
		return noData("monthly debt statement in force", on);
	}

	const result: Record<string, unknown> = {
		ok: true,
		asked_for: on,
		debt_summary: snakeKeys(summary),
		how_to_report_this: {
			which_number:
				"Debt held by the public is money actually borrowed from investors. Total public debt outstanding also includes intragovernmental holdings — the government owing its own trust funds. They differ by trillions. Always say which one you are quoting.",
			as_of_meaning:
				"This is the month-end statement IN FORCE on the date asked, not one matching it. Quote the record date inside the statement, not the date you asked for.",
		},
	};

	if (input.include_strips ?? false) {
		const strips = await runTreasury(() => getStripsFloat({ env, on }));
		if (_isFailure(strips)) return strips;
		result.strips_float =
			strips === null
				? null
				: {
						...(snakeKeys(strips) as Record<string, unknown>),
						what_this_is:
							"STRIPS are Treasury securities separated into their individual coupon and principal payments, each traded as its own zero-coupon instrument. The float is how much is currently held in that stripped form — a demand signal for zero-coupon exposure, most often from liability-matching pension buyers.",
					};
	}

	return {
		...result,
		disclosure: DISCLOSURE_TREASURY,
		next_steps: {
			market_statistics_url: TREASURY_URLS.marketStatistics,
			strips_url: TREASURY_URLS.strips,
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

export { ZInputGetTreasuryDebt };
