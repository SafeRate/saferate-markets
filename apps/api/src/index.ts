import { OpenAPIHono } from "@hono/zod-openapi";
import { PRODUCT_NAME, resolveMarketsEnv, SITE_HOSTS } from "@markets/schema";
import { Scalar } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import type { AppEnv } from "./env";
import { apiKeyAuth } from "./middleware/apiKey";
import { meterUsage } from "./middleware/meter";
import { rateLimit } from "./middleware/rateLimit";
import { registerCurveFamilyRoutes } from "./routes/curveFamilies";
import { registerAuctionRoutes } from "./routes/auctions";
import { registerCurveRoutes } from "./routes/curves";
import { registerDebtRoutes } from "./routes/debt";
import { registerIndexRoutes } from "./routes/indices";
import { registerMcpRoute } from "./routes/mcp";
import { registerPricingRoutes } from "./routes/pricing";
import { registerRichCheapRoutes } from "./routes/richCheap";
import { registerSavingsBondRoutes } from "./routes/savingsBonds";
import { registerSecurityRoutes } from "./routes/securities";
import { registerSecurityListRoutes } from "./routes/securityLists";

/**
 * api.saferate.markets: the REST API and the MCP server.
 *
 * Bearer keys only. No Better Auth, no sessions, no cookies, no email, no
 * secrets. Structure ported from saferate-oklocate/apps/api.
 */

const app = new OpenAPIHono<AppEnv>({
	// A rejected query answers in the same envelope as every other error, so a
	// caller parses one shape.
	defaultHook: (result, c) => {
		if (result.success) return;
		return c.json(
			{
				error: "bad_request" as const,
				message: result.error.issues
					.map((i) => `${i.path.join(".") || "request"}: ${i.message}`)
					.join("; "),
			},
			400,
		);
	},
});

/**
 * Open CORS, deliberately. The credential is a header the caller sets, never a
 * cookie, so a permissive origin grants nothing an attacker did not already
 * hold. `credentials` stays off: there are no cookies, and it would forbid the
 * wildcard anyway. The MCP headers are allowed so a browser-hosted MCP client
 * can connect.
 */
app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
		allowHeaders: [
			"Authorization",
			"Content-Type",
			"Mcp-Method",
			"Mcp-Name",
			"Mcp-Protocol-Version",
		],
		exposeHeaders: ["WWW-Authenticate"],
		maxAge: 86_400,
	}),
);

/** Closed to crawlers everywhere until the product is announced. */
app.use("*", async (c, next) => {
	await next();
	c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
});

app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));

// The site's icon, not a second copy of it. Every browser tab on /reference
// asked for this and got a JSON 404 (seen in the production tail, 2026-09-28).
app.get("/favicon.ico", (c) =>
	c.redirect(
		`${SITE_HOSTS[resolveMarketsEnv(c.env.MARKETS_ENV)].web}/favicon.ico`,
		301,
	),
);

/** Liveness only. Unauthenticated, and says nothing about bindings or data. */
app.get("/health", (c) =>
	c.json({
		status: "ok",
		environment: resolveMarketsEnv(c.env.MARKETS_ENV),
	}),
);

// Auth, then rate limit, then meter, on everything under /v1: a route added
// later is authenticated, limited and counted by default.
app.use("/v1/*", apiKeyAuth(), rateLimit(), meterUsage("rest"));
registerCurveRoutes(app);
registerCurveFamilyRoutes(app);
registerIndexRoutes(app);
registerSecurityRoutes(app);
registerSecurityListRoutes(app);
registerRichCheapRoutes(app);
registerAuctionRoutes(app);
registerPricingRoutes(app);
registerDebtRoutes(app);
registerSavingsBondRoutes(app);

registerMcpRoute(app);

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
	type: "http",
	scheme: "bearer",
	description:
		"Your API key, from the dashboard. Send it as `Authorization: Bearer srm_live_...`. The same key authenticates the MCP server at /mcp.",
});

app.doc("/openapi.json", (c) => {
	const hosts = SITE_HOSTS[resolveMarketsEnv(c.env.MARKETS_ENV)];
	return {
		openapi: "3.1.0",
		// Document-level, not per operation. apiKeyAuth wraps ALL of /v1/*, and a
		// document default is the same default-on posture: OKLocate published a
		// route as public while the Worker 401ed it, because security was only
		// declared per operation.
		security: [{ bearerAuth: [] }],
		info: {
			title: `${PRODUCT_NAME} API`,
			version: "0.1.0",
			description: `U.S. Treasury market data from Safe Rate: fitted curves, securities, analytics and indices. End-of-day records for business days from 2008-09-02, not live prices. Manage keys at ${hosts.web}/dashboard/keys. The same data is available to AI assistants over MCP at ${hosts.api}/mcp.`,
		},
		servers: [{ url: new URL(c.req.url).origin }],
	};
});

app.get(
	"/reference",
	Scalar({ url: "/openapi.json", pageTitle: `${PRODUCT_NAME} API reference` }),
);

// 301: a 302 tells a crawler both URLs are live, and OKLocate's was filed as
// "Duplicate without user-selected canonical" for it (2026-10-07).
app.get("/", (c) => c.redirect("/reference", 301));

// JSON to the last byte. A client should never parse an HTML error page.
app.notFound((c) =>
	c.json(
		{
			error: "bad_request" as const,
			message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}. See /reference.`,
		},
		404,
	),
);

app.onError((error, c) => {
	console.error("[api] unhandled", new URL(c.req.url).pathname, error);
	return c.json(
		{ error: "internal" as const, message: "An unexpected error occurred." },
		500,
	);
});

export default app;
