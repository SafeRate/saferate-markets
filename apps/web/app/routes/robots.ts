import { resolveMarketsEnv } from "@markets/schema";
import type { Route } from "./+types/robots";

/**
 * robots.txt. Production welcomes every search engine and AI agent (Dylan,
 * 2026-10-05: "we want to welcome everything"), with the content signals
 * saferate.com publishes: search, AI input and AI training all yes. Only the
 * signed-in dashboard and the auth endpoints are out, since a crawler finds
 * nothing there but a redirect to sign-in.
 *
 * Every other environment disallows everything, so staging never competes with
 * the real site in an index. The sitemap URL is this host's own.
 */
export const loader = ({ request, context }: Route.LoaderArgs) => {
	const origin = new URL(request.url).origin;
	const production =
		resolveMarketsEnv(context.cloudflare.env.MARKETS_ENV) === "production";
	const body = production
		? `# Safe Rate Markets
# Every public page is open to search engines and AI agents, and each has a
# markdown version at <page>.txt (the home page at /index.txt).
# An index for AI agents: ${origin}/llms.txt

User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=yes
Allow: /
Disallow: /dashboard
Disallow: /api/auth/

Sitemap: ${origin}/sitemap.xml
`
		: `# Not the production site: nothing here is for an index.
User-agent: *
Disallow: /
`;
	return new Response(body, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
};
