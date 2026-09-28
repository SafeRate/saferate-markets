import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { snakeKeys } from "@markets/mcp-tools";
import {
	getDebtSummaryOn,
	getStripsFloat,
} from "@saferate/treasury-client/client";
import type { AppEnv } from "../env";
import { GATE_RESPONSES, ZError } from "../lib/errors";
import { treasuryErrorResponse, treasuryUnbound } from "../lib/treasury";

/**
 * The federal debt from the Monthly Statement of the Public Debt, and how much
 * of it is held as STRIPS. Both are AS OF: a date returns the month-end
 * statement in force on it, so a mid-month date gives the prior month-end.
 * The MCP tool get_treasury_debt calls the same client functions.
 *
 * Pinned by tests/debt.test.ts on the production statement for 2026-08-31.
 */

const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const todayIso = () => new Date().toISOString().slice(0, 10);

const ZDebtLine = z
	.object({
		record_date: z.string(),
		security_type: z.string().openapi({ example: "Marketable" }),
		security_class: z.string().openapi({
			description: 'The class, e.g. "Notes"; "_" on a total line.',
			example: "Notes",
		}),
		debt_held_public: z.number().openapi({ description: "Dollars." }),
		intragovernmental: z.number().openapi({ description: "Dollars." }),
		total: z.number().openapi({ description: "Dollars." }),
		is_total: z.boolean(),
		is_headline_total: z.boolean(),
	})
	.strict()
	.openapi("DebtLine");

const ZTie = z
	.object({
		published: z.number(),
		summed: z.number(),
		gap: z.number(),
		relative_gap: z.number().nullable(),
	})
	.strict()
	.openapi("DebtTieOut");

export const ZDebtOut = z
	.object({
		record_date: z.string().openapi({
			description:
				"The statement's month-end. Quote this, not the date you asked for.",
		}),
		headline: ZDebtLine.nullable().openapi({
			description:
				"Total public debt outstanding. Its debt_held_public (borrowed from investors) and total (which adds the government's debts to its own trust funds) differ by trillions: say which one you quote.",
		}),
		marketable_total: ZDebtLine.nullable(),
		nonmarketable_total: ZDebtLine.nullable(),
		marketable: z.array(ZDebtLine),
		nonmarketable: z.array(ZDebtLine),
		marketable_tie: ZTie.nullable().openapi({
			description:
				"The class lines summed against the published total: a check on the statement, not a correction of it.",
		}),
		nonmarketable_tie: ZTie.nullable(),
	})
	.strict()
	.openapi("DebtSummary");

const ZStripsStatement = z
	.object({
		record_date: z.string(),
		outstanding: z
			.number()
			.openapi({ description: "Dollars, strippable securities." }),
		stripped: z
			.number()
			.openapi({ description: "Dollars held in stripped form." }),
		stripped_share_percent: z.number().nullable(),
		reconstituted: z
			.number()
			.openapi({ description: "Dollars reconstituted that month." }),
		security_count: z.number().int(),
	})
	.strict();

export const ZStripsOut = z
	.object({
		latest: ZStripsStatement,
		by_class: z.array(
			z
				.object({
					security_class: z.string(),
					outstanding: z.number(),
					stripped: z.number(),
					stripped_share_percent: z.number().nullable(),
				})
				.strict(),
		),
		most_stripped: z.array(
			z
				.object({
					cusip: z.string(),
					security_class: z.string(),
					maturity_date: z.string(),
					record_date: z.string(),
					outstanding: z.number(),
					stripped: z.number(),
					stripped_share_of_size: z.number().nullable().openapi({
						description: "Percent of this security held stripped.",
					}),
					reconstituted: z.number(),
				})
				.strict(),
		),
		trailing_reconstituted: z.number().openapi({
			description:
				"Dollars reconstituted over the last trailing_statements months.",
		}),
		trailing_statements: z.number().int(),
		series: z.array(ZStripsStatement).openapi({
			description: "Every monthly statement since January 2001, oldest first.",
		}),
	})
	.strict()
	.openapi("StripsFloat");

const errors = (what: string) => ({
	400: {
		content: { "application/json": { schema: ZError } },
		description: "Malformed date.",
	},
	404: {
		content: { "application/json": { schema: ZError } },
		description: `No ${what} in force on that date: it precedes the first one on file.`,
	},
	503: {
		content: { "application/json": { schema: ZError } },
		description: "The Treasury data service is unavailable.",
	},
});

const query = z.object({
	on: zIsoDate.optional().openapi({
		description:
			"Any date; the month-end statement in force on it. Default today.",
		example: "2026-09-25",
	}),
});

const debtRoute = createRoute({
	method: "get",
	path: "/v1/debt",
	summary: "U.S. federal debt, from the monthly statement",
	description:
		"Debt held by the public, intragovernmental holdings and their total, by security type and class, from the Monthly Statement of the Public Debt in force on `on`.",
	tags: ["Debt"],
	request: { query },
	responses: {
		...GATE_RESPONSES,
		200: {
			content: { "application/json": { schema: ZDebtOut } },
			description: "The statement.",
		},
		...errors("statement"),
	},
});

const stripsRoute = createRoute({
	method: "get",
	path: "/v1/strips",
	summary: "How much Treasury debt is held as STRIPS",
	description:
		"STRIPS are notes and bonds separated into their coupon and principal payments, each traded as a zero-coupon instrument. The stripped stock, by class, the ten most-stripped securities, and the monthly history, from the statement in force on `on`.",
	tags: ["Debt"],
	request: { query },
	responses: {
		...GATE_RESPONSES,
		200: {
			content: { "application/json": { schema: ZStripsOut } },
			description: "The STRIPS float.",
		},
		...errors("STRIPS statement"),
	},
});

export const registerDebtRoutes = (app: OpenAPIHono<AppEnv>) => {
	app.openapi(debtRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const on = c.req.valid("query").on ?? todayIso();
		try {
			const summary = await getDebtSummaryOn({ env: c.env, on });
			if (summary === null) {
				return c.json(
					{
						error: "no_data" as const,
						message: `No debt statement in force on ${on}.`,
					},
					404,
				);
			}
			const { details: _details, ...rest } = summary;
			return c.json(ZDebtOut.parse(snakeKeys(rest)), 200);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});

	app.openapi(stripsRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const on = c.req.valid("query").on ?? todayIso();
		try {
			const strips = await getStripsFloat({ env: c.env, on });
			if (strips === null) {
				return c.json(
					{
						error: "no_data" as const,
						message: `No STRIPS statement in force on ${on}.`,
					},
					404,
				);
			}
			return c.json(ZStripsOut.parse(snakeKeys(strips)), 200);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});
};
