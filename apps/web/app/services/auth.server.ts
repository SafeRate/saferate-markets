import { resolveEmailProvider } from "@markets/email";
import {
	PRODUCT_NAME,
	REDIRECT_HOSTS,
	resolveMarketsEnv,
	SENDER_ADDRESS,
	SITE_HOSTS,
} from "@markets/schema";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { z } from "zod";
import { magicLinkEmail } from "@/services/authEmail";
import createD1Adapter from "@/services/d1Adapter";

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
 * Stripe is not mounted yet. It arrives with billing, as OKLocate's does:
 * mounted unconditionally so its endpoints stay typed, and never able to take
 * sign-in down over a billing misconfiguration.
 */

const ZAuthEnv = z.object({
	BETTER_AUTH_SECRET: z.string().min(1),
	DB: z.custom<D1Database>((v) => v !== null && v !== undefined),
	// Optional: local dev has no binding and falls back to the console provider,
	// which prints the link.
	EMAIL: z.custom<SendEmail>().optional(),
	MARKETS_ENV: z.string().optional(),
	EMAIL_RECIPIENT_ALLOWLIST: z.string().optional(),
});
type TAuthEnv = z.infer<typeof ZAuthEnv>;

/** Every origin this app is served from, derived rather than typed twice. */
const TRUSTED_ORIGINS: string[] = Object.values(SITE_HOSTS).map((h) => h.web);

const buildAuth = (env: TAuthEnv, baseURL: string) =>
	betterAuth({
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
		],
	});

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
