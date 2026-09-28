import { z } from "zod";

/**
 * What we sell. Every page that shows a plan, and the Stripe seeder, read this.
 *
 * Decided 2026-09-28:
 *
 *  - ONE paid plan, $10/month, one subscription per organization, one seat.
 *  - Beta is NOT a plan. It is a 100%-off promotion code on this same plan, so a
 *    beta tester is on the real price from day one and ending the beta is a
 *    change to their discount rather than a migration to another plan. No card
 *    is collected for a $0 checkout, so when the discount ends their access
 *    lapses until they add one. Coupon terms land with billing (step 4).
 *  - No quota. Access is rate-limited (RATE_LIMIT_PER_MINUTE) and usage is still
 *    metered, so the dashboard shows real numbers.
 *  - The line between plans is WHO SEES THE DATA, the market-data convention:
 *    internal use and client reporting are the $10 plan; putting numbers in
 *    front of the public or inside another product is redistribution; using an
 *    index inside a financial product is a benchmark licence. The last two are
 *    contact-us. The terms themselves are for counsel; this is their structure.
 */

export const ZPlanId = z.enum(["public", "redistribution", "benchmark"]);
export type TPlanId = z.infer<typeof ZPlanId>;

export type TPlan = {
	id: TPlanId;
	name: string;
	summary: string;
	/** What the licence covers, in the reader's words. Rendered as a list. */
	permits: readonly string[];
	/**
	 * `checkout` is sold self-serve through Stripe; `contact` has no price and no
	 * checkout, only an enquiry. A contact plan gets a price by becoming checkout.
	 */
	sale:
		| {
				kind: "checkout";
				priceUsdMonthly: number;
				/** Stripe resolves the price by this key. Never a price id. */
				stripeLookupKey: string;
		  }
		| { kind: "contact" };
};

export const PLANS = [
	{
		id: "public",
		name: "Markets",
		summary: "Use the data and show it to your clients.",
		permits: [
			"Your own analysis, models, research and trading decisions",
			"Excerpts in reports, statements and presentations to your own clients, attributed to Safe Rate",
			"REST API and MCP access",
		],
		sale: {
			kind: "checkout",
			priceUsdMonthly: 10,
			stripeLookupKey: "markets_public_monthly",
		},
	},
	{
		id: "redistribution",
		name: "Redistribution",
		summary: "Put the data in front of the public or inside your product.",
		permits: [
			"Display on a public website, app or terminal",
			"Data feeds and APIs to your own customers",
		],
		sale: { kind: "contact" },
	},
	{
		id: "benchmark",
		name: "Benchmark licence",
		summary: "Use a Safe Rate index inside a financial product.",
		permits: [
			"A fund or product that tracks, or is measured against, a Safe Rate index",
			"Products whose payout references an index level",
		],
		sale: { kind: "contact" },
	},
] as const satisfies readonly TPlan[];

/**
 * Per organization, counting REST requests and MCP tool calls together.
 *
 * Proposed 2026-09-28 and not yet objected to. Enforced with Cloudflare's rate
 * limiting binding, which counts per location and is approximate: it stops a
 * runaway script, it is not a contractual figure. Enforcement is not built yet.
 */
export const RATE_LIMIT_PER_MINUTE = 60;
