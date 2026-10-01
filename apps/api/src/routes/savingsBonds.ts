import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { snakeKeys } from "@markets/mcp-tools";
import {
	getSavingsBondRates,
	valueEeBond,
	valueIBond,
} from "@saferate/treasury-client/client";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { GATE_RESPONSES, ZError } from "../lib/errors";
import { treasuryErrorResponse, treasuryUnbound } from "../lib/treasury";

/**
 * Savings bonds: the published rate tables, and what a Series I or Series EE
 * bond bought on one date is worth on another. The MCP tools
 * get_savings_bond_rates and value_savings_bond call the same client
 * functions. Pinned by tests/savingsBonds.test.ts on production outputs.
 */

const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const todayIso = () => new Date().toISOString().slice(0, 10);

const ZRate = z
	.object({
		series: z.string(),
		period_start: z.string().openapi({
			description:
				"Rates announced for bonds bought from this date (1 May, 1 November).",
		}),
		composite_percent: z.number().openapi({
			description: "What the bond pays for the current six-month period only.",
		}),
		fixed_percent: z.number().openapi({
			description:
				"Series I: set at purchase and kept for the bond's life. Compare vintages on this.",
		}),
		semiannual_inflation_percent: z.number().nullable().openapi({
			description: "Series I only; null for EE.",
		}),
	})
	.strict()
	.openapi("SavingsBondRate");

export const ZSavingsBondRatesOut = z
	.object({
		on: z.string(),
		series_i: ZRate.nullable(),
		series_ee: ZRate.nullable(),
		series_i_history: z.array(ZRate).openapi({
			description: "Every Series I rate period started by `on`, oldest first.",
		}),
	})
	.strict()
	.openapi("SavingsBondRates");

const redemption = {
	on: z.string(),
	purchased: z.string().openapi({
		description:
			"The bond's ISSUE date. A year read off the face instead gives the wrong schedule.",
	}),
	principal: z.number(),
	accrued_value: z.number(),
	redemption_value: z.number().nullable().openapi({
		description:
			"What the holder would receive: accrued value less any penalty. Null inside the first twelve months, when it cannot be redeemed at all.",
	}),
	penalty_months: z.number().int(),
	penalty_amount: z.number().openapi({
		description:
			"Under five years old, the last three months of interest are forfeit.",
	}),
	is_redeemable: z.boolean(),
	redeemable_from: z.string(),
	has_matured: z.boolean(),
	final_maturity: z.string(),
};

export const ZIBondValueOut = z
	.object({
		...redemption,
		completed_periods: z.number().int(),
		months_into_current_period: z.number().int(),
		value_at_last_completed_period: z.number(),
		current_period: z
			.object({
				earning_period_start: z.string(),
				earning_period_end: z.string(),
				composite_rate: z.number().openapi({ description: "Decimal, annualized." }),
				fixed_rate: z.number().openapi({ description: "Decimal." }),
				semiannual_inflation_rate: z.number().openapi({ description: "Decimal." }),
				fixed_rate_set_on: z.string(),
				inflation_rate_set_on: z.string(),
			})
			.strict()
			.nullable(),
	})
	.strict()
	.openapi("SeriesIValuation");

export const ZEeBondValueOut = z
	.object({
		...redemption,
		cohort: z.string().openapi({
			description: "The issue window whose rate rules the bond follows.",
		}),
		rate_percent: z.number(),
		annualised_yield_percent: z.number(),
		doubling_years: z.number(),
		guarantee_date: z.string().openapi({
			description: "When Treasury guarantees the bond is worth double its price.",
		}),
		guarantee_uplift: z.number().openapi({
			description:
				"What the doubling guarantee adds on that date, over the rate alone.",
		}),
		has_guarantee_applied: z.boolean(),
		is_rate_assumed_after_twenty: z.boolean().openapi({
			description:
				"Past twenty years the rate is not yet announced; true when the value assumes the current one continues.",
		}),
	})
	.strict()
	.openapi("SeriesEEValuation");

const ratesRoute = createRoute({
	method: "get",
	path: "/v1/savings-bonds/rates",
	summary: "Series I and EE savings bond rates",
	description:
		"The rates in force for bonds bought on `on` (default today), and every Series I period since 1998. A Series I composite rate is a fixed rate kept for life plus an inflation rate reset every six months; a Series EE bond earns a fixed rate, but the doubling guarantee at twenty years usually matters more.",
	tags: ["Savings bonds"],
	request: { query: z.object({ on: zIsoDate.optional() }) },
	responses: {
		...GATE_RESPONSES,
		200: {
			content: { "application/json": { schema: ZSavingsBondRatesOut } },
			description: "The rates.",
		},
		400: {
			content: { "application/json": { schema: ZError } },
			description: "Malformed date.",
		},
		404: {
			content: { "application/json": { schema: ZError } },
			description: "No rate tables or valuation are available.",
		},
		503: {
			content: { "application/json": { schema: ZError } },
			description: "The Treasury data service is unavailable.",
		},
	},
});

const valueQuery = z.object({
	purchased: zIsoDate.openapi({
		description: "Issue date.",
		example: "2022-05-01",
	}),
	valued_on: zIsoDate.optional().openapi({ description: "Default today." }),
	denomination: z.coerce.number().positive().optional().openapi({
		description: "Face amount paid. Default 100.",
		example: 1000,
	}),
});

const valueRoute = (series: "i" | "ee") =>
	createRoute({
		method: "get",
		path: `/v1/savings-bonds/${series}/value`,
		summary: `Value a Series ${series.toUpperCase()} savings bond`,
		description: `What a Series ${series.toUpperCase()} bond issued on \`purchased\` is worth on \`valued_on\`: accrued value, and what redeeming it would actually pay after the early-redemption penalty.`,
		tags: ["Savings bonds"],
		request: { query: valueQuery },
		responses: {
			...GATE_RESPONSES,
			200: {
				content: {
					"application/json": {
						schema: series === "i" ? ZIBondValueOut : ZEeBondValueOut,
					},
				},
				description: "The valuation.",
			},
			400: {
				content: { "application/json": { schema: ZError } },
				description:
					"Malformed inputs, or a date pair the series cannot value (before the series began, say). `is_correctable` says whether different inputs can succeed.",
			},
			404: {
				content: { "application/json": { schema: ZError } },
				description: "No valuation is available.",
			},
			503: {
				content: { "application/json": { schema: ZError } },
				description: "The Treasury data service is unavailable.",
			},
		},
	});

type TValued =
	| { ok: true; value: unknown }
	| { ok: false; code: string; isCorrectable: boolean; reason: string }
	| null;

const refusal = (
	c: Context<AppEnv>,
	refused: { code: string; isCorrectable: boolean; reason: string },
) =>
	c.json(
		{
			error: "bad_request" as const,
			code: refused.code,
			is_correctable: refused.isCorrectable,
			message: refused.reason,
		},
		400,
	);

const noValuation = (c: Context<AppEnv>) =>
	c.json({ error: "no_data" as const, message: "No valuation." }, 404);

export const registerSavingsBondRoutes = (app: OpenAPIHono<AppEnv>) => {
	app.openapi(ratesRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const on = c.req.valid("query").on ?? todayIso();
		try {
			const rates = await getSavingsBondRates({ env: c.env, on });
			if (rates === null) return noValuation(c);
			return c.json(
				ZSavingsBondRatesOut.parse({
					on,
					series_i: snakeKeys(rates.i),
					series_ee: snakeKeys(rates.ee),
					series_i_history: snakeKeys(rates.iHistory),
				}),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});

	app.openapi(valueRoute("i"), async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const q = c.req.valid("query");
		try {
			const valued = (await valueIBond({
				env: c.env,
				on: q.valued_on,
				principal: q.denomination,
				purchased: q.purchased,
			})) as TValued;
			if (valued === null) return noValuation(c);
			if (!valued.ok) return refusal(c, valued);
			return c.json(ZIBondValueOut.parse(snakeKeys(valued.value)), 200);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});

	app.openapi(valueRoute("ee"), async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const q = c.req.valid("query");
		try {
			const valued = (await valueEeBond({
				env: c.env,
				on: q.valued_on,
				principal: q.denomination,
				purchased: q.purchased,
			})) as TValued;
			if (valued === null) return noValuation(c);
			if (!valued.ok) return refusal(c, valued);
			return c.json(ZEeBondValueOut.parse(snakeKeys(valued.value)), 200);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});
};
