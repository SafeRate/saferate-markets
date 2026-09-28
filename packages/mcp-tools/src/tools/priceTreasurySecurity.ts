import {
	DISCLOSURE_TREASURY,
	noData,
	readableOutage,
	snakeKeys,
	TREASURY_URLS,
	type TDepsTreasury,
} from "./shared";
import {
	priceBill,
	priceCouponSecurity,
} from "@saferate/treasury-client/client";
import { z } from "zod";

/**
 * `price_treasury_security` — convert between price and yield.
 *
 * Two instruments, because the maths genuinely differs: a bill is a discount
 * instrument with no coupon, a note/bond is a coupon instrument with accrued
 * interest and a dirty price. Passing bill inputs to the coupon pricer produces
 * a plausible wrong number rather than an error, so the instrument is explicit.
 *
 * EXACTLY ONE SIDE OF THE CONVERSION IS SUPPLIED, never both. Give a price and
 * the tool returns the yield; give a yield (or a bill's discount rate) and it
 * returns the price. Supplying both is rejected rather than silently preferring
 * one, because "price it at 99-16 and 4.2%" is a contradiction the caller needs
 * to resolve, not a request. That rule is enforced in the package schema too;
 * it is repeated here so a bad combination costs no round trip.
 *
 * For a coupon security a CUSIP substitutes for the terms — the pricer looks up
 * the coupon, maturity and frequency rather than making the caller restate them.
 */

const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ZInputPriceTreasurySecurity = z.object({
	clean_price: z.number().positive().optional(),
	coupon_rate_percent: z.number().min(0).optional(),
	cusip: z.string().optional(),
	discount_rate_percent: z.number().optional(),
	frequency: z.number().int().positive().optional(),
	instrument: z.enum(["bill", "coupon"]),
	maturity_date: zIsoDate.optional(),
	trade_date: zIsoDate.optional(),
	yield_percent: z.number().optional(),
});
type TInputPriceTreasurySecurity = z.input<typeof ZInputPriceTreasurySecurity>;

export async function priceTreasurySecurity(
	_input: TInputPriceTreasurySecurity,
	_deps: TDepsTreasury,
) {
	const input = ZInputPriceTreasurySecurity.parse(_input);
	const { env } = _deps;

	if (input.instrument === "bill") {
		const hasRate = input.discount_rate_percent !== undefined;
		const hasPrice = input.clean_price !== undefined;
		if (hasRate === hasPrice) {
			return _badPair("a bill", "discount_rate_percent", "clean_price", hasRate);
		}
		if (input.maturity_date === undefined) {
			return {
				ok: false as const,
				error: "missing_maturity",
				message:
					"Pricing a bill needs maturity_date — the discount is earned over the days remaining, so there is no price without it.",
			};
		}
		const priced = await _price(() =>
			priceBill({
				discountRatePercent: input.discount_rate_percent,
				env,
				maturityDate: input.maturity_date as string,
				price: input.clean_price,
				tradeDate: input.trade_date,
			}),
		);
		if (_isFailure(priced)) return priced;
		if (priced === null) return noData("bill valuation", input.maturity_date);
		return _ok("bill", priced, input.trade_date);
	}

	const hasYield = input.yield_percent !== undefined;
	const hasPrice = input.clean_price !== undefined;
	if (hasYield === hasPrice) {
		return _badPair("a note or bond", "yield_percent", "clean_price", hasYield);
	}
	if (
		input.cusip === undefined &&
		(input.coupon_rate_percent === undefined || input.maturity_date === undefined)
	) {
		return {
			ok: false as const,
			error: "missing_terms",
			message:
				"Pricing a coupon security needs either a cusip, or both coupon_rate_percent and maturity_date. With a CUSIP the terms are looked up, which is the safer route — a hand-entered coupon that disagrees with the real one prices a bond that does not exist.",
		};
	}

	const priced = await _price(() =>
		priceCouponSecurity({
			cleanPrice: input.clean_price,
			couponRatePercent: input.coupon_rate_percent,
			cusip: input.cusip?.trim().toUpperCase(),
			env,
			frequency: input.frequency,
			maturityDate: input.maturity_date,
			tradeDate: input.trade_date,
			yieldPercent: input.yield_percent,
		}),
	);
	if (_isFailure(priced)) return priced;
	if (priced === null) {
		return noData("valuation for that security", input.trade_date);
	}
	return _ok("coupon", priced, input.trade_date);
}

/**
 * Unwraps the pricer's own envelope.
 *
 * `priceBill` and `priceCouponSecurity` go through the same refusal-catching
 * wrapper the savings-bond valuers do, so they return `{ ok, value }` rather
 * than the value — and nesting that inside this tool's own envelope handed the
 * model `result.ok.value`, two `ok` flags deep, with the failure case carrying
 * `code`/`reason` where every other tool here says `error`/`message`.
 *
 * NOT wrapped in runTreasury for the same reason the bond valuers are not: a
 * refusal never escapes them, so the wrapper's catch is unreachable.
 */
const _price = async <T>(
	run: () => Promise<
		| { ok: true; value: T }
		| { code: string; isCorrectable: boolean; ok: false; reason: string }
		| null
	>,
) => {
	let result: Awaited<ReturnType<typeof run>>;
	try {
		result = await run();
	} catch (error) {
		// Same reasoning as valueSavingsBond: refusals are caught inside, an
		// outage is not, and a raw Response reads as "[object Response]".
		throw readableOutage(error);
	}
	if (result === null) return null;
	if (result.ok) return result.value;
	return {
		ok: false as const,
		error: result.code,
		is_correctable: result.isCorrectable,
		message: result.isCorrectable
			? `${result.reason} Adjust the inputs and try again.`
			: `${result.reason} This is not a fixable argument.`,
	};
};

function _ok(
	instrument: "bill" | "coupon",
	priced: unknown,
	tradeDate: string | undefined,
) {
	return {
		ok: true as const,
		instrument,
		trade_date: tradeDate ?? "most recent trading day",
		result: snakeKeys(priced),
		what_this_is:
			instrument === "bill"
				? "A bill has no coupon: the return is the discount between price and par at maturity. Both the bank-discount rate (the quoting convention) and the investment rate (the comparable yield) are returned, and they are NOT the same number."
				: "A coupon security accrues interest between payment dates. The clean price excludes that accrual and is the quoted price; the dirty price includes it and is what actually settles.",
		disclosure: DISCLOSURE_TREASURY,
		next_steps: { calculator_url: TREASURY_URLS.calculator },
	};
}

function _badPair(
	what: string,
	rateField: string,
	priceField: string,
	bothGiven: boolean,
) {
	return {
		ok: false as const,
		error: "bad_input_pair",
		message: bothGiven
			? `Pricing ${what} takes exactly one of ${rateField} or ${priceField} — you supplied both, and they may disagree. Send the one you know and the tool returns the other.`
			: `Pricing ${what} takes exactly one of ${rateField} or ${priceField}, and you supplied neither.`,
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

export { ZInputPriceTreasurySecurity };
