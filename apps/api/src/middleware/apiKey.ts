import { authenticateApiKey, extractApiKey } from "@markets/persistence";
import { SITE_HOSTS, resolveMarketsEnv } from "@markets/schema";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";

/**
 * Bearer key authentication, for REST and MCP alike.
 *
 * Registered on /v1/* and /mcp so a route added under either later is
 * authenticated by default rather than silently public.
 *
 * A 401 short-circuits here and is deliberately NOT metered: there is no
 * organization to attribute it to, and a refused request did no work.
 *
 * `WWW-Authenticate: Bearer` on every 401. MCP clients read it to decide that
 * the server wants a credential, and it costs a REST caller nothing.
 */
export const apiKeyAuth = () =>
	createMiddleware<AppEnv>(async (c, next) => {
		c.set("startedAt", Date.now());
		const dashboard = `${SITE_HOSTS[resolveMarketsEnv(c.env.MARKETS_ENV)].web}/dashboard/keys`;

		const key = extractApiKey(c.req.header("Authorization") ?? null);
		if (!key) {
			c.header("WWW-Authenticate", 'Bearer realm="saferate-markets"');
			return c.json(
				{
					error: "unauthorized" as const,
					message: `Send your API key as \`Authorization: Bearer srm_live_...\`. Create one at ${dashboard}.`,
				},
				401,
			);
		}

		const row = await authenticateApiKey({ db: c.env.DB, key });
		if (!row) {
			// One message for "never existed", "revoked" and "expired". Telling them
			// apart tells an attacker which guessed keys were once real.
			c.header(
				"WWW-Authenticate",
				'Bearer realm="saferate-markets", error="invalid_token"',
			);
			return c.json(
				{ error: "unauthorized" as const, message: "That API key is not valid." },
				401,
			);
		}

		c.set("auth", row);
		await next();
	});
