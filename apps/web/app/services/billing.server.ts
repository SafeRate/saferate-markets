import { BETA_COUPON_IDS, resolveMarketsEnv } from "@markets/schema";
import Stripe from "stripe";
import { resolveStripeKey } from "@/lib/stripeKey";

/**
 * What the billing page needs to know about a live subscription before it
 * offers Individual -> Team, and the one Stripe write it makes itself.
 *
 * WHY THE SWITCH HAS TWO PATHS. The plugin upgrades an existing subscription IN
 * PLACE and invoices the proration at once, and an in-place upgrade cannot carry
 * a new discount. So:
 *
 *   a paying subscriber (card on file, no beta coupon)  -> in place, prorated
 *   a BETA subscriber (redeemed WIMBLEDON)               -> end the Individual
 *        subscription now and open a Team checkout, where they enter the code
 *        again. In place would bill them $100 prorated with, by design, no card
 *        to charge, and they would fall into past_due.
 *   anyone else without a card                           -> add one first
 */

const stripeFor = (env: {
	MARKETS_ENV?: string;
	STRIPE_SECRET_KEY?: string;
}) => {
	const { key } = resolveStripeKey({
		environment: resolveMarketsEnv(env.MARKETS_ENV),
		key: env.STRIPE_SECRET_KEY,
	});
	return key === null ? null : new Stripe(key);
};

export type TSwitchPath = "in-place" | "beta-checkout" | "needs-card";

/**
 * Which way this subscription may move to Team, or null when it cannot tell
 * (billing unconfigured, Stripe down). The page then says it cannot check
 * rather than guessing either way.
 */
export async function switchPathFor(input: {
	env: { MARKETS_ENV?: string; STRIPE_SECRET_KEY?: string };
	idStripeSubscription: string | null;
}): Promise<TSwitchPath | null> {
	if (!input.idStripeSubscription) return "needs-card";
	const stripe = stripeFor(input.env);
	if (stripe === null) return null;
	try {
		const subscription = await stripe.subscriptions.retrieve(
			input.idStripeSubscription,
			{ expand: ["customer", "discounts"] },
		);
		const couponIds = (subscription.discounts ?? []).map((discount) => {
			if (typeof discount === "string") return null;
			const coupon = discount.source?.coupon;
			return typeof coupon === "string" ? coupon : (coupon?.id ?? null);
		});
		if (couponIds.some((id) => id !== null && BETA_COUPON_IDS.includes(id))) {
			return "beta-checkout";
		}
		const customer = subscription.customer;
		const hasCard =
			Boolean(subscription.default_payment_method) ||
			(typeof customer === "object" &&
				!customer.deleted &&
				Boolean(customer.invoice_settings?.default_payment_method));
		return hasCard ? "in-place" : "needs-card";
	} catch (error) {
		console.error("[billing] could not inspect subscription:", error);
		return null;
	}
}

/**
 * End a subscription NOW, not at period end: the beta switch. Its webhook
 * (customer.subscription.deleted) ends our entitlement row; the Team checkout
 * that follows creates the new one.
 */
export async function cancelNow(input: {
	env: { MARKETS_ENV?: string; STRIPE_SECRET_KEY?: string };
	idStripeSubscription: string;
}) {
	const stripe = stripeFor(input.env);
	if (stripe === null) throw new Error("Stripe is not configured");
	await stripe.subscriptions.cancel(input.idStripeSubscription);
}
