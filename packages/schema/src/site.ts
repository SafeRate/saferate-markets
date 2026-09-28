import { z } from "zod";

/**
 * Where each surface lives, per environment. The single source: wrangler routes,
 * Better Auth's trusted origins, the canonical-host redirect and every link from
 * the site to the API read these, so a hostname cannot be right in one place and
 * stale in another.
 *
 * saferate.markets rather than markets.saferate.com, decided 2026-09-28:
 *
 *  - Every name is ONE level deep, so Cloudflare's free universal certificate
 *    covers it. Under saferate.com the API would have been api.markets.saferate.com,
 *    which serves no valid certificate (saferate-treasury hit exactly that with
 *    api.treasury.saferate.com).
 *  - A separate registrable domain means the portal's session cookies cannot be
 *    read or set by anything on saferate.com, and the reverse.
 *
 * Mail is sent from notifications.saferate.markets. See packages/email/src/provider.ts.
 */

export const ZMarketsEnv = z.enum(["development", "staging", "production"]);
export type TMarketsEnv = z.infer<typeof ZMarketsEnv>;

export const SITE_HOSTS = {
	development: {
		web: "http://localhost:3020",
		api: "http://localhost:5320",
	},
	staging: {
		web: "https://staging.saferate.markets",
		api: "https://api-staging.saferate.markets",
	},
	production: {
		web: "https://saferate.markets",
		api: "https://api.saferate.markets",
	},
} as const satisfies Record<TMarketsEnv, { web: string; api: string }>;

/**
 * Hosts that answer only to redirect to the production site. Claimed rather than
 * left parked, so none of them can be taken over or serve something else.
 */
export const REDIRECT_HOSTS = [
	"www.saferate.markets",
	"saferate.market",
	"www.saferate.market",
	"markets.saferate.com",
] as const;

/**
 * Unknown or missing is DEVELOPMENT, never production. A value that failed to
 * arrive must not switch on production behaviour (unguarded email, indexing).
 */
export const resolveMarketsEnv = (value: unknown): TMarketsEnv => {
	const parsed = ZMarketsEnv.safeParse(value);
	return parsed.success ? parsed.data : "development";
};

export const SENDER_ADDRESS = "noreply@notifications.saferate.markets";
export const CONTACT_ADDRESS = "team@saferate.com";
export const PRODUCT_NAME = "Safe Rate Markets";
