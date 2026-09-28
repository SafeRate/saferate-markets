import { stripe as stripePlugin } from "@better-auth/stripe";
import { resolveEmailProvider } from "@markets/email";
import {
	endOrganizationSubscription,
	setOrganizationSubscription,
} from "@markets/persistence";
import {
	CHECKOUT_PLANS,
	checkoutPlanById,
	PRODUCT_NAME,
	REDIRECT_HOSTS,
	resolveMarketsEnv,
	SENDER_ADDRESS,
	SITE_HOSTS,
} from "@markets/schema";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import Stripe from "stripe";
import { z } from "zod";
import { resolveStripeKey } from "@/lib/stripeKey";
import { magicLinkEmail } from "@/services/authEmail";
import createD1Adapter from "@/services/d1Adapter";
import {
	isOrganizationMember,
	setOrganizationStripeCustomer,
} from "@/services/organizations.server";

/**
 * Better Auth, magic link only, open sign-up. Ported from saferate-oklocate.
 *
 * No passwords: a B2B API product has no reason to store a credential it does
 * not need, and the API authenticates with keys, not sessions.
 *
 * better-auth is pinned EXACTLY to 1.7.1 in the root package.json. Do not loosen
 * it to a caret. 1.7.0 made a previously optional adapter method mandatory, and
 * a caret range upgrading into it 500ed every magic-link sign-in in the sibling
 * consumer app for about 18 hours. Before bumping, diff @better-auth/core's
 * adapter factory for newly required methods and confirm d1Adapter.ts has them.
 *
 * Stripe is mounted UNCONDITIONALLY, as in OKLocate: a conditional plugin
 * changes the inferred type of `auth.api` and loses its typed endpoints. With no
 * acceptable key it runs on a placeholder, so billing fails at its first call
 * with a real Stripe error and sign-in is untouched.
 */

const ZAuthEnv = z.object({
	BETTER_AUTH_SECRET: z.string().min(1),
	DB: z.custom<D1Database>((v) => v !== null && v !== undefined),
	// Optional: local dev has no binding and falls back to the console provider,
	// which prints the link.
	EMAIL: z.custom<SendEmail>().optional(),
	MARKETS_ENV: z.string().optional(),
	EMAIL_RECIPIENT_ALLOWLIST: z.string().optional(),
	STRIPE_SECRET_KEY: z.string().optional(),
	STRIPE_WEBHOOK_SECRET: z.string().optional(),
});
type TAuthEnv = z.infer<typeof ZAuthEnv>;

/** Every origin this app is served from, derived rather than typed twice. */
const TRUSTED_ORIGINS: string[] = Object.values(SITE_HOSTS).map((h) => h.web);

/**
 * Statuses after which a subscription no longer exists for us. Anything else is
 * projected as-is and the entitlement join decides whether it grants access.
 */
const TERMINAL_STATUSES = ["canceled", "unpaid", "incomplete_expired"];

/**
 * Stripe state -> organizationSubscriptions. Swallows its errors, as OKLocate's
 * projection does: the plugin has already committed its own row when these run,
 * so a throw would make Stripe replay a webhook that succeeded, and fix nothing.
 * The log keeps the discrepancy visible.
 */
export const project = async (
	db: D1Database,
	input: {
		idOrganization: string;
		/** The plugin's plan name for this subscription (lowercased by it). */
		planName: string;
		stripeSubscription: Stripe.Subscription;
	},
) => {
	const { stripeSubscription: sub } = input;
	try {
		// The plan the subscription IS on, from the plugin, never assumed. This
		// was hardcoded to the single plan until Team existed; left that way, a
		// Team subscriber would be recorded as Individual and limited to 60/min.
		// An unknown name is refused rather than defaulted: a guessed plan is a
		// guessed price and a guessed limit.
		const plan = checkoutPlanById(input.planName);
		if (!plan && !TERMINAL_STATUSES.includes(sub.status)) {
			console.error(
				`[stripe] refusing to project ${sub.id}: unknown plan "${input.planName}" for ${input.idOrganization}`,
			);
			return;
		}
		if (TERMINAL_STATUSES.includes(sub.status)) {
			await endOrganizationSubscription({
				db,
				idOrganization: input.idOrganization,
				statusSubscription: sub.status,
			});
			return;
		}
		await setOrganizationSubscription({
			db,
			idOrganization: input.idOrganization,
			idPlan: (plan as NonNullable<typeof plan>).id,
			idStripeSubscription: sub.id,
			statusSubscription: sub.status,
			// cancel_at, not cancel_at_period_end: Stripe leaves the boolean false
			// for a period-end cancellation. Seconds from Stripe, ms here.
			cancelsAt: sub.cancel_at ? sub.cancel_at * 1000 : null,
		});
	} catch (error) {
		console.error(
			`[stripe] could not project ${sub.id} for ${input.idOrganization}:`,
			error,
		);
	}
};

const buildAuth = (env: TAuthEnv, baseURL: string) => {
	const environment = resolveMarketsEnv(env.MARKETS_ENV);
	const stripeKey = resolveStripeKey({
		environment,
		key: env.STRIPE_SECRET_KEY,
	});
	if (stripeKey.problem) {
		console.error(`[stripe] billing unavailable: ${stripeKey.problem}`);
	}
	// No apiVersion pin and no httpClient, as OKLocate: the SDK defaults to the
	// version its own types describe, and stripe@22's `workerd` export condition
	// selects the fetch-based client on Workers.
	const stripeClient = new Stripe(stripeKey.key ?? "sk_test_unconfigured", {
		appInfo: { name: PRODUCT_NAME },
	});

	return betterAuth({
		baseURL,
		secret: env.BETTER_AUTH_SECRET,
		database: createD1Adapter({ db: env.DB }),
		trustedOrigins: TRUSTED_ORIGINS,
		emailAndPassword: { enabled: false },
		session: {
			expiresIn: 60 * 60 * 24 * 30,
			updateAge: 60 * 60 * 24,
		},
		user: {
			// Deleting a user would orphan the organization's keys and usage rows.
			deleteUser: { enabled: false },
		},
		plugins: [
			magicLink({
				disableSignUp: false,
				expiresIn: 900,
				async sendMagicLink({ email, url }) {
					// Always via resolveEmailProvider, never a raw send: it wraps the
					// provider in the non-production allowlist, so no send path escapes
					// the guard.
					const provider = resolveEmailProvider({
						EMAIL: env.EMAIL,
						MARKETS_ENV: env.MARKETS_ENV,
						EMAIL_RECIPIENT_ALLOWLIST: env.EMAIL_RECIPIENT_ALLOWLIST,
					});
					const result = await provider.send({
						to: email,
						from: SENDER_ADDRESS,
						subject: `Sign in to ${PRODUCT_NAME}`,
						...magicLinkEmail(url),
					});
					// Logged, not thrown. A throw is an opaque 500 on the sign-in page;
					// a log leaves the cause in the tail while the page says "check your
					// email". A withheld send is the guard working, not a failure.
					if (result.status !== "sent") {
						console.warn(
							`[auth] magic link to ${email} not sent: ${result.status} — ${result.reason}`,
						);
					}
				},
			}),
			stripePlugin({
				stripeClient,
				// An empty secret fails verification, which is right for an
				// unconfigured endpoint: it must never accept an unverified payload.
				stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
				// The ORGANIZATION is the billing subject, so no customer per signup.
				createCustomerOnSignUp: false,
				/*
				 * Record the Stripe customer against the organization when it is
				 * created, during the upgrade call and so before any webhook. OKLocate
				 * learned this from a race: Stripe delivered all five webhooks of its
				 * first live checkout within one second, before the mapping existed.
				 */
				onCustomerCreate: async ({ stripeCustomer, user }) => {
					try {
						await setOrganizationStripeCustomer({
							db: env.DB,
							idUser: user.id,
							idStripeCustomer: stripeCustomer.id,
						});
					} catch (error) {
						console.error(
							`[stripe] could not link customer ${stripeCustomer.id}:`,
							error,
						);
					}
				},
				subscription: {
					enabled: true,
					// Every checkout plan, by lookup key. Names are the plan ids, which
					// the plugin stores lowercased: `public` and `team` already are.
					plans: CHECKOUT_PLANS.map((plan) => ({
						name: plan.id,
						lookupKey: plan.sale.stripeLookupKey,
					})),
					/*
					 * Promotion codes ON, so WIMBLEDON can be entered. Card collection
					 * `if_required`, so a $0 beta checkout completes without one
					 * (decided 2026-09-28). Both pass through: the plugin strips only
					 * the fields it owns (mode, customer, urls, line_items, reference).
					 * Verified against dist/index.mjs of 1.7.1, not the docs.
					 */
					getCheckoutSessionParams: () => ({
						params: {
							allow_promotion_codes: true,
							payment_method_collection: "if_required",
						},
					}),
					/*
					 * The reference is our idOrganization and arrives in a request body,
					 * so it is attacker-controlled. Better Auth proves the caller is
					 * signed in; only we can say they own the organization. Fails CLOSED.
					 */
					authorizeReference: async ({ user, referenceId, action }) => {
						try {
							const isMember = await isOrganizationMember({
								db: env.DB,
								idOrganization: referenceId,
								idUser: user.id,
							});
							if (!isMember) {
								console.warn(
									`[stripe] refused ${action}: ${user.id} is not in ${referenceId}`,
								);
							}
							return isMember;
						} catch (error) {
							console.error("[stripe] authorizeReference failed:", error);
							return false;
						}
					},
					onSubscriptionComplete: async ({ subscription, stripeSubscription }) =>
						project(env.DB, {
							idOrganization: subscription.referenceId,
							planName: subscription.plan,
							stripeSubscription,
						}),
					onSubscriptionUpdate: async ({ subscription, stripeSubscription }) =>
						project(env.DB, {
							idOrganization: subscription.referenceId,
							planName: subscription.plan,
							stripeSubscription,
						}),
					onSubscriptionDeleted: async ({ subscription, stripeSubscription }) =>
						project(env.DB, {
							idOrganization: subscription.referenceId,
							planName: subscription.plan,
							stripeSubscription,
						}),
				},
			}),
		],
	});
};

type TAuthInstance = ReturnType<typeof buildAuth>;
const authCache = new Map<string, TAuthInstance>();

/**
 * One instance per baseURL, cached per isolate.
 *
 * There is NO BETTER_AUTH_URL. OKLocate carries one in Doppler; here the origin
 * is SITE_HOSTS for this MARKETS_ENV, which wrangler bakes per environment, so a
 * second copy in Doppler could only ever disagree with it (removed 2026-09-28,
 * before any environment had one set).
 *
 * baseURL comes from the request host when it is one of ours, so a link sent
 * from staging points at staging. A redirect-only host is NOT ours for this
 * purpose: it redirects before reaching auth, and a magic link built on it would
 * spend its single-use token on the redirect.
 */
export function getAuth(input: { env: unknown; request?: Request }) {
	const env = ZAuthEnv.parse(input.env);
	let baseURL: string = SITE_HOSTS[resolveMarketsEnv(env.MARKETS_ENV)].web;
	if (input.request) {
		try {
			const origin = new URL(input.request.url).origin;
			const host = new URL(origin).hostname;
			const isRedirectOnly = (REDIRECT_HOSTS as readonly string[]).includes(host);
			if (TRUSTED_ORIGINS.includes(origin) && !isRedirectOnly) baseURL = origin;
		} catch {
			// Keep the configured value; a malformed URL is no reason to fail sign-in.
		}
	}
	const cached = authCache.get(baseURL);
	if (cached) return cached;
	const auth = buildAuth(env, baseURL);
	authCache.set(baseURL, auth);
	return auth;
}

/**
 * Throws on failure. Right for actions and for any page that IS the user's own
 * data: silently rendering a signed-out dashboard reads as data loss.
 */
export async function getServerSession(input: {
	env: unknown;
	request: Request;
}) {
	const auth = getAuth(input);
	return await auth.api.getSession({ headers: input.request.headers });
}

/**
 * null instead of throwing, for PUBLIC pages where losing the session should cost
 * a signed-in header and nothing more. Never for actions or dashboard routes.
 */
export async function getServerSessionForDisplay(input: {
	env: unknown;
	request: Request;
}) {
	try {
		return await getServerSession(input);
	} catch (error) {
		console.error(
			"[auth] session lookup failed; serving anonymous:",
			new URL(input.request.url).pathname,
			error,
		);
		return null;
	}
}
