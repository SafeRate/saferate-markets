import { resolveMarketsEnv, SITE_HOSTS } from "@markets/schema";

/**
 * The origin to NAME the site by: saferate.markets on production whichever
 * host served the request (markets.saferate.com serves it too; see
 * ALTERNATE_HOSTS), and the request's own origin elsewhere, so staging still
 * names staging. Used for canonical links, the sitemap, robots.txt and
 * llms.txt, so search engines see one address.
 */
export const canonicalOrigin = (
	env: { MARKETS_ENV?: unknown },
	request: Request,
) =>
	resolveMarketsEnv(env.MARKETS_ENV) === "production"
		? SITE_HOSTS.production.web
		: new URL(request.url).origin;
