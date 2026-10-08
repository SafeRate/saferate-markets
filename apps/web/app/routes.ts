import type { RouteConfig } from "@react-router/dev/routes";
import { index, layout, route } from "@react-router/dev/routes";

/**
 * Pages are added as they are built rather than stubbed, so a route that exists
 * is a route that works. The customer API is NOT here: it is its own Worker on
 * api.saferate.markets, and this app never serves a Bearer-authenticated
 * endpoint (OKLocate deleted the one it had).
 */
export default [
	index("./routes/_index.tsx"),
	route("about", "./routes/about.tsx"),
	route("capabilities", "./routes/capabilities.tsx"),
	route("data", "./routes/data.tsx"),
	route("docs", "./routes/docs.tsx"),
	route("indices", "./routes/indices.tsx"),
	route("docs/indices", "./routes/docs.indices.tsx"),
	route("pricing", "./routes/pricing.tsx"),
	route("privacy", "./routes/privacy.tsx"),
	route("privacy-choices", "./routes/privacy-choices.tsx"),
	route("terms", "./routes/terms.tsx"),
	route("strategies/ladder-5y", "./routes/strategies.ladder-5y.tsx"),
	route("methodology/treasury-curve", "./routes/methodology.treasury-curve.tsx"),
	route("robots.txt", "./routes/robots.ts"),
	route(".well-known/security.txt", "./routes/security-txt.ts"),
	route("sitemap.xml", "./routes/sitemap.ts"),
	route("llms.txt", "./routes/llms.ts"),
	route("sign-in", "./routes/sign-in.tsx"),
	// Markdown twins of the public pages (lib/publicPages.ts): one route module,
	// one route per path, ids kept distinct. "/.txt" is what the Cloudflare
	// rule makes of "/".
	route(".txt", "./routes/page-twin.ts", { id: "twin:.txt" }),
	route("index.txt", "./routes/page-twin.ts", { id: "twin:index.txt" }),
	route("data.txt", "./routes/page-twin.ts", { id: "twin:data.txt" }),
	route("indices.txt", "./routes/page-twin.ts", { id: "twin:indices.txt" }),
	route("capabilities.txt", "./routes/page-twin.ts", {
		id: "twin:capabilities.txt",
	}),
	route("about.txt", "./routes/page-twin.ts", { id: "twin:about.txt" }),
	route("pricing.txt", "./routes/page-twin.ts", { id: "twin:pricing.txt" }),
	route("docs.txt", "./routes/page-twin.ts", { id: "twin:docs.txt" }),
	route("docs/indices.txt", "./routes/page-twin.ts", {
		id: "twin:docs/indices.txt",
	}),
	route("terms.txt", "./routes/page-twin.ts", { id: "twin:terms.txt" }),
	route("privacy.txt", "./routes/page-twin.ts", { id: "twin:privacy.txt" }),
	route("strategies/ladder-5y.txt", "./routes/page-twin.ts", {
		id: "twin:strategies/ladder-5y.txt",
	}),
	route("methodology/treasury-curve.txt", "./routes/page-twin.ts", {
		id: "twin:methodology/treasury-curve.txt",
	}),
	route("sign-out", "./routes/sign-out.tsx"),
	layout("./routes/dashboard.layout.tsx", [
		route("dashboard", "./routes/dashboard.tsx"),
		route("dashboard/billing", "./routes/dashboard.billing.tsx"),
		route("dashboard/keys", "./routes/dashboard.keys.tsx"),
		route("dashboard/auctions", "./routes/dashboard.auctions.tsx"),
		route("dashboard/backtest", "./routes/dashboard.backtest.tsx"),
		route("dashboard/rates", "./routes/dashboard.rates.tsx"),
		route("dashboard/rich-cheap", "./routes/dashboard.rich-cheap.tsx"),
		route("dashboard/curves", "./routes/dashboard.curves.tsx"),
		route("dashboard/indices", "./routes/dashboard.indices.tsx"),
		route("dashboard/indices/:code", "./routes/dashboard.indices.$code.tsx"),
		route("dashboard/on-the-run", "./routes/dashboard.on-the-run.tsx"),
		route("dashboard/securities", "./routes/dashboard.securities.tsx"),
		route(
			"dashboard/securities/:cusip",
			"./routes/dashboard.securities.$cusip.tsx",
		),
		route("dashboard/stress", "./routes/dashboard.stress.tsx"),
		route("dashboard/builder", "./routes/dashboard.builder.tsx"),
		route("dashboard/liabilities", "./routes/dashboard.liabilities.tsx"),
		route(
			"dashboard/liabilities/:idLiabilityStream",
			"./routes/dashboard.liabilities.$idLiabilityStream.tsx",
		),
		route("dashboard/plans/:idPlan", "./routes/dashboard.plans.$idPlan.tsx"),
		route("dashboard/execution", "./routes/dashboard.execution.tsx"),
		route("dashboard/portfolios", "./routes/dashboard.portfolios.tsx"),
		route(
			"dashboard/portfolios/:idPortfolio",
			"./routes/dashboard.portfolios.$idPortfolio.tsx",
		),
		route(
			"dashboard/portfolios/:idPortfolio/transactions",
			"./routes/dashboard.portfolios.$idPortfolio.transactions.tsx",
		),
	]),
	// JSON for the trade form's CUSIP search; outside the layout (no page).
	route(
		"dashboard/securities/search",
		"./routes/dashboard.securities.search.ts",
	),
	// The order sheet download: a CSV, not a page.
	route(
		"dashboard/plans/:idPlan/orders.csv",
		"./routes/dashboard.plans.$idPlan.orders.csv.ts",
	),
] satisfies RouteConfig;
