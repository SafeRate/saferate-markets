import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { snakeKeys } from "@markets/mcp-tools";
import {
	getBreakevenOn,
	getCurvesOn,
	getLatestCurve,
	getMoneyMarketSeries,
	getRealCurveOn,
	getRealCurveSeries,
	getZeroCurveSeries,
} from "@saferate/treasury-client/client";
import {
	REAL_CURVE_FIT_SUSPECT_BP,
	TREASURY_COVERAGE_START,
} from "@saferate/treasury-client/types";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { GATE_RESPONSES, ZError } from "../lib/errors";
import { treasuryErrorResponse, treasuryUnbound } from "../lib/treasury";
import { ZZeroCurvePointOut } from "./curves";

/**
 * The curves beside the zero curve: par, money market, real (TIPS) and
 * breakeven for one day, and the zero, money market and real curves over a
 * range. The MCP tools (get_treasury_curve, get_treasury_rate_history) already
 * serve all of these through the same client functions; this is the REST side.
 *
 * Schemas are DECLARED (the client's are transforms) and pinned by
 * tests/curveFamilies.test.ts, which runs production rows for 2026-09-25
 * through the client's parsers into these .strict() schemas.
 */

const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const ZRate = z
	.object({
		label: z.string().openapi({ example: "10Y" }),
		rate: z.number().openapi({ description: "Percent." }),
		tenor_years: z.number(),
	})
	.strict()
	.openapi("CurveRate");

export const ZParCurveOut = z
	.object({
		date: z.string(),
		has_converged: z.boolean(),
		max_residual_basis_points: z.number(),
		rates: z.array(ZRate),
		rmse_basis_points: z.number(),
		security_count: z.number().int(),
	})
	.strict()
	.openapi("ParCurve");

export const ZMoneyMarketCurveOut = z
	.object({
		bill_count: z.number().int(),
		convention: z.string().openapi({
			description: "The yield convention the rates are quoted in.",
			example: "bond equivalent",
		}),
		date: z.string(),
		has_converged: z.boolean(),
		implied_overnight: z.number().openapi({
			description: "The curve's intercept: an implied overnight rate, percent.",
		}),
		max_residual_basis_points: z.number(),
		rates: z.array(ZRate),
		rmse_basis_points: z.number(),
	})
	.strict()
	.openapi("MoneyMarketCurve");

export const ZRealCurveOut = z
	.object({
		date: z.string(),
		has_converged: z.boolean(),
		max_price_error_cents: z.number(),
		rates: z.array(ZRate),
		rmse_basis_points: z.number().openapi({
			description: `Fit error. Treat a day above ${REAL_CURVE_FIT_SUSPECT_BP} bp with care.`,
		}),
		tips_count: z.number().int(),
	})
	.strict()
	.openapi("RealCurve");

export const ZBreakevenOut = z
	.object({
		date: z.string(),
		missing_tenors: z.array(z.number()).openapi({
			description:
				"Tenors among 2, 3, 5, 7, 10 and 20 years with no breakeven that day, because one of the two curves published no rate there. Never interpolated.",
		}),
		points: z.array(
			z
				.object({
					tenor_years: z.number(),
					nominal: z
						.number()
						.openapi({ description: "Nominal zero rate, percent." }),
					real: z.number().openapi({ description: "Real zero rate, percent." }),
					breakeven: z.number().openapi({
						description:
							"nominal minus real, percent. Exact, since both are continuously compounded.",
					}),
				})
				.strict(),
		),
	})
	.strict()
	.openapi("BreakevenInflation");

// ── One day ──────────────────────────────────────────────────────────────────

/** The validated query; the routes are built by a factory, so typed loosely. */
const queryOf = <T>(c: Context<AppEnv>) =>
	(c.req as unknown as { valid: (target: "query") => T }).valid("query");

/** How far back an omitted date looks for a day with this family fitted. */
const LOOKBACK_DAYS = 7;

const dayBefore = (date: string) =>
	new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000)
		.toISOString()
		.slice(0, 10);

type TDayFamily = {
	slug: string;
	summary: string;
	description: string;
	schema: z.ZodType;
	name: string;
	read: (env: AppEnv["Bindings"], date: string) => Promise<unknown | null>;
};

const DAY_FAMILIES: TDayFamily[] = [
	{
		slug: "par",
		name: "par curve",
		summary: "Treasury par curve for one day",
		description:
			"The par yield curve from 3 months to 30 years: the coupon at which a bond at each maturity would price at par. Fitted from coupon securities.",
		schema: ZParCurveOut,
		read: (env, date) =>
			getCurvesOn({ date, env }).then((day) => day?.par ?? null),
	},
	{
		slug: "money-market",
		name: "money market curve",
		summary: "Treasury bill (money market) curve for one day",
		description:
			"The short end from one week to one year, fitted to Treasury bills rather than extrapolated from coupons. Read rates under a year here, not off the zero curve.",
		schema: ZMoneyMarketCurveOut,
		read: (env, date) =>
			getCurvesOn({ date, env }).then((day) => day?.moneyMarket ?? null),
	},
	{
		slug: "real",
		name: "real (TIPS) curve",
		summary: "TIPS real yield curve for one day",
		description:
			"Real zero rates from 2 to 30 years, fitted to TIPS. Real yields sit above inflation rather than including it, so they are not comparable to the nominal curve without the breakeven.",
		schema: ZRealCurveOut,
		read: (env, date) => getRealCurveOn({ date, env }),
	},
	{
		slug: "breakeven",
		name: "breakeven inflation",
		summary: "Breakeven inflation for one day",
		description:
			"Nominal minus real zero rate at 2, 3, 5, 7, 10 and 20 years: the average inflation over each horizon at which TIPS and nominal Treasuries would return the same. It includes an inflation risk premium and a TIPS liquidity premium, so it is a market price, not a forecast.",
		schema: ZBreakevenOut,
		read: (env, date) => getBreakevenOn({ date, env }),
	},
];

const dayRoute = (family: TDayFamily) =>
	createRoute({
		method: "get",
		path: `/v1/curves/${family.slug}`,
		summary: family.summary,
		description: `${family.description} Omit \`date\` for the most recent fitted day. Coverage starts ${TREASURY_COVERAGE_START}.`,
		tags: ["Curves"],
		request: {
			query: z.object({
				date: zIsoDate.optional().openapi({ example: "2026-09-25" }),
			}),
		},
		responses: {
			...GATE_RESPONSES,
			200: {
				content: { "application/json": { schema: family.schema } },
				description: "The curve.",
			},
			400: {
				content: { "application/json": { schema: ZError } },
				description: "Malformed date, or one outside coverage.",
			},
			404: {
				content: { "application/json": { schema: ZError } },
				description: `No ${family.name} that day: a weekend, a federal holiday, or a day not yet published.`,
			},
			503: {
				content: { "application/json": { schema: ZError } },
				description: "The Treasury data service is unavailable.",
			},
		},
	});

const handleDay =
	(family: TDayFamily) =>
	async (c: Context<AppEnv>, date: string | undefined) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		// Before coverage the client refuses the date by throwing, which the
		// catch below reported as a 500. Found 2026-10-01; the 400 is documented.
		if (date !== undefined && date < TREASURY_COVERAGE_START)
			return badRange(
				c,
				`Coverage starts ${TREASURY_COVERAGE_START}; ${date} is before it.`,
			);
		try {
			let on = date;
			if (on === undefined) {
				const latest = await getLatestCurve({ env: c.env });
				if (latest === null) {
					return c.json(
						{ error: "no_data" as const, message: "No fitted curve is available." },
						404,
					);
				}
				on = latest.date;
			}
			let row = await family.read(c.env, on);
			// The latest nominal day can precede this family's fit; step back.
			for (
				let step = 1;
				date === undefined && row === null && step < LOOKBACK_DAYS;
				step += 1
			) {
				on = dayBefore(on);
				row = await family.read(c.env, on);
			}
			if (row === null) {
				return c.json(
					{
						error: "no_data" as const,
						message:
							date === undefined
								? `No recent day has a ${family.name}.`
								: `No ${family.name} on ${date}. Treasury publishes on business days only, so weekends, federal holidays and days not yet published return nothing. Omit date for the most recent fitted day.`,
					},
					404,
				);
			}
			return c.json(family.schema.parse(snakeKeys(row)), 200);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	};

// ── History ──────────────────────────────────────────────────────────────────

type THistory = {
	slug: string;
	name: string;
	maxDays: number;
	out: z.ZodType;
	read: (
		env: AppEnv["Bindings"],
		from: string,
		to: string,
	) => Promise<unknown[]>;
	field: "points" | "days";
};

const HISTORIES: THistory[] = [
	{
		slug: "zero",
		name: "zero curve",
		// Ten rows a day; a year is about 2,520, well inside upstream's cap.
		maxDays: 366,
		field: "points",
		out: z
			.object({
				from: z.string(),
				to: z.string(),
				points: z.array(ZZeroCurvePointOut),
			})
			.strict()
			.openapi("ZeroCurveHistory"),
		// Sorted here: the client passes upstream's order through unstated.
		read: (env, from, to) =>
			getZeroCurveSeries({ env, from, to }).then((points) =>
				[...points].sort(
					(left, right) =>
						left.date.localeCompare(right.date) || left.tenorYears - right.tenorYears,
				),
			),
	},
	{
		slug: "money-market",
		name: "money market curve",
		maxDays: 1_827,
		field: "days",
		out: z
			.object({
				from: z.string(),
				to: z.string(),
				days: z.array(ZMoneyMarketCurveOut),
			})
			.strict()
			.openapi("MoneyMarketCurveHistory"),
		read: (env, from, to) => getMoneyMarketSeries({ env, from, to }),
	},
	{
		slug: "real",
		name: "real (TIPS) curve",
		maxDays: 1_827,
		field: "days",
		out: z
			.object({ from: z.string(), to: z.string(), days: z.array(ZRealCurveOut) })
			.strict()
			.openapi("RealCurveHistory"),
		read: (env, from, to) => getRealCurveSeries({ env, from, to }),
	},
];

const spanDays = (from: string, to: string) =>
	(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
		86_400_000 +
	1;

const historyRoute = (history: THistory) =>
	createRoute({
		method: "get",
		path: `/v1/curves/${history.slug}/history`,
		summary: `The ${history.name} over a date range`,
		description: `One ${history.field === "points" ? "row per tenor per" : "entry per"} fitted day, oldest first. At most ${history.maxDays === 366 ? "one year" : "five years"} per request; page through longer ranges. Coverage starts ${TREASURY_COVERAGE_START}.`,
		tags: ["Curves"],
		request: {
			query: z.object({
				from: zIsoDate.openapi({ example: "2026-01-01" }),
				to: zIsoDate.openapi({ example: "2026-09-25" }),
			}),
		},
		responses: {
			...GATE_RESPONSES,
			200: {
				content: { "application/json": { schema: history.out } },
				description: "The series. Empty only if no day in the range was fitted.",
			},
			400: {
				content: { "application/json": { schema: ZError } },
				description:
					"Malformed dates, from after to, before coverage, or too long a range.",
			},
			503: {
				content: { "application/json": { schema: ZError } },
				description: "The Treasury data service is unavailable.",
			},
		},
	});

const badRange = (c: Context<AppEnv>, message: string) =>
	c.json({ error: "bad_request" as const, message }, 400);

const handleHistory =
	(history: THistory) =>
	async (c: Context<AppEnv>, from: string, to: string) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		if (from > to) return badRange(c, `from (${from}) is after to (${to}).`);
		if (from < TREASURY_COVERAGE_START)
			return badRange(
				c,
				`Coverage starts ${TREASURY_COVERAGE_START}; ${from} is before it.`,
			);
		if (spanDays(from, to) > history.maxDays)
			return badRange(
				c,
				`At most ${history.maxDays} days of the ${history.name} per request; page through longer ranges.`,
			);
		try {
			const rows = await history.read(c.env, from, to);
			return c.json(
				history.out.parse({ from, to, [history.field]: snakeKeys(rows) }),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	};

export const registerCurveFamilyRoutes = (app: OpenAPIHono<AppEnv>) => {
	for (const family of DAY_FAMILIES) {
		const handle = handleDay(family);
		app.openapi(dayRoute(family), ((c: Context<AppEnv>) =>
			handle(c, queryOf<{ date?: string }>(c).date)) as never);
	}
	for (const history of HISTORIES) {
		const handle = handleHistory(history);
		app.openapi(historyRoute(history), ((c: Context<AppEnv>) => {
			const { from, to } = queryOf<{ from: string; to: string }>(c);
			return handle(c, from, to);
		}) as never);
	}
};
