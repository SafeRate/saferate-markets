import { resolveMarketsEnv } from "@markets/schema";
import Stripe from "stripe";
import { resolveStripeKey } from "@/lib/stripeKey";

/**
 * Whether a subscription can be charged: a card on the subscription, or a
 * default card on its customer.
 *
 * Asked before offering Individual -> Team. The plugin upgrades an existing
 * subscription IN PLACE and invoices the proration at once. A beta subscriber
 * (WIMBLEDON, $0, no card collected by design) would get a $100 prorated
 * invoice with nothing to charge and fall into past_due, and the coupon does
 * not follow them: it applies to Individual's product only. So without a card
 * the page asks for one first, through Stripe's portal, instead of failing.
 *
 * Returns null when it cannot tell (billing unconfigured, Stripe down). The
 * page then says it cannot check rather than guessing either way.
 */
export async function canCharge(input: {
	env: { MARKETS_ENV?: string; STRIPE_SECRET_KEY?: string };
	idStripeSubscription: string | null;
}): Promise<boolean | null> {
	if (!input.idStripeSubscription) return false;
	const { key } = resolveStripeKey({
		environment: resolveMarketsEnv(input.env.MARKETS_ENV),
		key: input.env.STRIPE_SECRET_KEY,
	});
	if (key === null) return null;
	try {
		const stripe = new Stripe(key);
		const subscription = await stripe.subscriptions.retrieve(
			input.idStripeSubscription,
			{ expand: ["customer"] },
		);
		if (subscription.default_payment_method) return true;
		const customer = subscription.customer;
		return (
			typeof customer === "object" &&
			!customer.deleted &&
			Boolean(customer.invoice_settings?.default_payment_method)
		);
	} catch (error) {
		console.error("[billing] could not check payment method:", error);
		return null;
	}
}
