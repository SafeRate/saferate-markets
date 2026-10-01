import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { snakeKeys } from "@markets/mcp-tools";
import {
	INDEX_DISPLAY_ORDER,
	INDEX_META,
	isIndexCode,
	type TIndexCode,
} from "@saferate/treasury-client/types";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { GATE_RESPONSES, ZError } from "../lib/errors";
import {
	readAnalytics,
	readConstituentsOn,
	readDailyLevels,
	readDailyLevelsOn,
	readLatestLevels,
	readOpenConstituents,
	readReturns,
} from "@markets/mcp-tools";
import { treasuryErrorResponse, treasuryUnbound } from "../lib/treasury";

/**
 * The Safe Rate Treasury total-return indices over REST.
 *
 * Every response schema is DECLARED here, because the client's schemas are
 * transforms and a transform has no OpenAPI form. tests/indices.test.ts pins
 * each one: it runs a fixture of real upstream rows (fetched from production
 * treasury-api 2026-09-28) through the client's own parser and requires these
 * .strict() schemas to accept the result exactly.
 *
 * Numbers are the client's: returns and weights in PERCENT, convexity in the
 * published convention (divided by 100), index levels as total-return levels.
 */

const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const CODES = INDEX_DISPLAY_ORDER as readonly string[];

const ZCodeParam = z.object({
	code: z.string().openapi({
		description: `Index code. One of: ${CODES.join(", ")}.`,
		example: "broad",
	}),
});

// ── Schemas ──────────────────────────────────────────────────────────────────

const ZMonthEnd = z
	.object({
		date: z.string().openapi({ description: "The month-end the level is for." }),
		level: z.number().openapi({
			description:
				"Total-return index level at the close of that month. A rising level usually means yields fell; it is not a yield.",
		}),
		month_return_percent: z
			.number()
			.openapi({ description: "Return over that month, percent." }),
		constituent_count: z.number().int(),
		methodology_version: z.string(),
		is_back_tested: z.boolean().openapi({
			description:
				"True when this level was computed under a 0.x methodology, i.e. reconstructed rather than published live.",
		}),
	})
	.strict()
	.openapi("IndexMonthEndLevel");

export const ZDailyLevelOut = z
	.object({
		date: z.string(),
		level: z.number().openapi({ description: "Total-return index level." }),
		is_provisional: z.boolean().openapi({
			description:
				"True while the day's prices may still be revised, so the level can change. Month-end levels are final.",
		}),
		rebalance_date: z.string().openapi({
			description: "Start of the rebalance period this day belongs to.",
		}),
		return_since_rebalance_percent: z.number(),
	})
	.strict()
	.openapi("IndexDailyLevel");

export const ZIndexSummaryOut = z
	.object({
		code: z.string().openapi({ example: "broad" }),
		name: z.string().openapi({ example: "US Treasury" }),
		ticker: z.string().openapi({ example: "SR-UST-TR" }),
		former_ticker: z.string().nullable().openapi({
			description:
				"A retired ticker, kept so old citations can be traced. Null when there was none.",
		}),
		covers: z.string().openapi({
			example: "Nominal notes and bonds, one year and over",
		}),
		latest: ZDailyLevelOut.nullable().openapi({
			description:
				"The most recent business day's level (or the day asked for with `date`). Null when none is published.",
		}),
		last_month_end: ZMonthEnd.nullable().openapi({
			description:
				"The latest COMPLETED month-end, with its month return. Null with `date`, or when none is published.",
		}),
	})
	.strict()
	.openapi("IndexSummary");

export const ZIndexListOut = z
	.object({ indices: z.array(ZIndexSummaryOut) })
	.strict()
	.openapi("IndexList");

export const ZIndexLevelsOut = z
	.object({ code: z.string(), levels: z.array(ZDailyLevelOut) })
	.strict()
	.openapi("IndexLevels");

export const ZIndexReturnsOut = z
	.object({
		code: z.string(),
		as_of: z.string(),
		mtd_percent: z.number().nullable(),
		qtd_percent: z.number().nullable(),
		ytd_percent: z.number().nullable().openapi({
			description:
				"Null when the index does not yet span the period, for example a year-to-date return before the index has a year-start level.",
		}),
	})
	.strict()
	.openapi("IndexReturns");

export const ZIndexAnalyticsRowOut = z
	.object({
		date: z.string(),
		rebalance_date: z.string().openapi({
			description:
				"The period START: analytics anchored here describe the portfolio struck on this date and held to the next rebalance.",
		}),
		constituent_count: z.number().int(),
		market_value: z.number(),
		par_amount: z.number(),
		average_price: z.number(),
		average_maturity: z.number().openapi({ description: "Years." }),
		coupon_rate_percent: z.number(),
		yield_to_maturity_percent: z.number(),
		modified_duration: z.number(),
		spread_duration: z.number(),
		duration_basis: z.string(),
		convexity: z.number().openapi({
			description:
				"In the published convention (the textbook quantity divided by 100), so the second-order price change for a 1-point yield move is half this value, in percent.",
		}),
		basis_share_percent: z.number(),
		key_rate_durations: z.array(
			z
				.object({
					label: z.string().openapi({ example: "10Y" }),
					years: z.number(),
					value: z.number(),
				})
				.strict(),
		),
	})
	.strict()
	.openapi("IndexAnalytics");

export const ZIndexAnalyticsOut = z
	.object({ code: z.string(), analytics: z.array(ZIndexAnalyticsRowOut) })
	.strict()
	.openapi("IndexAnalyticsList");

const constituentFields = {
	cusip: z.string(),
	maturity: z.string(),
	coupon_percent: z.number(),
	weight_percent: z.number(),
	market_value: z.number(),
	par_auctioned: z.number(),
	par_bought_back: z.number(),
	par_held_in_soma: z.number(),
	float_par: z.number().openapi({
		description:
			"Par in public hands: auctioned, less bought back, less held by the Federal Reserve (SOMA).",
	}),
	start_clean_bid: z.number(),
	start_accrued: z.number(),
	start_dirty: z.number(),
	end_dirty: z.number(),
	coupons_received: z.number(),
	security_return_percent: z.number(),
	contribution_percent: z.number().openapi({
		description: "This security's contribution to the index return, percent.",
	}),
};

export const ZConstituentOut = z
	.object(constituentFields)
	.strict()
	.openapi("IndexConstituent");

export const ZClosedConstituentsOut = z
	.object({
		code: z.string(),
		date: z.string().openapi({
			description:
				"The period END. The list is the portfolio struck at the PREVIOUS rebalance and held through this date.",
		}),
		constituents: z.array(ZConstituentOut),
	})
	.strict()
	.openapi("IndexConstituentsClosed");

export const ZOpenConstituentsOut = z
	.object({
		code: z.string(),
		rebalance_date: z
			.string()
			.openapi({ description: "When the current portfolio was struck." }),
		as_of_date: z.string().openapi({
			description: "The last day the running returns are measured to.",
		}),
		constituents: z.array(ZConstituentOut),
	})
	.strict()
	.openapi("IndexConstituentsOpen");

// ── Shaping ──────────────────────────────────────────────────────────────────

type TMeta = {
	covers: string;
	name: string;
	ticker: string;
	formerTicker?: string;
};

const withoutCodeOne = (value: unknown) => {
	if (value === null) return null;
	const { code: _code, ...rest } = snakeKeys(value) as Record<string, unknown>;
	return rest;
};

const summaryOf = (
	code: TIndexCode,
	latest: unknown | null,
	lastMonthEnd: unknown | null,
) => {
	const meta = (INDEX_META as Record<string, TMeta>)[code];
	return {
		code,
		name: meta.name,
		ticker: meta.ticker,
		former_ticker: meta.formerTicker ?? null,
		covers: meta.covers,
		latest: withoutCodeOne(latest),
		last_month_end: withoutCodeOne(lastMonthEnd),
	};
};

/** Drop the code off each row: it is stated once, on the envelope. */
const withoutCode = (rows: unknown[]) =>
	(snakeKeys(rows) as Record<string, unknown>[]).map(({ code: _c, ...r }) => r);

/** Constituent rows lose their per-row code and period dates: the envelope has them. */
const constituentRows = (rows: unknown[]) =>
	(snakeKeys(rows) as Record<string, unknown>[]).map(
		({ code: _c, date: _d, as_of_date: _a, rebalance_date: _r, ...row }) => row,
	);

const unknownIndex = (c: Context<AppEnv>, code: string) =>
	c.json(
		{
			error: "no_data" as const,
			code: "unknown_index",
			message: `No index "${code}". Codes: ${CODES.join(", ")}. GET /v1/indices lists them with names.`,
		},
		404,
	);

const noData = (c: Context<AppEnv>, message: string) =>
	c.json({ error: "no_data" as const, message }, 404);

const errors = {
	...GATE_RESPONSES,
	400: {
		content: { "application/json": { schema: ZError } },
		description: "A malformed parameter.",
	},
	404: {
		content: { "application/json": { schema: ZError } },
		description:
			"An unknown index code, or nothing published for what was asked.",
	},
	503: {
		content: { "application/json": { schema: ZError } },
		description: "The Treasury data service is unavailable.",
	},
};

const json = <T extends z.ZodType>(schema: T, description: string) => ({
	content: { "application/json": { schema } },
	description,
});

// ── Routes ───────────────────────────────────────────────────────────────────

const listRoute = createRoute({
	method: "get",
	path: "/v1/indices",
	tags: ["Indices"],
	summary: "Every index, with its latest daily and month-end levels",
	description:
		"The eleven Safe Rate Treasury total-return indices: the broad nominal index, five maturity bands, bills, short, inflation-linked, aggregate and floating rate. `latest` is the most recent business day; `last_month_end` is the latest completed month, which is final where recent daily levels can still be provisional. Pass `date` for every index's daily level on that day. Constructed by Safe Rate; not official U.S. Treasury statistics.",
	request: {
		query: z.object({
			date: zIsoDate
				.optional()
				.openapi({ description: "Levels as of this day instead of the latest." }),
		}),
	},
	responses: { 200: json(ZIndexListOut, "The indices."), ...errors },
});

const oneRoute = createRoute({
	method: "get",
	path: "/v1/indices/{code}",
	tags: ["Indices"],
	summary: "One index, with its latest daily and month-end levels",
	request: { params: ZCodeParam },
	responses: { 200: json(ZIndexSummaryOut, "The index."), ...errors },
});

const levelsRoute = createRoute({
	method: "get",
	path: "/v1/indices/{code}/levels",
	tags: ["Indices"],
	summary: "Daily total-return levels",
	description:
		"One row per business day, oldest first. The full history of the broad index is about 4,500 rows; pass `from` and `to` to narrow it.",
	request: {
		params: ZCodeParam,
		query: z.object({
			from: zIsoDate.optional().openapi({ example: "2026-01-01" }),
			to: zIsoDate.optional(),
		}),
	},
	responses: { 200: json(ZIndexLevelsOut, "Daily levels."), ...errors },
});

const returnsRoute = createRoute({
	method: "get",
	path: "/v1/indices/{code}/returns",
	tags: ["Indices"],
	summary: "Month-, quarter- and year-to-date returns",
	request: { params: ZCodeParam },
	responses: { 200: json(ZIndexReturnsOut, "Period returns."), ...errors },
});

const analyticsRoute = createRoute({
	method: "get",
	path: "/v1/indices/{code}/analytics",
	tags: ["Indices"],
	summary: "Yield, duration, convexity and key-rate durations",
	description:
		"Portfolio analytics for the index. Without `date`, the latest rebalance period; with it, the period anchored at that rebalance date.",
	request: {
		params: ZCodeParam,
		query: z.object({ date: zIsoDate.optional() }),
	},
	responses: { 200: json(ZIndexAnalyticsOut, "Analytics."), ...errors },
});

const openConstituentsRoute = createRoute({
	method: "get",
	path: "/v1/indices/{code}/constituents",
	tags: ["Indices"],
	summary: "Current constituents (the open period)",
	description:
		"The securities in the index now, struck at the last rebalance, with returns measured to `as_of_date`. Heaviest first.",
	request: { params: ZCodeParam },
	responses: { 200: json(ZOpenConstituentsOut, "Constituents."), ...errors },
});

const closedConstituentsRoute = createRoute({
	method: "get",
	path: "/v1/indices/{code}/constituents/{date}",
	tags: ["Indices"],
	summary: "Constituents for a completed period",
	description:
		"⚠️ `date` is the period END, a month-end. The list is the portfolio struck at the PREVIOUS month-end and held through `date`, with each security's return over that month. So 2026-08-31 returns the portfolio struck 2026-07-31. Analytics are labeled the other way, by the period start.",
	request: {
		params: ZCodeParam.extend({
			date: zIsoDate.openapi({ example: "2026-08-31" }),
		}),
	},
	responses: { 200: json(ZClosedConstituentsOut, "Constituents."), ...errors },
});

export const registerIndexRoutes = (app: OpenAPIHono<AppEnv>) => {
	app.openapi(listRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const { date } = c.req.valid("query");
		try {
			const daily = await readDailyLevelsOn(c.env, date);
			if (date !== undefined && daily.length === 0) {
				return noData(
					c,
					`No index levels for ${date}. Levels are published for business days only.`,
				);
			}
			// With `date`, only that day's levels: a "last month-end" relative to
			// today would not describe the day asked for.
			const monthEnd = date === undefined ? await readLatestLevels(c.env) : [];
			const dailyByCode = new Map(daily.map((l) => [l.code, l]));
			const monthEndByCode = new Map(monthEnd.map((l) => [l.code, l]));
			return c.json(
				ZIndexListOut.parse({
					indices: INDEX_DISPLAY_ORDER.map((code) =>
						summaryOf(
							code,
							dailyByCode.get(code) ?? null,
							monthEndByCode.get(code) ?? null,
						),
					),
				}),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});

	app.openapi(oneRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const { code } = c.req.valid("param");
		if (!isIndexCode(code)) return unknownIndex(c, code);
		try {
			const [daily, monthEnd] = await Promise.all([
				readDailyLevelsOn(c.env),
				readLatestLevels(c.env),
			]);
			return c.json(
				ZIndexSummaryOut.parse(
					summaryOf(
						code,
						daily.find((l) => l.code === code) ?? null,
						monthEnd.find((l) => l.code === code) ?? null,
					),
				),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});

	app.openapi(levelsRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const { code } = c.req.valid("param");
		const { from, to } = c.req.valid("query");
		if (!isIndexCode(code)) return unknownIndex(c, code);
		try {
			const levels = await readDailyLevels(c.env, { code, from, to });
			if (levels.length === 0) {
				return noData(c, `No daily levels for ${code} in that range.`);
			}
			return c.json(
				ZIndexLevelsOut.parse({ code, levels: withoutCode(levels) }),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});

	app.openapi(returnsRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const { code } = c.req.valid("param");
		if (!isIndexCode(code)) return unknownIndex(c, code);
		try {
			const returns = await readReturns(c.env, code);
			if (returns === null) return noData(c, `No returns published for ${code}.`);
			return c.json(ZIndexReturnsOut.parse(snakeKeys(returns)), 200);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});

	app.openapi(analyticsRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const { code } = c.req.valid("param");
		const { date } = c.req.valid("query");
		if (!isIndexCode(code)) return unknownIndex(c, code);
		try {
			const analytics = await readAnalytics(c.env, { code, date });
			if (analytics.length === 0) {
				return noData(
					c,
					date === undefined
						? `No analytics published for ${code}.`
						: `No analytics for ${code} anchored at ${date}. Analytics exist at rebalance dates (month-ends) only.`,
				);
			}
			return c.json(
				ZIndexAnalyticsOut.parse({ code, analytics: snakeKeys(analytics) }),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});

	app.openapi(openConstituentsRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const { code } = c.req.valid("param");
		if (!isIndexCode(code)) return unknownIndex(c, code);
		try {
			const open = await readOpenConstituents(c.env, code);
			if (open === null) {
				return noData(
					c,
					`No open-period snapshot for ${code} yet. It is written after each business day's run.`,
				);
			}
			return c.json(
				ZOpenConstituentsOut.parse({
					code,
					rebalance_date: open.rebalanceDate,
					as_of_date: open.asOfDate,
					constituents: constituentRows(open.rows),
				}),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});

	app.openapi(closedConstituentsRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const { code, date } = c.req.valid("param");
		if (!isIndexCode(code)) return unknownIndex(c, code);
		try {
			const rows = await readConstituentsOn(c.env, { code, date });
			if (rows === null) {
				return noData(
					c,
					`No completed period for ${code} ends on ${date}. Periods end at month-ends; use the last business day of a month.`,
				);
			}
			return c.json(
				ZClosedConstituentsOut.parse({
					code,
					date,
					constituents: constituentRows(rows),
				}),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});
};
