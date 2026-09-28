import type { RouteConfig } from "@react-router/dev/routes";
import { index, route } from "@react-router/dev/routes";

/**
 * Pages are added as they are built rather than stubbed, so a route that exists
 * is a route that works. The customer API is NOT here: it is its own Worker on
 * api.saferate.markets, and this app never serves a Bearer-authenticated
 * endpoint (OKLocate deleted the one it had).
 */
export default [
	index("./routes/_index.tsx"),
	route("docs", "./routes/docs.tsx"),
	route("docs/indices", "./routes/docs.indices.tsx"),
	route("pricing", "./routes/pricing.tsx"),
	route("privacy", "./routes/privacy.tsx"),
	route("privacy-choices", "./routes/privacy-choices.tsx"),
	route("terms", "./routes/terms.tsx"),
	route("sign-in", "./routes/sign-in.tsx"),
	route("sign-out", "./routes/sign-out.tsx"),
	route("dashboard", "./routes/dashboard.tsx"),
	route("dashboard/billing", "./routes/dashboard.billing.tsx"),
	route("dashboard/keys", "./routes/dashboard.keys.tsx"),
] satisfies RouteConfig;
