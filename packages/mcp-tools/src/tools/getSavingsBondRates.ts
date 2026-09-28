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
	getEeBondRates,
	getSavingsBondRates as getRates,
	getSavingsBondStock,
	getTreasuryDirectSales,
} from "@saferate/treasury-client/client";
import { z } from "zod";

/**
 * `get_savings_bond_rates` — the rate tables behind a savings bond, and how
 * many of them the public holds.
 *
 * The companion to value_savings_bond: that one values a specific bond, this
 * one answers "what does an I bond pay right now" and "is anyone buying them".
 *
 * ⚠️ AN I BOND'S HEADLINE RATE IS NOT WHAT A HOLDER EARNS FOR A YEAR. The
 * composite rate combines a permanent fixed rate with an inflation rate that is
 * RESET EVERY SIX MONTHS, so the advertised number applies for six months and
 * then changes. Two holders buying in different months are on different
 * schedules for the life of the bond. The fixed component is the part worth
 * comparing between vintages, and it is returned separately for that reason.
 */

const ZInputGetSavingsBondRates = z.object({
	include: z
		.array(z.enum(["ee_cohorts", "public_holdings", "sales"]))
		.optional(),
	on: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
});
type TInputGetSavingsBondRates = z.input<typeof ZInputGetSavingsBondRates>;

export async function getSavingsBondRates(
	_input: TInputGetSavingsBondRates,
	_deps: TDepsTreasury,
) {
	const input = ZInputGetSavingsBondRates.parse(_input);
	const { env } = _deps;
	const include = new Set(input.include ?? []);
	const on = input.on ?? todayIso();

	const rates = await runTreasury(() => getRates({ env, on }));
	if (_isFailure(rates)) return rates;
	if (rates === null) return noData("savings bond rate tables", on);

	const result: Record<string, unknown> = {
		ok: true,
		as_of: on,
		series_i: {
			current: snakeKeys(rates.i),
			history: snakeKeys(rates.iHistory),
			how_it_works:
				"A Series I composite rate = a fixed rate set at purchase and kept for the life of the bond + an inflation rate reset every six months. The composite figure is what the bond pays for the CURRENT six-month period only. When comparing vintages, compare the fixed rate — it is the part that does not change.",
		},
		series_ee: {
			current: snakeKeys(rates.ee),
			how_it_works:
				"A Series EE bond earns a fixed rate, but the rule that usually matters more is the Treasury guarantee that the bond doubles in value at 20 years. For a bond held toward that mark the guarantee, not the stated rate, sets the return.",
		},
	};

	if (include.has("ee_cohorts")) {
		const cohorts = await runTreasury(() => getEeBondRates({ env }));
		if (_isFailure(cohorts)) return cohorts;
		result.ee_rate_cohorts = {
			cohorts: snakeKeys(cohorts),
			note:
				"EE rate rules changed several times since 1995, so bonds are grouped into cohorts by issue window. A bond's cohort, not the current rate, determines how it earns.",
		};
	}

	if (include.has("public_holdings")) {
		const stock = await runTreasury(() => getSavingsBondStock({ env }));
		if (_isFailure(stock)) return stock;
		result.public_holdings = {
			...(snakeKeys(stock) as Record<string, unknown>),
			note:
				"The face value of savings bonds outstanding, by series. This is stock held by the public, not sales.",
		};
	}

	if (include.has("sales")) {
		const sales = await runTreasury(() => getTreasuryDirectSales({ env }));
		if (_isFailure(sales)) return sales;
		result.treasury_direct_sales = {
			sales: snakeKeys(sales),
			note:
				"Savings bonds sold through TreasuryDirect. Sales spike when the I bond composite rate is high, which is the clearest public signal of retail inflation anxiety in this dataset.",
		};
	}

	return {
		...result,
		disclosure: DISCLOSURE_TREASURY,
		next_steps: {
			savings_bond_page_url: TREASURY_URLS.savingsBonds,
			market_statistics_url: TREASURY_URLS.marketStatistics,
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

export { ZInputGetSavingsBondRates };
