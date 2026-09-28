import {
	DISCLOSURE_TREASURY,
	noData,
	runTreasury,
	snakeKeys,
	TREASURY_URLS,
	type TDepsTreasury,
} from "./shared";
import {
	getCusipsPricedOn,
	getLatestPriceDate,
	getLiveSecuritiesOn,
	getRunStatusOn,
} from "@saferate/treasury-client/client";
import { z } from "zod";

/**
 * `list_treasury_securities` — what existed, and what was on the run, on a day.
 *
 * This is the tool that answers "the current 10-year", which is the way almost
 * everyone refers to a Treasury and which is not a CUSIP. On-the-run status is
 * the bridge: for each tenor it names the most recently auctioned security, so
 * an assistant can get from a phrase to an identifier and then to
 * get_treasury_security.
 *
 * ⚠️ `basis` CHANGES THE ANSWER around an auction. A security is auctioned days
 * before it is issued, so between those two dates the auction basis already
 * calls the new one on-the-run while the issue basis still names the old one.
 * Neither is wrong — traders mean the auction basis, settlement means the issue
 * basis — so the tool returns which one it used rather than picking silently.
 * Default is `issue`, matching the package and the website.
 */

const ZInputListTreasurySecurities = z.object({
	basis: z.enum(["auction", "issue"]).optional(),
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
	include: z
		.array(z.enum(["cusips_only", "on_the_run", "outstanding"]))
		.optional(),
});
type TInputListTreasurySecurities = z.input<
	typeof ZInputListTreasurySecurities
>;

export async function listTreasurySecurities(
	_input: TInputListTreasurySecurities,
	_deps: TDepsTreasury,
) {
	const input = ZInputListTreasurySecurities.parse(_input);
	const { env } = _deps;
	const include = new Set(input.include ?? ["on_the_run"]);

	// Default to the last day WITH PRICES rather than to today, for the same
	// reason the curve tool does: most calendar days are not trading days.
	let date = input.date;
	if (date === undefined) {
		const latest = await runTreasury(() => getLatestPriceDate({ env }));
		if (_isFailure(latest)) return latest;
		if (typeof latest !== "string") {
			return noData("priced Treasury securities on any date");
		}
		date = latest;
	}

	const result: Record<string, unknown> = {
		ok: true,
		date,
		is_latest_priced_day: input.date === undefined,
	};

	if (include.has("on_the_run")) {
		const basis = input.basis ?? "issue";
		const runStatus = await runTreasury(() =>
			getRunStatusOn({ basis, date, env }),
		);
		if (_isFailure(runStatus)) return runStatus;
		result.on_the_run =
			runStatus === null
				? null
				: {
						...(snakeKeys(runStatus) as Record<string, unknown>),
						basis_note:
							basis === "auction"
								? "Auction basis: a security becomes on-the-run when it is AUCTIONED. This is what market commentary means by 'the new 10-year'."
								: "Issue basis: a security becomes on-the-run when it SETTLES. Between auction and issue this still names the previous security; pass basis 'auction' for the trading convention.",
					};
	}

	if (include.has("outstanding")) {
		const live = await runTreasury(() => getLiveSecuritiesOn({ env, on: date }));
		if (_isFailure(live)) return live;
		const rows = Array.isArray(live) ? live : [];
		result.outstanding_securities = {
			count: rows.length,
			securities: snakeKeys(rows),
			note:
				"Every Treasury security outstanding and priced on this date, with its family, coupon and maturity. This is a long list — the full outstanding stock runs to several hundred securities.",
		};
	}

	if (include.has("cusips_only")) {
		const cusips = await runTreasury(() => getCusipsPricedOn({ env, on: date }));
		if (_isFailure(cusips)) return cusips;
		const rows = Array.isArray(cusips) ? cusips : [];
		result.priced_cusips = { count: rows.length, cusips: rows };
	}

	return {
		...result,
		disclosure: DISCLOSURE_TREASURY,
		next_steps: {
			on_the_run_url: TREASURY_URLS.onTheRun,
			securities_url: TREASURY_URLS.securities,
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

export { ZInputListTreasurySecurities };
