import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { snakeKeys } from "@markets/mcp-tools";
import { getCurvesOn, getLatestCurve } from "@saferate/treasury-client/client";
import { TREASURY_COVERAGE_START } from "@saferate/treasury-client/types";
import type { AppEnv } from "../env";
import { ZError } from "../lib/errors";
import { treasuryErrorResponse, treasuryUnbound } from "../lib/treasury";

/**
 * The response is DECLARED here and not derived, and that is forced: the
 * client's schemas transform snake_case rows into camelCase, and a transform has
 * no OpenAPI representation. tests/curves.test.ts is what keeps this honest: it
 * runs a fixture through the client's real parser and snakeKeys, and requires
 * these .strict() schemas to accept the result exactly. A field added, renamed
 * or dropped upstream fails that test rather than the published reference.
 *
 * snake_case to match the MCP tools and the existing treasury.saferate.com API,
 * so a customer using both surfaces reads one vocabulary.
 */

export const ZZeroCurvePointOut = z
	.object({
		date: z.string().openapi({ example: "2026-09-25" }),
		tenor_years: z.number().openapi({
			description: "One of 1, 2, 3, 5, 7, 10, 15, 20, 25, 30.",
			example: 10,
		}),
		zero_rate: z.number().openapi({
			description: "Continuously compounded spot rate, percent.",
		}),
		par_yield: z.number().openapi({ description: "Par yield, percent." }),
		forward_rate: z
			.number()
			.openapi({ description: "Instantaneous forward rate, percent." }),
	})
	.strict()
	.openapi("ZeroCurvePoint");

export const ZCurveDiagnosticsOut = z
	.object({
		date: z.string(),
		has_converged: z.boolean(),
		rmse_basis_points: z.number().openapi({
			description:
				"Fit error across the securities used. Typically about 3 bp; treat a day much above that with care.",
		}),
		rmse_price_cents: z.number(),
		security_count: z.number().int(),
		theta0: z.number(),
		theta1: z.number(),
		theta2: z.number(),
		theta3: z.number(),
		lambda1: z.number(),
		lambda2: z.number(),
	})
	.strict()
	.openapi("CurveFitDiagnostics");

export const ZZeroCurveOut = z
	.object({
		date: z.string().openapi({ description: "The trading day fitted." }),
		diagnostics: ZCurveDiagnosticsOut,
		points: z.array(ZZeroCurvePointOut),
	})
	.strict()
	.openapi("ZeroCurve");

const route = createRoute({
	method: "get",
	path: "/v1/curves/zero",
	summary: "Treasury zero curve for one day",
	description: `The fitted zero-coupon (spot) curve at ten tenors, with the day's fit diagnostics. Omit \`date\` for the most recent fitted day, which is what you want on a weekend or holiday. Coverage starts ${TREASURY_COVERAGE_START}.`,
	tags: ["Curves"],
	request: {
		query: z.object({
			date: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
				.optional()
				.openapi({ example: "2026-09-25" }),
		}),
	},
	responses: {
		200: {
			content: { "application/json": { schema: ZZeroCurveOut } },
			description: "The curve.",
		},
		400: {
			content: { "application/json": { schema: ZError } },
			description: "Malformed date, or one outside coverage.",
		},
		404: {
			content: { "application/json": { schema: ZError } },
			description:
				"No curve was fitted that day: a weekend, a federal holiday, or a day not yet published.",
		},
		503: {
			content: { "application/json": { schema: ZError } },
			description: "The Treasury data service is unavailable.",
		},
	},
});

export const registerCurveRoutes = (app: OpenAPIHono<AppEnv>) =>
	app.openapi(route, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const { date } = c.req.valid("query");

		try {
			const curve =
				date === undefined
					? await getLatestCurve({ env: c.env })
					: await getCurvesOn({ date, env: c.env }).then((day) =>
							day === null || day.zeroDiagnostics === null
								? null
								: {
										date: day.date,
										diagnostics: day.zeroDiagnostics,
										points: day.zero,
									},
						);

			if (curve === null) {
				return c.json(
					{
						error: "no_data" as const,
						message:
							date === undefined
								? "No fitted curve is available."
								: `No curve was fitted on ${date}. Treasury publishes on business days only, so weekends, federal holidays and days not yet published return nothing. Omit date for the most recent fitted day.`,
					},
					404,
				);
			}
			return c.json(ZZeroCurveOut.parse(snakeKeys(curve)), 200);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});
