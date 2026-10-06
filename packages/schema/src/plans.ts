import { z } from "zod";

/**
 * What we sell. Every page that shows a plan, the API's rate limiter, the Stripe
 * plugin and the Stripe seeder read this.
 *
 * Revised 2026-09-28 to Dylan's structure (first pass):
 *
 *   Individual  $10/mo   one person, their own account, 60/min
 *   Team        $100/mo  a firm's internal use and client reporting, 300/min
 *   Enterprise  custom   firm-wide, redistribution, index license, SLA
 *
 * The line between plans is WHO the data is for (the market-data convention):
 *
 *  - Individual is a NATURAL PERSON on their own account. An analyst at a fund
 *    is Team even if they pay personally.
 *  - Team is a firm's internal use, INCLUDING excerpts in its own client reports
 *    (attributed) and its own staff's agents, e.g. an analyst's Claude using the
 *    MCP server.
 *  - Enterprise is anything serving THEIR customers: public display, feeds, an
 *    agent or app their clients use. The index license (an ETF, fund or product
 *    built to TRACK an index) is a named add-on here, not folded into
 *    redistribution: it is a different deal and can carry regulatory
 *    obligations. Benchmarking, naming an index as a fund's benchmark in a
 *    prospectus included, is free (saferate.com's terms; Dylan, 2026-10-05).
 *
 * The beta codes (BETA_CODES) are listed below with the plans each covers.
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
			"Index license: an ETF, fund or product built to track an index",
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
 * The beta: 100% off, forever, through promotion codes entered at checkout.
 * Decided 2026-09-28, in three steps the same day: WIMBLEDON on Individual;
 * WIMBLEDON extended to Team; MIT2004 added on Individual ONLY, so a code that
 * does NOT cover Team can be tested (it must be refused at a Team checkout).
 *
 * Coupons carry the product restriction and it CANNOT be edited in Stripe, so
 * each restriction is its own coupon, and codes point at coupons. Coupon ids are
 * set by us at creation and never change, which is why the Individual-only one
 * is still called markets_beta_wimbledon although WIMBLEDON has moved off it.
 * Subscriptions keep the coupon they redeemed.
 *
 * Indefinite by decision: the beta ends when Dylan ends it, by deactivating the
 * codes (no new redemptions) and removing the discount from existing
 * subscriptions. Deactivating alone does NOT end it for anyone already on it.
 * No card is collected for a $0 checkout, so a tester whose discount is removed
 * goes past_due and then loses access until they add one; warn them first.
 */
export const BETA_COUPONS = [
	{ id: "markets_beta_all_plans", plans: ["public", "team"] },
	{ id: "markets_beta_wimbledon", plans: ["public"] },
] as const satisfies readonly { id: string; plans: readonly TPlanId[] }[];

export type TBetaCouponId = (typeof BETA_COUPONS)[number]["id"];

export const BETA_CODES = [
	{ code: "WIMBLEDON", couponId: "markets_beta_all_plans" },
	{ code: "MIT2004", couponId: "markets_beta_wimbledon" },
] as const satisfies readonly { code: string; couponId: TBetaCouponId }[];

export const BETA_TERMS = {
	name: "Safe Rate Markets beta",
	percentOff: 100,
	duration: "forever",
} as const;

/** Every coupon that marks a subscription as beta. */
export const BETA_COUPON_IDS: readonly string[] = BETA_COUPONS.map((c) => c.id);

/** Plans at least one beta code covers, for the "have a code?" hint. */
export const BETA_PLANS: readonly TPlanId[] = [
	...new Set(BETA_COUPONS.flatMap((c) => c.plans)),
];

/** What a card statement says. Stripe allows 22 characters. */
export const STATEMENT_DESCRIPTOR = "SAFE RATE MARKETS";

/**
 * The free tier (Dylan, 2026-10-06): one person's own Treasuries, in the
 * dashboard, while what they track is worth under $100,000. NOT a Stripe plan
 * and not in PLANS: there is nothing to check out, no subscription row, and no
 * API or MCP (an unpaid organization's keys are refused by the API already).
 *
 * An unpaid account sees the read-only demo until it creates its first
 * portfolio, and its own portfolios from then on (lib/session.server.ts).
 *
 * The cap is the portfolios' VALUE as the dashboard reports it (holdings at the
 * latest close, plus any cash), checked whenever trades are added, so matured
 * bills drop out and a bill roll is not counted twice. Rising past it with the
 * market blocks new trades, never viewing.
 */
export const FREE_TIER = {
	name: "Free",
	summary: "For one person's own Treasuries, worth under $100,000.",
	permits: [
		"Your own portfolios in the dashboard, up to two",
		"Every dashboard tool: tracking, stress testing, the builder, backtests",
		"Holdings worth up to $100,000 in total",
		"No API or MCP access; those come with Individual",
	],
	maxPortfolios: 2,
	maxValueUsd: 100_000,
} as const;

/**
 * The trial (decided 2026-10-06): every new account gets Team, in full, for 30
 * days, with no card: sign-in is the only step. Dylan checks in with each
 * trialist personally, so the length leaves room for two conversations.
 *
 * NOT a Stripe trial: that needs a checkout, which is the step this removes.
 * It is `organizations.trialEndsAt` (migration 0007), set when the
 * organization is created; accounts that existed on launch day got 30 days
 * from then. Extending one is an UPDATE of that column, nothing else.
 *
 * While it runs, the dashboard has no free-tier limits and the API and MCP
 * serve the organization's keys at Team's rate. When it ends without a
 * subscription the account is on the free tier: nothing is deleted, and
 * anything past the free limits is kept but cannot grow.
 */
export const TRIAL = {
	days: 30,
	idPlan: "team",
} as const satisfies { days: number; idPlan: TPlanId };

export const TRIAL_MS = TRIAL.days * 24 * 60 * 60 * 1000;

/** Whether a trial ending at `trialEndsAt` (epoch ms, or null) is running at `now`. */
export const isTrialActive = (
	trialEndsAt: number | null | undefined,
	now: number = Date.now(),
) => typeof trialEndsAt === "number" && trialEndsAt > now;

/** Whole days left, rounded up, so the last day reads "1 day left". */
export const trialDaysLeft = (trialEndsAt: number, now: number = Date.now()) =>
	Math.max(0, Math.ceil((trialEndsAt - now) / (24 * 60 * 60 * 1000)));

/** The trial's last day as people read it, e.g. "November 5" (New York time). */
export const trialLastDay = (trialEndsAt: number) =>
	new Date(trialEndsAt).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		timeZone: "America/New_York",
	});
