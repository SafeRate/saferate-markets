/**
 * What the API serves, for the docs page. A curated overview, NOT the
 * reference (that is generated at /reference). apps/api/tests/surfaces.test.ts
 * holds it to the API: every path here must be a published route, and every
 * published /v1 route must be here, so the overview cannot silently fall behind.
 */

export type TApiSurface = {
	group: string;
	/** The MCP tool covering the same data, when there is one. */
	tool: string | null;
	routes: { path: string; what: string }[];
};

export const API_SURFACES: readonly TApiSurface[] = [
	{
		group: "Curves",
		tool: "get_treasury_curve, get_treasury_rate_history",
		routes: [
			{
				path: "/v1/curves/zero",
				what: "Fitted zero-coupon curve, with fit diagnostics",
			},
			{ path: "/v1/curves/par", what: "Par yield curve, 3 months to 30 years" },
			{ path: "/v1/curves/money-market", what: "Bill curve, 1 week to 1 year" },
			{ path: "/v1/curves/real", what: "TIPS real yield curve" },
			{
				path: "/v1/curves/breakeven",
				what: "Breakeven inflation, nominal less real",
			},
			{ path: "/v1/curves/zero/history", what: "Zero curve over a range" },
			{ path: "/v1/curves/money-market/history", what: "Bill curve over a range" },
			{ path: "/v1/curves/real/history", what: "Real curve over a range" },
		],
	},
	{
		group: "Securities",
		tool: "get_treasury_security, list_treasury_securities",
		routes: [
			{ path: "/v1/securities", what: "Every security priced on a day" },
			{ path: "/v1/on-the-run", what: "On- and off-the-run securities by tenor" },
			{
				path: "/v1/securities/{cusip}",
				what: "One CUSIP: terms, auctions, latest price and analytics",
			},
			{ path: "/v1/securities/{cusip}/prices", what: "Its daily prices" },
			{
				path: "/v1/securities/{cusip}/analytics",
				what: "Its daily duration, DV01, key rates and curve residual",
			},
		],
	},
	{
		group: "Rich/cheap",
		tool: "get_treasury_rich_cheap",
		routes: [
			{
				path: "/v1/rich-cheap",
				what: "Notes and bonds furthest from the curve, ranked by z-score",
			},
		],
	},
	{
		group: "Auctions",
		tool: "get_treasury_auctions",
		routes: [
			{
				path: "/v1/auctions",
				what:
					"Auctions in a date window: announced, auctioned and settled, with results",
			},
			{
				path: "/v1/auctions/latest",
				what:
					"Each term's latest result, with changes against up to six previous auctions",
			},
		],
	},
	{
		group: "Indices",
		tool: "get_treasury_index",
		routes: [
			{
				path: "/v1/indices",
				what: "Every index, latest daily and month-end levels",
			},
			{ path: "/v1/indices/{code}", what: "One index" },
			{ path: "/v1/indices/{code}/levels", what: "Daily total-return levels" },
			{
				path: "/v1/indices/{code}/returns",
				what: "Month-, quarter- and year-to-date returns",
			},
			{
				path: "/v1/indices/{code}/analytics",
				what: "Yield, duration, convexity, key rates",
			},
			{ path: "/v1/indices/{code}/constituents", what: "What it holds now" },
			{
				path: "/v1/indices/{code}/constituents/{date}",
				what: "What it held in a completed period",
			},
		],
	},
	{
		group: "Calculators",
		tool: "price_treasury_security",
		routes: [
			{ path: "/v1/price/coupon", what: "Price or yield a note or bond" },
			{ path: "/v1/price/bill", what: "Price or yield a bill" },
		],
	},
	{
		group: "Debt",
		tool: "get_treasury_debt",
		routes: [
			{ path: "/v1/debt", what: "Federal debt from the monthly statement" },
			{ path: "/v1/strips", what: "How much is held as STRIPS" },
		],
	},
	{
		group: "Savings bonds",
		tool: "get_savings_bond_rates, value_savings_bond",
		routes: [
			{ path: "/v1/savings-bonds/rates", what: "Series I and EE rates" },
			{ path: "/v1/savings-bonds/i/value", what: "Value a Series I bond" },
			{ path: "/v1/savings-bonds/ee/value", what: "Value a Series EE bond" },
		],
	},
];
