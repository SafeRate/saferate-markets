/**
 * Seed Stripe from @markets/schema: the product, its price, the beta coupon and
 * promotion code, and the webhook endpoint. Nothing is typed into the Stripe
 * dashboard.
 *
 *   doppler run --project saferate-markets --config stg -- bun scripts/stripe-seed.ts
 *   doppler run --project saferate-markets --config stg -- bun scripts/stripe-seed.ts --apply
 *
 * Dry run by default. Idempotent: every object is found again by a key we set
 * (price lookup key, coupon id, promotion code, product metadata, endpoint URL),
 * so a re-run reports "=" and creates nothing.
 *
 * The guards, ported from OKLocate's stripe-seed-prices.sh:
 *
 *  1. The account is PRINTED before anything happens, found by asking Stripe,
 *     not by trusting the key's prefix or the CLI's remembered profile (two
 *     OKLocate accounts were both called "oklocate").
 *  2. A LIVE key needs I_UNDERSTAND_THIS_IS_LIVE=1 to apply.
 *  3. The key must suit the environment (lib/stripeKey.ts): production live,
 *     everything else test.
 *  4. A lookup key is NEVER moved off a price that has active subscriptions.
 *     The plugin resolves plans by lookup key, so moving it orphans every
 *     subscription on the old price: their webhooks stop matching, and a
 *     cancellation never reaches us, so the customer keeps access for free.
 *     OKLocate did this to itself within an hour of going live.
 *
 * The webhook signing secret is returned by Stripe ONCE, at creation. It is
 * piped straight into this Doppler config's STRIPE_WEBHOOK_SECRET and never
 * printed or passed on a command line.
 */
import { spawnSync } from "node:child_process";
import {
	BETA_PROMOTION,
	CHECKOUT_PLAN,
	PRODUCT_NAME,
	SITE_HOSTS,
	STATEMENT_DESCRIPTOR,
	type TMarketsEnv,
} from "@markets/schema";
import Stripe from "stripe";
import { resolveStripeKey } from "../apps/web/app/lib/stripeKey";

const IS_APPLY = process.argv.includes("--apply");

/** The four events @better-auth/stripe@1.7.1 handles (dist/index.mjs switch). */
export const WEBHOOK_EVENTS = [
	"checkout.session.completed",
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
] as const;

const ENV_BY_DOPPLER: Record<string, TMarketsEnv> = {
	dev: "development",
	stg: "staging",
	prd: "production",
};

const fail = (message: string): never => {
	console.error(`error: ${message}`);
	process.exit(1);
};

const dopplerConfig = process.env.DOPPLER_CONFIG ?? "";
const environment =
	ENV_BY_DOPPLER[dopplerConfig] ??
	fail(`run under doppler (DOPPLER_CONFIG is "${dopplerConfig}")`);

const resolved = resolveStripeKey({
	environment,
	key: process.env.STRIPE_SECRET_KEY,
});
const key = resolved.key ?? fail(resolved.problem ?? "no Stripe key");
const isLive = /^(sk|rk)_live_/.test(key);
const stripe = new Stripe(key, { appInfo: { name: `${PRODUCT_NAME} seed` } });

const log = (mark: "=" | "+" | "~" | "!", what: string, detail: string) =>
	console.info(`  ${mark} ${what.padEnd(22)} ${detail}`);

/** Which account this key reaches, by asking. */
const probeAccount = async () => {
	try {
		const account = await stripe.accounts.retrieveCurrent();
		return account.id;
	} catch {
		// A restricted key is refused /v1/account (correctly). Every object id
		// carries a fragment of its account's id, so read one.
		const prices = await stripe.prices.list({ limit: 1 });
		const id = prices.data[0]?.id;
		return id
			? `acct_…${id.slice("price_1".length + 5, "price_1".length + 15)} (from a price id)`
			: "unknown (restricted key, no prices yet)";
	}
};

const ensureProduct = async () => {
	const products = await stripe.products.list({ active: true, limit: 100 });
	const existing = products.data.find(
		(p) => p.metadata.markets_plan === CHECKOUT_PLAN.id,
	);
	if (existing) {
		log("=", "product", `${existing.id} "${existing.name}"`);
		return existing.id;
	}
	if (!IS_APPLY) {
		log("+", "product", `would create "${PRODUCT_NAME}"`);
		return null;
	}
	const created = await stripe.products.create({
		name: PRODUCT_NAME,
		statement_descriptor: STATEMENT_DESCRIPTOR,
		metadata: { markets_plan: CHECKOUT_PLAN.id },
	});
	log("+", "product", created.id);
	return created.id;
};

const activeSubscriptionsOn = async (priceId: string) =>
	(
		await stripe.subscriptions.list({
			price: priceId,
			status: "active",
			limit: 100,
		})
	).data.length;

const ensurePrice = async (productId: string | null) => {
	const { stripeLookupKey, priceUsdMonthly } = CHECKOUT_PLAN.sale;
	const cents = Math.round(priceUsdMonthly * 100);
	const found = (
		await stripe.prices.list({
			lookup_keys: [stripeLookupKey],
			active: true,
			limit: 1,
		})
	).data[0];

	const matches =
		found &&
		found.unit_amount === cents &&
		found.currency === "usd" &&
		found.recurring?.interval === "month" &&
		(productId === null || found.product === productId);
	if (found && matches) {
		log("=", "price", `${found.id} ${stripeLookupKey} $${priceUsdMonthly}/mo`);
		return;
	}
	if (found) {
		// A different price holds the key. Moving it is the dangerous operation.
		const subscribers = await activeSubscriptionsOn(found.id);
		if (subscribers > 0) {
			fail(
				`${stripeLookupKey} is held by ${found.id} (${found.unit_amount} ${found.currency}) with ${subscribers} active subscription(s). Moving the key would orphan them; migrate them to a new price first.`,
			);
		}
		log(
			"~",
			"price",
			`${found.id} differs from the schema; will move ${stripeLookupKey}`,
		);
	}
	if (!IS_APPLY || productId === null) {
		log("+", "price", `would create ${stripeLookupKey} $${priceUsdMonthly}/mo`);
		return;
	}
	const created = await stripe.prices.create({
		product: productId,
		currency: "usd",
		unit_amount: cents,
		recurring: { interval: "month" },
		lookup_key: stripeLookupKey,
		// Only reached with zero active subscribers on the old holder (above).
		transfer_lookup_key: found !== undefined,
	});
	log("+", "price", `${created.id} ${stripeLookupKey}`);
};

const ensureCoupon = async (productId: string | null) => {
	try {
		const coupon = await stripe.coupons.retrieve(BETA_PROMOTION.couponId);
		const isRight =
			coupon.percent_off === BETA_PROMOTION.percentOff &&
			coupon.duration === BETA_PROMOTION.duration &&
			coupon.valid;
		if (!isRight) {
			fail(
				`coupon ${coupon.id} exists but is ${coupon.percent_off}% ${coupon.duration} valid=${coupon.valid}; coupons cannot be edited, so delete it in the dashboard and re-run`,
			);
		}
		log("=", "coupon", `${coupon.id} ${coupon.percent_off}% ${coupon.duration}`);
		return true;
	} catch (error) {
		if ((error as { code?: string }).code !== "resource_missing") throw error;
	}
	if (!IS_APPLY || productId === null) {
		log("+", "coupon", `would create ${BETA_PROMOTION.couponId} 100% forever`);
		return false;
	}
	await stripe.coupons.create({
		id: BETA_PROMOTION.couponId,
		name: BETA_PROMOTION.name,
		percent_off: BETA_PROMOTION.percentOff,
		duration: BETA_PROMOTION.duration,
		// Only this product, so the code cannot discount anything else on a
		// shared account.
		applies_to: { products: [productId] },
	});
	log("+", "coupon", BETA_PROMOTION.couponId);
	return true;
};

const ensurePromotionCode = async (hasCoupon: boolean) => {
	const codes = await stripe.promotionCodes.list({
		code: BETA_PROMOTION.code,
		active: true,
		limit: 10,
	});
	const existing = codes.data[0];
	if (existing) {
		const coupon = existing.promotion?.coupon;
		const couponId = typeof coupon === "string" ? coupon : coupon?.id;
		if (couponId !== BETA_PROMOTION.couponId) {
			fail(
				`an active code ${BETA_PROMOTION.code} exists on coupon ${couponId}, not ${BETA_PROMOTION.couponId}`,
			);
		}
		log("=", "promotion code", `${existing.id} ${existing.code}`);
		return;
	}
	if (!IS_APPLY || !hasCoupon) {
		log("+", "promotion code", `would create ${BETA_PROMOTION.code}`);
		return;
	}
	const created = await stripe.promotionCodes.create({
		code: BETA_PROMOTION.code,
		promotion: { type: "coupon", coupon: BETA_PROMOTION.couponId },
	});
	log("+", "promotion code", `${created.id} ${created.code}`);
};

/** Pipe a value into Doppler through stdin: never argv, never printed. */
const writeDopplerSecret = (name: string, value: string) => {
	const result = spawnSync(
		"doppler",
		[
			"secrets",
			"set",
			name,
			"--project",
			"saferate-markets",
			"--config",
			dopplerConfig,
			"--silent",
		],
		{ input: value, encoding: "utf8" },
	);
	if (result.status !== 0) {
		fail(
			`could not write ${name} to Doppler (${result.stderr.trim()}). The endpoint EXISTS in Stripe now; roll its signing secret in the dashboard and set ${name} by hand.`,
		);
	}
};

const ensureWebhook = async () => {
	if (environment === "development") {
		log("=", "webhook", "none for development (use `stripe listen`)");
		return;
	}
	const url = `${SITE_HOSTS[environment].web}/api/auth/stripe/webhook`;
	const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
	const existing = endpoints.data.find((e) => e.url === url);
	if (existing) {
		const missing = WEBHOOK_EVENTS.filter(
			(e) => !existing.enabled_events.includes(e),
		);
		if (missing.length > 0) {
			if (!IS_APPLY) {
				log("~", "webhook", `${existing.id} would add ${missing.join(", ")}`);
				return;
			}
			await stripe.webhookEndpoints.update(existing.id, {
				enabled_events: [...WEBHOOK_EVENTS],
			});
			log("~", "webhook", `${existing.id} events updated`);
			return;
		}
		log("=", "webhook", `${existing.id} ${url}`);
		return;
	}
	if (!IS_APPLY) {
		log(
			"+",
			"webhook",
			`would create ${url}, secret -> Doppler ${dopplerConfig}`,
		);
		return;
	}
	const created = await stripe.webhookEndpoints.create({
		url,
		enabled_events: [...WEBHOOK_EVENTS],
		description: `${PRODUCT_NAME} (${environment})`,
	});
	if (!created.secret)
		fail(`Stripe returned no signing secret for ${created.id}`);
	writeDopplerSecret("STRIPE_WEBHOOK_SECRET", created.secret as string);
	log(
		"+",
		"webhook",
		`${created.id} ${url}, secret written to Doppler ${dopplerConfig}`,
	);
};

console.info(`Environment   : ${environment} (Doppler ${dopplerConfig})`);
console.info(`Stripe mode   : ${isLive ? "LIVE" : "test"}`);
console.info(`Account       : ${await probeAccount()}`);
if (IS_APPLY && isLive && process.env.I_UNDERSTAND_THIS_IS_LIVE !== "1") {
	fail(
		"refusing to --apply against a LIVE key. Check the account above, then re-run with I_UNDERSTAND_THIS_IS_LIVE=1.",
	);
}
console.info(
	IS_APPLY ? "Applying.\n" : "Dry run. Pass --apply to create anything.\n",
);

const productId = await ensureProduct();
await ensurePrice(productId);
const hasCoupon = await ensureCoupon(productId);
await ensurePromotionCode(hasCoupon);
await ensureWebhook();
