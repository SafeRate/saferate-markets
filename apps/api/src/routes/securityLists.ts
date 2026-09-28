import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
	readLatestPriceDate,
	readPricesOn,
	readRunQueuesOn,
} from "@markets/mcp-tools";
import { securityFamilyFromPriceType } from "@saferate/treasury-client/types";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { GATE_RESPONSES, ZError } from "../lib/errors";
import { treasuryErrorResponse, treasuryUnbound } from "../lib/treasury";

/**
 * Finding a CUSIP: every security priced on a day (GET /v1/securities), and
 * which one is on the run for each tenor (GET /v1/on-the-run). The MCP tool
 * list_treasury_securities serves the same. /v1/on-the-run is NOT under
 * /v1/securities/ because that segment is the CUSIP route's.
 *
 * Pinned by tests/securityLists.test.ts on production rows.
 */

const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const ZFamily = z.enum(["bill", "note", "bond", "tips", "frn"]);

const ZListedSecurity = z
	.object({
		cusip: z.string(),
		family: ZFamily.nullable(),
		coupon_percent: z.number(),
		maturity_date: z.string(),
		price: z.number().openapi({
			description:
				"End-of-day clean price per 100 face. A TIPS is quoted in real terms, before its index ratio.",
		}),
	})
	.strict()
	.openapi("ListedSecurity");

export const ZSecurityListOut = z
	.object({
		date: z.string(),
		count: z.number().int(),
		securities: z.array(ZListedSecurity),
	})
	.strict()
	.openapi("SecurityList");

export const ZOnTheRunOut = z
	.object({
		date: z.string(),
		basis: z.enum(["auction", "issue"]),
		queues: z.array(
			z
				.object({
					kind: z.enum(["Bill", "Note", "Bond", "TIPS", "FRN"]),
					original_security_term: z.string().openapi({ example: "10-Year" }),
					members: z.array(
						z
							.object({
								run_rank: z.number().int().openapi({
									description: "0 is on the run; 1 the first off-the-run; up to 10.",
								}),
								cusip: z.string(),
								coupon_percent: z.number().nullable(),
								maturity_date: z.string().nullable().openapi({
									description: "Null only if the security has no price that day.",
								}),
							})
							.strict(),
					),
				})
				.strict(),
		),
	})
	.strict()
	.openapi("OnTheRun");

const ERRORS = {
	400: {
		content: { "application/json": { schema: ZError } },
		description: "Malformed parameters.",
	},
	404: {
		content: { "application/json": { schema: ZError } },
		description:
			"Nothing priced that day: a weekend, a federal holiday, or a day not yet published.",
	},
	503: {
		content: { "application/json": { schema: ZError } },
		description: "The Treasury data service is unavailable.",
	},
};

const listRoute = createRoute({
	method: "get",
	path: "/v1/securities",
	summary: "Every Treasury security priced on a day",
	description:
		"The outstanding marketable stock as priced that day, several hundred securities, shortest maturity first, with family, coupon and price. Filter with `family`. Omit `date` for the most recent priced day. Look any one up at /v1/securities/{cusip}.",
	tags: ["Securities"],
	request: {
		query: z.object({
			date: zIsoDate.optional().openapi({ example: "2026-09-25" }),
			family: ZFamily.optional(),
		}),
	},
	responses: {
		...GATE_RESPONSES,
		200: {
			content: { "application/json": { schema: ZSecurityListOut } },
			description: "The list.",
		},
		...ERRORS,
	},
});

const runRoute = createRoute({
	method: "get",
	path: "/v1/on-the-run",
	summary: "On-the-run and off-the-run Treasuries by tenor",
	description:
		"For each security kind and original term, the most recently issued security (rank 0) and up to ten before it. `basis=issue` (the default) moves a security on the run when it settles; `basis=auction` when it is auctioned, which is what market commentary means by 'the new 10-year'. Between an auction and its settlement the two disagree. Omit `date` for the most recent priced day.",
	tags: ["Securities"],
	request: {
		query: z.object({
			date: zIsoDate.optional().openapi({ example: "2026-09-25" }),
			basis: z.enum(["auction", "issue"]).default("issue"),
		}),
	},
	responses: {
		...GATE_RESPONSES,
		200: {
			content: { "application/json": { schema: ZOnTheRunOut } },
			description: "The queues.",
		},
		...ERRORS,
	},
});

const nothingOn = (
	c: Context<AppEnv>,
	date: string | undefined,
	what: string,
) =>
	c.json(
		{
			error: "no_data" as const,
			message:
				date === undefined
					? `No ${what} is available.`
					: `No ${what} on ${date}. Treasury publishes on business days only, so weekends, federal holidays and days not yet published return nothing. Omit date for the most recent priced day.`,
		},
		404,
	);

export const registerSecurityListRoutes = (app: OpenAPIHono<AppEnv>) => {
	app.openapi(listRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const { date, family } = c.req.valid("query");
		try {
			const on = date ?? (await readLatestPriceDate(c.env));
			const prices = await readPricesOn(c.env, on);
			if (prices.length === 0) return nothingOn(c, date, "priced securities");
			const securities = prices
				.map((row) => ({
					cusip: row.cusip,
					family: securityFamilyFromPriceType(row.securityType),
					coupon_percent: row.couponPercent,
					maturity_date: row.maturityDate,
					price: row.close,
				}))
				.filter((row) => family === undefined || row.family === family);
			return c.json(
				ZSecurityListOut.parse({ date: on, count: securities.length, securities }),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});

	app.openapi(runRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const { date, basis } = c.req.valid("query");
		try {
			let on = date ?? (await readLatestPriceDate(c.env));
			let queues = await readRunQueuesOn(c.env, { date: on, basis });
			// The run record follows the prices; the newest price day can lack it.
			for (
				let step = 1;
				date === undefined && queues.length === 0 && step < 7;
				step += 1
			) {
				on = new Date(Date.parse(`${on}T00:00:00Z`) - 86_400_000)
					.toISOString()
					.slice(0, 10);
				queues = await readRunQueuesOn(c.env, { date: on, basis });
			}
			if (queues.length === 0) return nothingOn(c, date, "on-the-run record");
			const prices = await readPricesOn(c.env, on);
			const terms = new Map(prices.map((row) => [row.cusip, row]));
			return c.json(
				ZOnTheRunOut.parse({
					date: on,
					basis,
					queues: queues.map((members) => ({
						kind: members[0].securityKind,
						original_security_term: members[0].originalSecurityTerm,
						members: members.map((member) => ({
							run_rank: member.runRank,
							cusip: member.cusip,
							coupon_percent: terms.get(member.cusip)?.couponPercent ?? null,
							maturity_date: terms.get(member.cusip)?.maturityDate ?? null,
						})),
					})),
				}),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});
};
