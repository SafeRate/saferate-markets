import { z } from "zod";

/**
 * What we sell. Every page that shows a plan, the API's rate limiter, the Stripe
 * plugin and the Stripe seeder read this.
 *
 * Revised 2026-09-28 to Dylan's structure (first pass):
 *
 *   Individual  $10/mo   one person, their own account, 60/min
 *   Team        $100/mo  a firm's internal use and client reporting, 300/min
 *   Enterprise  custom   firm-wide, redistribution, benchmark licence, SLA
 *
 * The line between plans is WHO the data is for (the market-data convention):
 *
 *  - Individual is a NATURAL PERSON on their own account. An analyst at a fund
 *    is Team even if they pay personally.
 *  - Team is a firm's internal use, INCLUDING excerpts in its own client reports
 *    (attributed) and its own staff's agents, e.g. an analyst's Claude using the
 *    MCP server.
 *  - Enterprise is anything serving THEIR customers: public display, feeds, an
 *    agent or app their clients use. The benchmark licence (an index inside a
 *    financial product) is a named add-on here, not folded into redistribution:
 *    it is a different deal and can carry regulatory obligations.
 *
 * The beta code (BETA_PROMOTION) covers both checkout plans.
 *
 * NOT YET TRUE, so not claimed in any copy: more than one seat (Team is one seat
 * until invitations are built), and any history cap on Individual (every plan
 * has full history today). The terms themselves are for counsel.
 *
 * ⚠️ `public` IS INDIVIDUAL'S ID AND MUST STAY `public`. Existing subscriptions
 * carry it as their plan name (the plugin stores it, lowercased) and in
 * organizationSubscriptions.idPlan, and its Stripe lookup key is
 * markets_public_monthly. Renaming either orphans every subscription on it: the
 * plugin matches webhooks to plans by name and price by lookup key, and a
 * cancellation that matches nothing never revokes (OKLocate, 2026-09-23). Only
 * the display name changed.
 */

export const ZPlanId = z.enum(["public", "team", "enterprise"]);
export type TPlanId = z.infer<typeof ZPlanId>;

type TCheckoutSale = {
	kind: "checkout";
	priceUsdMonthly: number;
	/** Stripe resolves the price by this key. Never a price id. */
	stripeLookupKey: string;
	/**
	 * REST and MCP together, per organization. The limiter binding for this plan
	 * must carry the same number (apps/api/wrangler.jsonc, pinned by
	 * tests/rateLimit.test.ts).
	 */
	rateLimitPerMinute: number;
	/** The wrangler binding that enforces it. */
	rateLimitBinding: "RATE_LIMITER" | "RATE_LIMITER_TEAM";
};

export type TPlan = {
	id: TPlanId;
	name: string;
	summary: string;
	/** Who it is for and what it allows, in the reader's words. */
	permits: readonly string[];
	/** `checkout` is sold self-serve through Stripe; `contact` only by enquiry. */
	sale: TCheckoutSale | { kind: "contact" };
};

export const PLANS = [
	{
		id: "public",
		name: "Individual",
		summary: "For one person, on their own account.",
		permits: [
			"Your own research, models and decisions",
			"REST API and MCP access",
			"60 requests a minute",
		],
		sale: {
			kind: "checkout",
			priceUsdMonthly: 10,
			stripeLookupKey: "markets_public_monthly",
			rateLimitPerMinute: 60,
			rateLimitBinding: "RATE_LIMITER",
		},
	},
	{
		id: "team",
		name: "Team",
		summary: "For a firm's own use, and its client reporting.",
		permits: [
			"Commercial internal use: analysis, models, trading decisions",
			"Excerpts in reports and presentations to your own clients, attributed to Safe Rate",
			"Your staff's own AI agents, over MCP",
			"300 requests a minute",
			"Additional seats coming soon",
		],
		sale: {
			kind: "checkout",
			priceUsdMonthly: 100,
			stripeLookupKey: "markets_team_monthly",
			rateLimitPerMinute: 300,
			rateLimitBinding: "RATE_LIMITER_TEAM",
		},
	},
	{
		id: "enterprise",
		name: "Enterprise",
		summary: "Firm-wide, or in front of your own customers.",
		permits: [
			"Firm-wide use, with an SLA",
			"Bulk and history exports",
			"Security review and DPA",
			"Redistribution: your website, app, terminal or feed, and agents your customers use",
			"Benchmark licence: an index inside a fund or financial product",
		],
		sale: { kind: "contact" },
	},
] as const satisfies readonly TPlan[];

export type TCheckoutPlan = Omit<TPlan, "sale"> & { sale: TCheckoutSale };

/** The plans Stripe sells, in display order. */
export const CHECKOUT_PLANS: readonly TCheckoutPlan[] = PLANS.filter(
	(p) => p.sale.kind === "checkout",
) as readonly TCheckoutPlan[];

/**
 * The checkout plan with this id, or undefined. Anything unknown is undefined
 * rather than a default: a plan name from Stripe or a form that is not ours
 * must not resolve to a real plan's price or limits.
 */
export const checkoutPlanById = (id: string | null | undefined) =>
	CHECKOUT_PLANS.find((p) => p.id === id);

/**
 * The limit for an organization on a plan. An unknown or missing plan gets the
 * LOWEST limit: an entitlement row naming a plan we do not recognise must not
 * be granted the highest tier's capacity.
 */
export const rateLimitFor = (idPlan: string | null | undefined) => {
	const plan = checkoutPlanById(idPlan);
	const lowest = [...CHECKOUT_PLANS].sort(
		(a, b) => a.sale.rateLimitPerMinute - b.sale.rateLimitPerMinute,
	)[0];
	return (plan ?? lowest).sale;
};

/**
 * The beta: a 100%-off, never-expiring discount, entered at checkout as
 * WIMBLEDON, on EITHER checkout plan (Individual only until later on
 * 2026-09-28, when Dylan extended it to Team).
 *
 * A Stripe coupon's product restriction cannot be edited, so extending it meant
 * a NEW coupon (`couponId`) and moving the WIMBLEDON code onto it. The first
 * coupon stays in `formerCouponIds`: subscriptions that redeemed it keep its
 * discount, and the billing page must still recognise them as beta.
 *
 * Indefinite by decision: the beta ends when Dylan ends it, by deactivating the
 * code (no new redemptions) and removing the discount from existing
 * subscriptions. Deactivating alone does NOT end it for anyone already on it.
 * No card is collected for a $0 checkout, so a tester whose discount is removed
 * goes past_due and then loses access until they add one; warn them first.
 */
export const BETA_PROMOTION = {
	couponId: "markets_beta_all_plans",
	formerCouponIds: ["markets_beta_wimbledon"],
	code: "WIMBLEDON",
	name: "Safe Rate Markets beta",
	percentOff: 100,
	duration: "forever",
	appliesToPlans: ["public", "team"],
} as const satisfies {
	couponId: string;
	formerCouponIds: readonly string[];
	code: string;
	name: string;
	percentOff: number;
	duration: "forever" | "once" | "repeating";
	appliesToPlans: readonly TPlanId[];
};

/** Every coupon that marks a subscription as beta, current and former. */
export const BETA_COUPON_IDS: readonly string[] = [
	BETA_PROMOTION.couponId,
	...BETA_PROMOTION.formerCouponIds,
];

/** What a card statement says. Stripe allows 22 characters. */
export const STATEMENT_DESCRIPTOR = "SAFE RATE MARKETS";
