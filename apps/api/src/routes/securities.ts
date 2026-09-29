import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
	analyticsBasisFor,
	familyOf,
	readAnalyticsFor,
	readSecurityDetail,
	readSecurityPrices,
	snakeKeys,
} from "@markets/mcp-tools";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { GATE_RESPONSES, ZError } from "../lib/errors";
import { treasuryErrorResponse, treasuryUnbound } from "../lib/treasury";

/**
 * CUSIP lookup: one Treasury security's terms, prices and analytics.
 *
 * Schemas are DECLARED here (the client's are transforms) and pinned by
 * tests/securities.test.ts, which runs real production rows (fetched
 * 2026-09-28: a nominal note, a TIPS, an FRN and a bill) through the shared
 * readers and requires these .strict() schemas to accept them.
 *
 * The conventions below were read from the client's schemas and checked on
 * that data, and are stated in the published descriptions because each is a
 * way to misread the numbers:
 *  - price_residual_cents and residual_basis_points have OPPOSITE signs;
 *  - a null z-score is "not computed", never zero: every bill, and every TIPS
 *    and FRN, has one;
 *  - convexity is the published convention (textbook / 100);
 *  - a null bid or offer means FedInvest posted none that day (stored upstream
 *    as 0, which would read as a price of zero).
 */

const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const ZCusipParam = z.object({
	cusip: z
		.string()
		.regex(/^[0-9A-Za-z]{9}$/, "a CUSIP is 9 letters and digits")
		.openapi({ example: "91282CMM0" }),
});

const ZRange = z.object({
	from: zIsoDate.optional().openapi({ example: "2026-01-01" }),
	to: zIsoDate.optional(),
});

// ── Schemas ──────────────────────────────────────────────────────────────────

const ZAuction = z
	.object({
		auction_date: z.string(),
		issue_date: z.string(),
		original_security_term: z.string(),
		is_reopening: z.boolean(),
		high_yield: z.number().nullable().openapi({ description: "Percent." }),
		bid_to_cover_ratio: z.number().nullable(),
		offering_amount: z.number().nullable(),
		total_accepted: z.number().nullable(),
	})
	.strict();

export const ZSecurityTermsOut = z
	.object({
		detail_security_type: z.string().openapi({ example: "Note" }),
		original_security_term: z.string().openapi({ example: "10-Year" }),
		coupon_percent: z.number().nullable(),
		maturity_date: z.string(),
		dated_date: z.string().nullable(),
		first_interest_payment_date: z.string().nullable(),
		payment_frequency: z.string().nullable(),
		has_floating_rate: z.boolean(),
		spread: z.number().nullable().openapi({
			description: "An FRN's fixed spread over its index. Null for other kinds.",
		}),
		is_callable: z.boolean(),
		auctions: z.array(ZAuction),
	})
	.strict()
	.openapi("SecurityTerms");

export const ZSecurityPriceOut = z
	.object({
		date: z.string(),
		security_type: z.string().openapi({ example: "MARKET BASED NOTE" }),
		coupon_percent: z.number(),
		bid: z.number().nullable().openapi({
			description:
				"Per 100 face, as FedInvest published it. Null when no bid was posted that day (upstream stores 0, which is not a price).",
		}),
		offer: z.number().nullable().openapi({
			description: "Per 100 face. Null when no offer was posted.",
		}),
		close: z.number().openapi({ description: "End-of-day price per 100 face." }),
	})
	.strict()
	.openapi("SecurityPrice");

const ZKeyRate = z
	.object({ label: z.string(), years: z.number(), value: z.number() })
	.strict();

const residualFields = {
	price_residual_cents: z.number().openapi({
		description:
			"Observed price less the price on the fitted zero curve, cents per 100. POSITIVE = RICH (priced above the curve).",
	}),
	residual_basis_points: z.number().nullable().openapi({
		description:
			"The same gap in yield, basis points, with the OPPOSITE sign: POSITIVE = CHEAP. Null close to maturity, where dividing by a near-zero duration makes it meaningless; quote the cents there.",
	}),
	residual_z_score: z.number().nullable().openapi({
		description:
			"The bp residual against this security's OWN history, so it follows the bp sign: positive = unusually cheap. NULL means not computed (every bill, and every TIPS), never zero.",
	}),
};

export const ZNominalAnalyticsOut = z
	.object({
		date: z.string(),
		ytm: z
			.number()
			.nullable()
			.openapi({ description: "Yield to maturity, percent." }),
		dirty_price: z.number(),
		macaulay_duration: z.number(),
		modified_duration: z.number(),
		convexity: z.number().openapi({
			description: "Published convention: the textbook quantity divided by 100.",
		}),
		dv01: z.number(),
		key_rate_durations: z.array(ZKeyRate),
		...residualFields,
	})
	.strict()
	.openapi("NominalAnalytics");

export const ZTipsAnalyticsOut = z
	.object({
		date: z.string(),
		real_yield: z.number().nullable().openapi({ description: "Percent." }),
		index_ratio: z.number(),
		indexed_principal: z.number(),
		real_clean_price: z.number(),
		real_dirty_price: z.number(),
		money_clean_price: z.number().openapi({
			description: "Real clean price times the index ratio.",
		}),
		accrued_real: z.number(),
		macaulay_duration: z.number(),
		modified_duration: z.number(),
		convexity: z.number(),
		dv01: z.number(),
		...residualFields,
	})
	.strict()
	.openapi("TipsAnalytics");

export const ZFrnAnalyticsOut = z
	.object({
		date: z.string(),
		clean_price: z.number(),
		dirty_price: z.number(),
		accrued_interest: z.number(),
		index_rate_percent: z.number(),
		quoted_spread_bp: z.number(),
		discount_margin_bp: z.number(),
		rate_duration_years: z.number(),
		spread_duration_years: z.number(),
		spread_dv01: z.number(),
		margin_z_score: z.number().nullable().openapi({
			description: "Null means not computed, never zero.",
		}),
	})
	.strict()
	.openapi("FrnAnalytics");

const ZBasis = z.enum(["nominal", "tips", "frn"]).openapi({
	description:
		"Which analytics a security has. TIPS and FRNs are not in the nominal table; each has its own fields.",
});

const ZFamily = z.enum(["bill", "note", "bond", "tips", "frn"]).nullable();

const ZAnyAnalytics = z.union([
	ZNominalAnalyticsOut,
	ZTipsAnalyticsOut,
	ZFrnAnalyticsOut,
]);

export const ZSecurityOut = z
	.object({
		cusip: z.string(),
		family: ZFamily,
		terms: ZSecurityTermsOut,
		latest_price: ZSecurityPriceOut.nullable(),
		analytics_basis: ZBasis.nullable(),
		latest_analytics: ZAnyAnalytics.nullable(),
	})
	.strict()
	.openapi("Security");

export const ZSecurityPricesOut = z
	.object({ cusip: z.string(), prices: z.array(ZSecurityPriceOut) })
	.strict()
	.openapi("SecurityPrices");

export const ZSecurityAnalyticsOut = z
	.object({
		cusip: z.string(),
		family: ZFamily,
		basis: ZBasis,
		analytics: z.array(ZAnyAnalytics),
	})
	.strict()
	.openapi("SecurityAnalyticsSeries");

// ── Shaping ──────────────────────────────────────────────────────────────────

/**
 * The auction fields /v1/securities/{cusip} publishes, named one by one. The
 * client now carries who bought each auction and at what rates (treasury PR
 * #10, 2026-09-29), and passing those through `shape` broke this route's
 * strict schema: every lookup a 500. A field the client gains is not a field
 * the API has promised; publishing more is a decision, made here.
 */
const publishedAuction = (auction: {
	auctionDate: string;
	issueDate: string;
	originalSecurityTerm: string;
	isReopening: boolean;
	highYield: number | null;
	bidToCoverRatio: number | null;
	offeringAmount: number | null;
	totalAccepted: number | null;
}) => ({
	auction_date: auction.auctionDate,
	issue_date: auction.issueDate,
	original_security_term: auction.originalSecurityTerm,
	is_reopening: auction.isReopening,
	high_yield: auction.highYield,
	bid_to_cover_ratio: auction.bidToCoverRatio,
	offering_amount: auction.offeringAmount,
	total_accepted: auction.totalAccepted,
});

/** snake_case, less the fields the envelope already states. */
const shape = (value: unknown) => {
	const { cusip: _c, ...rest } = snakeKeys(value) as Record<string, unknown>;
	return rest;
};

const noSecurity = (c: Context<AppEnv>, cusip: string) =>
	c.json(
		{
			error: "no_data" as const,
			message: `No Treasury security with CUSIP ${cusip}.`,
		},
		404,
	);

const errors = {
	...GATE_RESPONSES,
	400: {
		content: { "application/json": { schema: ZError } },
		description: "A malformed CUSIP or date.",
	},
	404: {
		content: { "application/json": { schema: ZError } },
		description: "No such CUSIP, or nothing in the range asked for.",
	},
	503: {
		content: { "application/json": { schema: ZError } },
		description: "The Treasury data service is unavailable.",
	},
};

const json = <T extends z.ZodType>(schema: T, description: string) => ({
	content: { "application/json": { schema } },
	description,
});

// ── Routes ───────────────────────────────────────────────────────────────────

const oneRoute = createRoute({
	method: "get",
	path: "/v1/securities/{cusip}",
	tags: ["Securities"],
	summary: "Look up a CUSIP",
	description:
		"Terms and auction history, the latest price and the latest analytics for one Treasury security. Analytics follow the security's kind: nominal (notes, bonds and bills), TIPS or FRN.",
	request: { params: ZCusipParam },
	responses: { 200: json(ZSecurityOut, "The security."), ...errors },
});

const pricesRoute = createRoute({
	method: "get",
	path: "/v1/securities/{cusip}/prices",
	tags: ["Securities"],
	summary: "Daily prices",
	description:
		"FedInvest end-of-day bid, offer and close per 100 face, oldest first.",
	request: { params: ZCusipParam, query: ZRange },
	responses: { 200: json(ZSecurityPricesOut, "Prices."), ...errors },
});

const analyticsRoute = createRoute({
	method: "get",
	path: "/v1/securities/{cusip}/analytics",
	tags: ["Securities"],
	summary: "Daily analytics, including rich/cheap to the curve",
	description:
		"Yield, duration, convexity, DV01 and key-rate durations, with the residual to the fitted zero curve, oldest first. The rows' fields depend on `basis`.",
	request: { params: ZCusipParam, query: ZRange },
	responses: { 200: json(ZSecurityAnalyticsOut, "Analytics."), ...errors },
});

export const registerSecurityRoutes = (app: OpenAPIHono<AppEnv>) => {
	app.openapi(oneRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const cusip = c.req.valid("param").cusip.toUpperCase();
		try {
			const [detail, prices] = await Promise.all([
				readSecurityDetail(c.env, cusip),
				readSecurityPrices(c.env, { cusip }),
			]);
			if (detail === null) return noSecurity(c, cusip);
			const family = familyOf(prices);
			const basis = analyticsBasisFor(family);
			const analytics =
				basis === null ? null : await readAnalyticsFor(c.env, { cusip, basis });
			const latest = analytics?.rows.at(-1);
			return c.json(
				ZSecurityOut.parse({
					cusip,
					family,
					terms: {
						...shape(detail),
						auctions: detail.auctions.map(publishedAuction),
					},
					latest_price: prices.length ? shape(prices.at(-1)) : null,
					analytics_basis: basis,
					latest_analytics: latest ? shape(latest) : null,
				}),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});

	app.openapi(pricesRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const cusip = c.req.valid("param").cusip.toUpperCase();
		const { from, to } = c.req.valid("query");
		try {
			const prices = await readSecurityPrices(c.env, { cusip, from, to });
			if (prices.length === 0) {
				return (await readSecurityDetail(c.env, cusip)) === null
					? noSecurity(c, cusip)
					: c.json(
							{
								error: "no_data" as const,
								message: `No prices for ${cusip} in that range.`,
							},
							404,
						);
			}
			return c.json(
				ZSecurityPricesOut.parse({ cusip, prices: prices.map(shape) }),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});

	app.openapi(analyticsRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const cusip = c.req.valid("param").cusip.toUpperCase();
		const { from, to } = c.req.valid("query");
		try {
			// The family decides which table; it comes from the price type.
			const prices = await readSecurityPrices(c.env, { cusip });
			const family = familyOf(prices);
			const basis = analyticsBasisFor(family);
			if (basis === null) {
				return (await readSecurityDetail(c.env, cusip)) === null
					? noSecurity(c, cusip)
					: c.json(
							{
								error: "no_data" as const,
								message: `${cusip} has never been priced, so it has no analytics.`,
							},
							404,
						);
			}
			const analytics = await readAnalyticsFor(c.env, { cusip, basis, from, to });
			if (analytics.rows.length === 0) {
				return c.json(
					{
						error: "no_data" as const,
						message: `No analytics for ${cusip} in that range.`,
					},
					404,
				);
			}
			return c.json(
				ZSecurityAnalyticsOut.parse({
					cusip,
					family,
					basis,
					analytics: analytics.rows.map(shape),
				}),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});
};
