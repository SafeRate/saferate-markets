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
	BETA_CODES,
	BETA_COUPON_IDS,
	BETA_COUPONS,
	BETA_TERMS,
	CHECKOUT_PLANS,
	PRODUCT_NAME,
	SITE_HOSTS,
	STATEMENT_DESCRIPTOR,
	type TCheckoutPlan,
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

/** "Safe Rate Markets Individual", "Safe Rate Markets Team": what checkout shows. */
const productName = (plan: TCheckoutPlan) => `${PRODUCT_NAME} ${plan.name}`;

/**
 * One product per plan, found again by metadata.markets_plan = the plan id.
 * The name is kept in step with the schema (products are updatable and a name
 * change touches no subscription); the id and lookup key never change.
 */
const ensureProduct = async (plan: TCheckoutPlan) => {
	const products = await stripe.products.list({ active: true, limit: 100 });
	const existing = products.data.find(
		(p) => p.metadata.markets_plan === plan.id,
	);
	const name = productName(plan);
	if (existing) {
		if (existing.name === name) {
			log("=", `product ${plan.id}`, `${existing.id} "${existing.name}"`);
		} else if (!IS_APPLY) {
			log(
				"~",
				`product ${plan.id}`,
				`${existing.id} would rename "${existing.name}" -> "${name}"`,
			);
		} else {
			await stripe.products.update(existing.id, { name });
			log("~", `product ${plan.id}`, `${existing.id} renamed to "${name}"`);
		}
		return existing.id;
	}
	if (!IS_APPLY) {
		log("+", `product ${plan.id}`, `would create "${name}"`);
		return null;
	}
	const created = await stripe.products.create({
		name,
		statement_descriptor: STATEMENT_DESCRIPTOR,
		metadata: { markets_plan: plan.id },
	});
	log("+", `product ${plan.id}`, created.id);
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

const ensurePrice = async (plan: TCheckoutPlan, productId: string | null) => {
	const { stripeLookupKey, priceUsdMonthly } = plan.sale;
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
		log(
			"=",
			`price ${plan.id}`,
			`${found.id} ${stripeLookupKey} $${priceUsdMonthly}/mo`,
		);
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
			`price ${plan.id}`,
			`${found.id} differs from the schema; will move ${stripeLookupKey}`,
		);
	}
	if (!IS_APPLY || productId === null) {
		log(
			"+",
			`price ${plan.id}`,
			`would create ${stripeLookupKey} $${priceUsdMonthly}/mo`,
		);
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
	log("+", `price ${plan.id}`, `${created.id} ${stripeLookupKey}`);
};

type TBetaCoupon = (typeof BETA_COUPONS)[number];
type TBetaCode = (typeof BETA_CODES)[number];

/**
 * One beta coupon, restricted to its plans' products.
 *
 * An existing coupon is CHECKED, not trusted, including its product
 * restriction: coupons cannot be edited, so a wrong one has to be replaced by
 * hand, and a coupon quietly covering the wrong products is exactly how a code
 * meant for Individual would discount Team.
 */
const ensureCoupon = async (
	coupon: TBetaCoupon,
	productIds: Map<string, string | null>,
) => {
	const wanted = coupon.plans.map((plan) => productIds.get(plan) ?? null);
	try {
		const found = await stripe.coupons.retrieve(coupon.id, {
			expand: ["applies_to"],
		});
		const covers = [...(found.applies_to?.products ?? [])].sort();
		const expected = [...wanted].filter((id): id is string => id !== null).sort();
		const isRight =
			found.percent_off === BETA_TERMS.percentOff &&
			found.duration === BETA_TERMS.duration &&
			found.valid &&
			JSON.stringify(covers) === JSON.stringify(expected);
		if (!isRight) {
			fail(
				`coupon ${found.id} exists but is ${found.percent_off}% ${found.duration} valid=${found.valid} on ${covers.join(",") || "every product"}, not ${expected.join(",")}; coupons cannot be edited, so replace it by hand and re-run`,
			);
		}
		log(
			"=",
			`coupon ${coupon.id}`,
			`${found.percent_off}% ${found.duration} on ${coupon.plans.join(" + ")}`,
		);
		return true;
	} catch (error) {
		if ((error as { code?: string }).code !== "resource_missing") throw error;
	}
	if (!IS_APPLY || wanted.some((id) => id === null)) {
		log(
			"+",
			`coupon ${coupon.id}`,
			`would create 100% forever on ${coupon.plans.join(" + ")}`,
		);
		return false;
	}
	await stripe.coupons.create({
		id: coupon.id,
		name: BETA_TERMS.name,
		percent_off: BETA_TERMS.percentOff,
		duration: BETA_TERMS.duration,
		// Only these products, so a code cannot discount anything else on a
		// shared account (OKLocate sells on the same Stripe account).
		applies_to: { products: wanted as string[] },
	});
	log("+", `coupon ${coupon.id}`, `on ${coupon.plans.join(" + ")}`);
	return true;
};

/**
 * One promotion code on its coupon.
 *
 * A code is unique among ACTIVE codes, so moving it to another coupon means
 * deactivating the old code first. Only a code sitting on one of OUR beta
 * coupons is moved; the same code on any other coupon is somebody else's and
 * the seeder refuses. Deactivating a code stops new redemptions only:
 * subscriptions that already redeemed it keep their discount.
 */
const ensurePromotionCode = async (code: TBetaCode, hasCoupon: boolean) => {
	const codes = await stripe.promotionCodes.list({
		code: code.code,
		active: true,
		limit: 10,
	});
	const existing = codes.data[0];
	const couponOf = (promo: Stripe.PromotionCode) => {
		const coupon = promo.promotion?.coupon;
		return typeof coupon === "string" ? coupon : coupon?.id;
	};
	const label = `code ${code.code}`;
	if (existing) {
		const couponId = couponOf(existing);
		if (couponId === code.couponId) {
			log("=", label, `${existing.id} on ${couponId}`);
			return;
		}
		if (!BETA_COUPON_IDS.includes(couponId ?? "")) {
			fail(
				`an active code ${code.code} exists on coupon ${couponId}, which is not a beta coupon; refusing to touch it`,
			);
		}
		if (!IS_APPLY || !hasCoupon) {
			log(
				"~",
				label,
				`would move from ${couponId} to ${code.couponId} (existing discounts unaffected)`,
			);
			return;
		}
		await stripe.promotionCodes.update(existing.id, { active: false });
		log("~", label, `${existing.id} on ${couponId} deactivated`);
	}
	if (!IS_APPLY || !hasCoupon) {
		log("+", label, `would create on ${code.couponId}`);
		return;
	}
	const created = await stripe.promotionCodes.create({
		code: code.code,
		promotion: { type: "coupon", coupon: code.couponId },
	});
	log("+", label, `${created.id} on ${code.couponId}`);
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

const productIds = new Map<string, string | null>();
for (const plan of CHECKOUT_PLANS) {
	const productId = await ensureProduct(plan);
	await ensurePrice(plan, productId);
	productIds.set(plan.id, productId);
}
// Each beta coupon restricted to its plans' products; then each code on its coupon.
const couponReady = new Map<string, boolean>();
for (const coupon of BETA_COUPONS) {
	couponReady.set(coupon.id, await ensureCoupon(coupon, productIds));
}
for (const code of BETA_CODES) {
	await ensurePromotionCode(code, couponReady.get(code.couponId) ?? false);
}
await ensureWebhook();
