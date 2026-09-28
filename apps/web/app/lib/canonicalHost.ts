import { REDIRECT_HOSTS, SITE_HOSTS } from "@markets/schema";

/**
 * saferate.markets is canonical. The names that only redirect to it —
 * www.saferate.markets, saferate.market, www.saferate.market and
 * markets.saferate.com — are claimed by this Worker (wrangler.jsonc) and sent
 * here with a 301, path and query preserved.
 *
 * In the Worker rather than a zone Redirect Rule so it lives in version control
 * and can be tested; an undocumented dashboard rule is how config drift starts.
 * The list comes from REDIRECT_HOSTS, the same one wrangler's routes mirror.
 *
 * Exported and tested directly: a redirect verified by re-implementing it in a
 * test proves nothing about the code that ships.
 */
export const canonicalHostRedirect = (request: Request) => {
	const url = new URL(request.url);
	if (!(REDIRECT_HOSTS as readonly string[]).includes(url.hostname)) {
		return null;
	}
	const target = new URL(SITE_HOSTS.production.web);
	target.pathname = url.pathname;
	target.search = url.search;
	return Response.redirect(target.toString(), 301);
};
