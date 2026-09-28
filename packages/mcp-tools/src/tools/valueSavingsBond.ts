import {
	DISCLOSURE_TREASURY,
	noData,
	readableOutage,
	snakeKeys,
	TREASURY_URLS,
	type TDepsTreasury,
} from "./shared";
import { valueEeBond, valueIBond } from "@saferate/treasury-client/client";
import { z } from "zod";

/**
 * `value_savings_bond` — what a paper or electronic savings bond is worth today.
 *
 * The most consumer-facing thing in the Treasury dataset, and the one a person
 * is most likely to ask an assistant about: they have a bond from a grandparent
 * and want a number.
 *
 * ⚠️ THREE RULES THAT MAKE THE ANSWER WRONG IF THEY ARE NOT SAID, all returned
 * in-band because a model asked "what's it worth" will otherwise report the
 * redemption value flat:
 *
 * 1. **Under five years, redeeming forfeits three months of interest.** The
 *    package returns the penalty; a value quoted without it overstates what the
 *    holder actually receives today.
 * 2. **Under twelve months a bond cannot be redeemed at all.** The value is
 *    real but not yet reachable.
 * 3. **The purchase date is the ISSUE date, not the date printed as the
 *    "series" year.** Getting this wrong shifts the whole rate schedule.
 *
 * COVERAGE REACHES BACK FURTHER THAN THE CURVE HISTORY. Series I opened in
 * September 1998 and EE rules reach to 1995 — both long before the 2008 price
 * series — so the usual coverage floor does not apply here. Upstream refuses
 * what it cannot value and the refusal text explains why.
 */

const ZInputValueSavingsBond = z.object({
	denomination: z.number().positive().optional(),
	purchased: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	series: z.enum(["EE", "I"]),
	valued_on: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
});
type TInputValueSavingsBond = z.input<typeof ZInputValueSavingsBond>;

export async function valueSavingsBond(
	_input: TInputValueSavingsBond,
	_deps: TDepsTreasury,
) {
	const input = ZInputValueSavingsBond.parse(_input);
	const { env } = _deps;

	const args = {
		env,
		on: input.valued_on,
		principal: input.denomination,
		purchased: input.purchased,
	};
	// NOT wrapped in runTreasury, unlike every other treasury tool here. These
	// two catch their own refusals and hand them back as data, so the wrapper's
	// catch branch is unreachable and only widens the type with a failure shape
	// that can never arrive. A transport error still throws, which is what the
	// other tools do with one too.
	let valued: Awaited<ReturnType<typeof valueEeBond | typeof valueIBond>>;
	try {
		valued =
			input.series === "I" ? await valueIBond(args) : await valueEeBond(args);
	} catch (error) {
		// A refusal never reaches here — these two catch their own. A genuine
		// outage does, and it arrives as a thrown Response that the MCP SDK
		// renders as the literal "[object Response]". Made readable on the way
		// past, still thrown, because an outage must not read as "no data".
		throw readableOutage(error);
	}
	if (valued === null) {
		return noData(
			`Series ${input.series} valuation`,
			`a bond purchased ${input.purchased}`,
		);
	}

	// These two functions catch their OWN refusals rather than throwing them, so
	// runTreasury never sees one and the envelope arrives here as data. It is
	// translated rather than passed through: `isCorrectable` is the useful half
	// — it distinguishes a date the caller can fix from a pair the rate tables
	// will never answer for, which is the difference between "ask again" and
	// "stop asking".
	if (!valued.ok) {
		return {
			ok: false as const,
			error: valued.code,
			is_correctable: valued.isCorrectable,
			message: valued.isCorrectable
				? `${valued.reason} Check the purchase date and denomination and try again.`
				: `${valued.reason} This is not a fixable argument — no purchase date and valuation date combination will value this bond.`,
		};
	}

	return {
		ok: true,
		series: input.series,
		purchased: input.purchased,
		valued_on: input.valued_on ?? "today",
		valuation: snakeKeys(valued.value),
		how_to_report_this: {
			early_redemption_penalty:
				"A bond less than five years old forfeits the last three months of interest when redeemed. If the valuation carries a penalty figure, state the net amount the holder would receive, not just the accrued value.",
			one_year_lockup:
				"A bond less than twelve months old cannot be redeemed at all. Report the value as accrued-but-not-yet-redeemable rather than as cash available now.",
			purchase_date_meaning:
				"`purchased` is the bond's ISSUE date. If the holder read a year off the face of the bond rather than the issue date, the rate schedule and therefore the value will be wrong — confirm it before relying on the number.",
		},
		disclosure: DISCLOSURE_TREASURY,
		next_steps: { savings_bond_page_url: TREASURY_URLS.savingsBonds },
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

export { ZInputValueSavingsBond };
