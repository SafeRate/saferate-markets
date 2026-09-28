import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { snakeKeys } from "@markets/mcp-tools";
import {
	priceBill,
	priceCouponSecurity,
} from "@saferate/treasury-client/client";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { GATE_RESPONSES, ZError } from "../lib/errors";
import { treasuryErrorResponse, treasuryUnbound } from "../lib/treasury";

/**
 * The price/yield calculator: a coupon security or a bill, from either side.
 * Upstream does the arithmetic (settlement, accrual, day counts); the MCP tool
 * price_treasury_security calls the same client functions.
 *
 * Pinned by tests/pricing.test.ts on production outputs for 91282CMM0 at its
 * 2026-09-25 close, which reproduce that day's stored analytics exactly
 * (yield 5.138839665382976%, the same DV01 and durations).
 */

const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const ZCouponPriceOut = z
	.object({
		cusip: z.string().nullable(),
		coupon_rate_percent: z.number(),
		maturity_date: z.string(),
		settlement_date: z.string().openapi({
			description: "T+1 from the trade date, on a business day.",
		}),
		clean_price: z
			.number()
			.openapi({ description: "Per 100 face; the quoted price." }),
		accrued_interest: z.number(),
		dirty_price: z
			.number()
			.openapi({ description: "Clean plus accrued: what settles." }),
		yield_to_maturity_percent: z.number(),
		macaulay_duration: z.number(),
		modified_duration: z.number(),
		dv01: z
			.number()
			.openapi({ description: "Price change per 1bp, per 100 face." }),
		convexity: z.number().openapi({
			description: "Published convention: textbook convexity / 100.",
		}),
		coupons_remaining: z.number().int(),
		is_final_period: z.boolean(),
	})
	.strict()
	.openapi("CouponPrice");

export const ZBillPriceOut = z
	.object({
		maturity_date: z.string(),
		settlement_date: z.string(),
		days_to_maturity: z.number().int(),
		days_in_year: z.number().int(),
		price: z.number().openapi({ description: "Per 100 face." }),
		discount_rate_percent: z.number().openapi({
			description:
				"Bank-discount rate: the quoting convention, on a 360-day year.",
		}),
		investment_rate_percent: z.number().openapi({
			description:
				"Coupon-equivalent yield: the rate comparable with a note's yield. NOT the same number as the discount rate.",
		}),
	})
	.strict()
	.openapi("BillPrice");

const RESPONSES_4XX = {
	400: {
		content: { "application/json": { schema: ZError } },
		description:
			"Missing or conflicting inputs, or inputs the calculator refused (a date outside the security's life, say). `is_correctable` says whether changing them can help.",
	},
	404: {
		content: { "application/json": { schema: ZError } },
		description: "No such CUSIP, or no price data to value on.",
	},
	503: {
		content: { "application/json": { schema: ZError } },
		description: "The Treasury data service is unavailable.",
	},
};

const couponRoute = createRoute({
	method: "get",
	path: "/v1/price/coupon",
	summary: "Price or yield a note or bond",
	description:
		"Give exactly one of `clean_price` or `yield_percent`, and either a `cusip` (terms looked up: the safer route) or both `coupon_rate_percent` and `maturity_date`. Returns the other side with accrued interest, durations, DV01 and convexity. `trade_date` defaults to the most recent trading day.",
	tags: ["Calculators"],
	request: {
		query: z.object({
			cusip: z
				.string()
				.regex(/^[0-9A-Za-z]{9}$/, "a CUSIP is 9 letters and digits")
				.optional()
				.openapi({ example: "91282CMM0" }),
			clean_price: z.coerce
				.number()
				.positive()
				.optional()
				.openapi({ example: 96.53125 }),
			yield_percent: z.coerce.number().optional(),
			coupon_rate_percent: z.coerce.number().min(0).optional(),
			maturity_date: zIsoDate.optional(),
			frequency: z.coerce.number().int().positive().optional().openapi({
				description: "Coupons a year, for hand-entered terms. Default 2.",
			}),
			trade_date: zIsoDate.optional().openapi({ example: "2026-09-25" }),
		}),
	},
	responses: {
		...GATE_RESPONSES,
		200: {
			content: { "application/json": { schema: ZCouponPriceOut } },
			description: "The valuation.",
		},
		...RESPONSES_4XX,
	},
});

const billRoute = createRoute({
	method: "get",
	path: "/v1/price/bill",
	summary: "Price or yield a Treasury bill",
	description:
		"Give `maturity_date` and exactly one of `discount_rate_percent` or `price`. Returns both the bank-discount rate and the investment rate, which differ. `trade_date` defaults to the most recent trading day.",
	tags: ["Calculators"],
	request: {
		query: z.object({
			maturity_date: zIsoDate.openapi({ example: "2027-03-18" }),
			discount_rate_percent: z.coerce.number().optional().openapi({ example: 4 }),
			price: z.coerce.number().positive().optional(),
			trade_date: zIsoDate.optional(),
		}),
	},
	responses: {
		...GATE_RESPONSES,
		200: {
			content: { "application/json": { schema: ZBillPriceOut } },
			description: "The valuation.",
		},
		...RESPONSES_4XX,
	},
});

const badRequest = (c: Context<AppEnv>, message: string) =>
	c.json({ error: "bad_request" as const, message }, 400);

const noValuation = (c: Context<AppEnv>, what: string) =>
	c.json({ error: "no_data" as const, message: `No ${what}.` }, 404);

/** An upstream refusal, carried as data by the client, as a 400. */
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

export const registerPricingRoutes = (app: OpenAPIHono<AppEnv>) => {
	app.openapi(couponRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const q = c.req.valid("query");
		if ((q.clean_price === undefined) === (q.yield_percent === undefined))
			return badRequest(c, "Give exactly one of clean_price or yield_percent.");
		if (
			q.cusip === undefined &&
			(q.coupon_rate_percent === undefined || q.maturity_date === undefined)
		)
			return badRequest(
				c,
				"Give a cusip, or both coupon_rate_percent and maturity_date. A CUSIP is safer: a hand-entered coupon that disagrees with the real one prices a bond that does not exist.",
			);
		try {
			const priced = await priceCouponSecurity({
				cleanPrice: q.clean_price,
				couponRatePercent: q.coupon_rate_percent,
				cusip: q.cusip?.toUpperCase(),
				env: c.env,
				frequency: q.frequency,
				maturityDate: q.maturity_date,
				tradeDate: q.trade_date,
				yieldPercent: q.yield_percent,
			});
			if (priced === null) return noValuation(c, "valuation for that security");
			if (!priced.ok) return refusal(c, priced);
			return c.json(ZCouponPriceOut.parse(snakeKeys(priced.value)), 200);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});

	app.openapi(billRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const q = c.req.valid("query");
		if ((q.discount_rate_percent === undefined) === (q.price === undefined))
			return badRequest(c, "Give exactly one of discount_rate_percent or price.");
		try {
			const priced = await priceBill({
				discountRatePercent: q.discount_rate_percent,
				env: c.env,
				maturityDate: q.maturity_date,
				price: q.price,
				tradeDate: q.trade_date,
			});
			if (priced === null) return noValuation(c, "valuation for that bill");
			if (!priced.ok) return refusal(c, priced);
			return c.json(ZBillPriceOut.parse(snakeKeys(priced.value)), 200);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});
};
