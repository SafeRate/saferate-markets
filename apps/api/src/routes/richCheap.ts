import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { rankRichCheap, readRichCheap, snakeKeys } from "@markets/mcp-tools";
import type { AppEnv } from "../env";
import { GATE_RESPONSES, ZError } from "../lib/errors";
import { treasuryErrorResponse, treasuryUnbound } from "../lib/treasury";

/**
 * Rich/cheap: which Treasuries are furthest from the fitted curve, ranked by
 * how unusual that is for each security. The reader and the conventions are in
 * packages/mcp-tools/src/reads/richCheap.ts; the published descriptions below
 * repeat the ones a client could misread, because the reference is all most
 * clients will read. Pinned by tests/richCheap.test.ts on production rows.
 */

const ZRichCheapRowOut = z
	.object({
		rank: z.number().int(),
		cusip: z.string().openapi({ example: "91282CMM0" }),
		family: z
			.enum(["bill", "note", "bond", "tips", "frn"])
			.nullable()
			.openapi({ description: "From the day's price record." }),
		coupon_percent: z.number(),
		maturity_date: z.string(),
		years_to_maturity: z.number(),
		price: z.number().openapi({
			description:
				"End-of-day clean price per 100 face, as quoted. A TIPS is quoted in real terms, before its index ratio.",
		}),
		yield_percent: z.number().nullable().openapi({
			description:
				"Yield to maturity, percent. For TIPS, the REAL yield. Null inside a month of maturity, where annualising stops meaning anything.",
		}),
		residual_basis_points: z.number().nullable().openapi({
			description:
				"Yield minus the fitted curve, bp. POSITIVE MEANS CHEAP. Nominal securities against the nominal zero curve; TIPS against the real curve.",
		}),
		price_residual_cents: z.number().openapi({
			description:
				"Price minus the model price, cents per 100. POSITIVE MEANS RICH: the opposite sign to residual_basis_points for the same fact.",
		}),
		z_score: z.number().openapi({
			description:
				"The residual against this security's own history, in standard deviations. Positive: cheaper than usual; negative: richer. The ranking key, by absolute value.",
		}),
		vs_curve: z.enum(["rich", "cheap"]).nullable().openapi({
			description:
				"Today, against the curve: the sign of residual_basis_points in words.",
		}),
		vs_history: z.enum(["richer", "cheaper"]).nullable().openapi({
			description:
				"Against its own history: the sign of z_score in words. Can disagree with vs_curve: a bond that always trades rich can be rich today and still cheaper than usual.",
		}),
	})
	.strict()
	.openapi("RichCheapSecurity");

export const ZRichCheapOut = z
	.object({
		date: z.string().openapi({ description: "The trading day ranked." }),
		basis: z.enum(["nominal", "tips"]),
		ranked_by: z.literal("abs_z_score"),
		matched_count: z.number().int().openapi({
			description: "Scored securities matching the filters, before `limit`.",
		}),
		unscored_count: z.number().int().openapi({
			description:
				"Securities matching the filters with NO z-score, left out of the ranking rather than ranked as ordinary: anything inside its first twenty observations (every new issue for about a month), and anything inside a month of maturity.",
		}),
		securities: z.array(ZRichCheapRowOut),
	})
	.strict()
	.openapi("RichCheap");

const zYears = z.coerce.number().min(0).max(40);

const route = createRoute({
	method: "get",
	path: "/v1/rich-cheap",
	summary: "Rich/cheap: securities furthest from the curve",
	description:
		"Every Treasury's distance from the fitted curve on one day, ranked by how unusual that distance is for the security (|z-score|), not by its size, so a bond that always trades a little cheap does not crowd out one that has just moved. `basis=nominal` covers notes and bonds (bills are never scored); `basis=tips` covers TIPS against the real curve. Omit `date` for the most recent day with analytics.",
	tags: ["Rich/cheap"],
	request: {
		query: z.object({
			date: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
				.optional()
				.openapi({ example: "2026-09-25" }),
			basis: z.enum(["nominal", "tips"]).default("nominal"),
			direction: z.enum(["richer", "cheaper"]).optional().openapi({
				description:
					"Only securities that have richened (negative z) or cheapened (positive z) against their own history.",
			}),
			family: z.enum(["note", "bond"]).optional().openapi({
				description: "Nominal basis only: notes or bonds.",
			}),
			min_years: zYears
				.optional()
				.openapi({ description: "Minimum years to maturity." }),
			max_years: zYears
				.optional()
				.openapi({ description: "Maximum years to maturity." }),
			limit: z.coerce.number().int().min(1).max(500).default(25),
		}),
	},
	responses: {
		...GATE_RESPONSES,
		200: {
			content: { "application/json": { schema: ZRichCheapOut } },
			description: "The ranking.",
		},
		400: {
			content: { "application/json": { schema: ZError } },
			description: "Malformed parameters.",
		},
		404: {
			content: { "application/json": { schema: ZError } },
			description:
				"No analytics that day: a weekend, a federal holiday, or a day not yet computed.",
		},
		503: {
			content: { "application/json": { schema: ZError } },
			description: "The Treasury data service is unavailable.",
		},
	},
});

export const registerRichCheapRoutes = (app: OpenAPIHono<AppEnv>) =>
	app.openapi(route, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const query = c.req.valid("query");
		if (query.family !== undefined && query.basis === "tips") {
			return c.json(
				{
					error: "bad_request" as const,
					message:
						"`family` applies to basis=nominal only; every TIPS is one family.",
				},
				400,
			);
		}
		try {
			const day = await readRichCheap(c.env, {
				basis: query.basis,
				date: query.date,
			});
			if (day === null) {
				return c.json(
					{
						error: "no_data" as const,
						message:
							query.date === undefined
								? "No recent day has analytics."
								: `No analytics on ${query.date}. Treasury publishes on business days only, and analytics follow the close; omit date for the most recent day.`,
					},
					404,
				);
			}
			if (day.unpriced > 0) {
				console.warn(
					`[rich-cheap] ${day.unpriced} ${query.basis} analytics rows on ${day.date} had no price row and were left out`,
				);
			}
			const ranking = rankRichCheap(day.rows, {
				direction: query.direction,
				families:
					query.basis === "tips"
						? ["tips"]
						: query.family === undefined
							? ["note", "bond"]
							: [query.family],
				minYears: query.min_years,
				maxYears: query.max_years,
				limit: query.limit,
			});
			return c.json(
				ZRichCheapOut.parse({
					date: day.date,
					basis: query.basis,
					ranked_by: "abs_z_score",
					matched_count: ranking.matchedCount,
					unscored_count: ranking.unscoredCount,
					securities: ranking.ranked.map((row, index) => ({
						rank: index + 1,
						...(snakeKeys(row) as Record<string, unknown>),
					})),
				}),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});
