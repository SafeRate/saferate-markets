import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getRichCheap } from "./tools/getRichCheap";
import { getSavingsBondRates } from "./tools/getSavingsBondRates";
import { getTreasuryCurve } from "./tools/getTreasuryCurve";
import { getTreasuryDebt } from "./tools/getTreasuryDebt";
import { getTreasuryIndex } from "./tools/getTreasuryIndex";
import { getTreasuryRateHistory } from "./tools/getTreasurySeries";
import { getTreasurySecurity } from "./tools/getTreasurySecurity";
import { listTreasurySecurities } from "./tools/listTreasurySecurities";
import { priceTreasurySecurity } from "./tools/priceTreasurySecurity";
import type { TDepsTreasury } from "./tools/shared";
import { valueSavingsBond } from "./tools/valueSavingsBond";

export * from "./reads/indices";
export * from "./reads/richCheap";
export * from "./reads/securities";
export * from "./reads/treasury";
export * from "./tools/shared";

/**
 * The Safe Rate Treasury MCP tools, and THE AUTHORITY for them.
 *
 * Started 2026-09-28 as a copy of the nine treasury tools in
 * saferate-ai/apps/mcp (at 8e009c24). This package is now the source: the
 * general server at mcp.saferate.com is expected to register a SUBSET of these
 * rather than keep its own copies. That is why this package knows nothing about
 * API keys, metering or rate limits — the host server supplies all of that
 * through `wrap`, so a public, authless host can register the same tools.
 *
 * Registration and descriptions are carried over verbatim apart from two
 * deliberate changes, both because this server sells no mortgage product:
 * the not-a-mortgage-rate payload field is gone, and so is the sentence in
 * get_treasury_curve's description saying the same. The general server keeps
 * both and should keep them when it moves onto this package.
 */

/**
 * Wraps every handler. The host uses it for usage tracking and metering, in ONE
 * place: instrumenting each handler separately is how a tool ends up silently
 * uncounted, and a missing count looks exactly like an unused tool.
 */
export type TWrapTool = <TArgs extends unknown[], TResult>(
	tool: string,
	run: (...args: TArgs) => Promise<TResult>,
) => (...args: TArgs) => Promise<TResult>;

export const TREASURY_TOOL_NAMES = [
	"get_treasury_curve",
	"get_treasury_rate_history",
	"get_treasury_security",
	"list_treasury_securities",
	"price_treasury_security",
	"value_savings_bond",
	"get_savings_bond_rates",
	"get_treasury_index",
	"get_treasury_debt",
	"get_treasury_rich_cheap",
] as const;
export type TTreasuryToolName = (typeof TREASURY_TOOL_NAMES)[number];

export function registerTreasuryTools(
	server: McpServer,
	deps: TDepsTreasury,
	wrap: TWrapTool = (_tool, run) => run,
) {
	server.registerTool(
		"get_treasury_curve",
		{
			description:
				"Get the U.S. Treasury yield curve for a single day: the fitted zero-coupon (spot) curve and, on request, the par curve, money-market curve, TIPS real curve, breakeven inflation, the prior trading day for day-over-day moves, and per-CUSIP yields. Omit the date for the most recent published day, which is what you want on a weekend or holiday.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			inputSchema: z.object({
				date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe(
						"Trading day as YYYY-MM-DD. Omit for the most recent published day — most calendar days are not trading days, so omitting is usually right.",
					),
				include: z
					.array(z.enum(["breakeven", "prior", "queue_yields", "real", "zero"]))
					.optional()
					.describe(
						'Which curves to return. Defaults to ["zero"]. "real" is the TIPS curve, "breakeven" the inflation implied between them, "prior" the previous trading day for comparison, "queue_yields" per-CUSIP yields and curve residuals.',
					),
				queue_kind: z
					.enum(["Bill", "Bond", "FRN", "Note", "TIPS"])
					.optional()
					.describe('Security kind for "queue_yields". Defaults to Note.'),
			}),
		},
		wrap("get_treasury_curve", async (args) => {
			const result = await getTreasuryCurve(args, deps);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		}),
	);

	server.registerTool(
		"get_treasury_rate_history",
		{
			description:
				"Get a history of U.S. Treasury yields between two dates: the nominal zero curve, the short-end money-market curve, or the TIPS real curve, one row per trading day. Use this for 'how have rates moved' questions. Coverage starts 2008-09-02. Keep ranges tight — a decade is thousands of rows.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			inputSchema: z.object({
				curve: z
					.enum(["money_market", "real", "zero"])
					.optional()
					.describe(
						'Which curve. Defaults to "zero" (nominal spot). "money_market" covers below one year; "real" is TIPS and its yields sit above inflation.',
					),
				from: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.describe("Start date, YYYY-MM-DD. Not before 2008-09-02."),
				to: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.describe("End date, YYYY-MM-DD."),
			}),
		},
		wrap("get_treasury_rate_history", async (args) => {
			const result = await getTreasuryRateHistory(args, deps);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		}),
	);

	server.registerTool(
		"get_treasury_security",
		{
			description:
				"Look up one Treasury security by CUSIP: its terms, price history, and analytics including duration, convexity, DV01 and key-rate durations, plus TIPS and floating-rate analytics where they apply, and the amount outstanding. Use list_treasury_securities first if you have a description like 'the current 10-year' rather than a CUSIP.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			inputSchema: z.object({
				cusip: z
					.string()
					.min(1)
					.describe('Nine-character Treasury CUSIP, e.g. "91282CJL6".'),
				outstanding_on: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe(
						"Date for the amount outstanding. The month-end statement in force on it is used. Defaults to today.",
					),
				summarize: z
					.boolean()
					.optional()
					.describe(
						"True drops the daily price and analytics series and keeps the latest values. Use it unless you need the full history — a 30-year bond carries thousands of rows.",
					),
			}),
		},
		wrap("get_treasury_security", async (args) => {
			const result = await getTreasurySecurity(args, deps);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		}),
	);

	server.registerTool(
		"list_treasury_securities",
		{
			description:
				"List Treasury securities as at a date: which security is on-the-run for each tenor (this is how to resolve 'the current 10-year' to a CUSIP), the full outstanding and priced universe, or just the priced CUSIPs. Omit the date for the most recent day with prices.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			inputSchema: z.object({
				basis: z
					.enum(["auction", "issue"])
					.optional()
					.describe(
						'When a security becomes on-the-run. "auction" is the trading convention and flips sooner; "issue" waits for settlement. Defaults to "issue". Between an auction and its issue the two disagree.',
					),
				date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe(
						"Date as YYYY-MM-DD. Omit for the most recent day with published prices.",
					),
				include: z
					.array(z.enum(["cusips_only", "on_the_run", "outstanding"]))
					.optional()
					.describe(
						'Defaults to ["on_the_run"]. "outstanding" returns every priced security, which is several hundred rows.',
					),
			}),
		},
		wrap("list_treasury_securities", async (args) => {
			const result = await listTreasurySecurities(args, deps);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		}),
	);

	server.registerTool(
		"price_treasury_security",
		{
			description:
				"Convert between price and yield for a Treasury bill, note or bond. Supply exactly one side — a price or a yield (a discount rate for a bill) — and the other is returned, with accrued interest, dirty price and the investment rate as applicable. For a note or bond, a CUSIP looks the terms up instead of restating them.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			inputSchema: z.object({
				clean_price: z
					.number()
					.positive()
					.optional()
					.describe("Price per 100 of face, excluding accrued interest."),
				coupon_rate_percent: z
					.number()
					.min(0)
					.optional()
					.describe(
						"Annual coupon rate. Required for a coupon security without a CUSIP.",
					),
				cusip: z
					.string()
					.optional()
					.describe("CUSIP of a note or bond; its terms are looked up."),
				discount_rate_percent: z
					.number()
					.optional()
					.describe("Bank discount rate for a bill."),
				frequency: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Coupon payments per year. Defaults to 2."),
				instrument: z
					.enum(["bill", "coupon"])
					.describe(
						'"bill" for a discount instrument under a year, "coupon" for a note or bond. The maths differs; the wrong choice returns a plausible wrong number.',
					),
				maturity_date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe("Maturity, YYYY-MM-DD. Required for a bill."),
				trade_date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe("Settlement date. Defaults to the most recent trading day."),
				yield_percent: z
					.number()
					.optional()
					.describe("Yield to maturity for a coupon security."),
			}),
		},
		wrap("price_treasury_security", async (args) => {
			const result = await priceTreasurySecurity(args, deps);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		}),
	);

	server.registerTool(
		"value_savings_bond",
		{
			description:
				"Value a U.S. Series I or Series EE savings bond: what it is worth now, how it got there, and what the holder would actually receive. Bonds under five years old forfeit three months of interest on redemption, and bonds under twelve months cannot be redeemed at all — report the net, not just the accrued value. The purchase date is the bond's issue date.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			inputSchema: z.object({
				denomination: z
					.number()
					.positive()
					.optional()
					.describe(
						"Face value in dollars, e.g. 100. Defaults to the standard unit.",
					),
				purchased: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.describe(
						"The bond's ISSUE date, YYYY-MM-DD. Not the year printed on the face — a wrong date shifts the whole rate schedule.",
					),
				series: z
					.enum(["EE", "I"])
					.describe(
						'"I" is inflation-indexed; "EE" carries the 20-year doubling guarantee.',
					),
				valued_on: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe("Valuation date. Defaults to today."),
			}),
		},
		wrap("value_savings_bond", async (args) => {
			const result = await valueSavingsBond(args, deps);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		}),
	);

	server.registerTool(
		"get_savings_bond_rates",
		{
			description:
				"Get current and historical U.S. savings bond rates — the Series I composite, its fixed and inflation components, and Series EE rates by issue cohort — and optionally how many bonds the public holds and how many are being sold. An I bond's headline rate applies for six months only; the fixed component is the part that lasts.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			inputSchema: z.object({
				include: z
					.array(z.enum(["ee_cohorts", "public_holdings", "sales"]))
					.optional()
					.describe(
						'Extras. "ee_cohorts" groups EE bonds by the rate rules of their issue window; "sales" is TreasuryDirect volume, which spikes when the I bond rate is high.',
					),
				on: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe("Valuation date. Defaults to today."),
			}),
		},
		wrap("get_savings_bond_rates", async (args) => {
			const result = await getSavingsBondRates(args, deps);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		}),
	);

	server.registerTool(
		"get_treasury_index",
		{
			description:
				"Get Safe Rate's Treasury total-return indices — by maturity bucket, plus bills, TIPS, floating-rate and aggregate. Call with no code to list every index with its current level and discover the codes. These are TOTAL RETURN levels, not yields: a rising level usually means yields fell. Constructed by Safe Rate, not an official Treasury statistic.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			inputSchema: z.object({
				code: z
					.string()
					.min(1)
					.max(16)
					.optional()
					.describe(
						'Index code, e.g. "broad", "1020", "TIPS". Omit to list every index with its latest level.',
					),
				constituents_on: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe(
						"Rebalance date for constituents. Defaults to the most recent — constituents exist on rebalance dates only, not daily.",
					),
				include: z
					.array(z.enum(["constituents", "daily_history", "fund_comparison"]))
					.optional()
					.describe(
						'Extras. "fund_comparison" sets each index beside comparable public bond funds and applies to the no-code listing.',
					),
				on: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe(
						"With no code, returns every index's level as at this date instead of the latest.",
					),
				since: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe('Start date for "daily_history".'),
			}),
		},
		wrap("get_treasury_index", async (args) => {
			const result = await getTreasuryIndex(args, deps);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		}),
	);

	server.registerTool(
		"get_treasury_debt",
		{
			description:
				"Get the U.S. federal debt from the monthly Treasury statement: debt held by the public, total public debt outstanding, and its composition, plus the STRIPS float on request. These two headline figures differ by trillions — debt held by the public excludes intragovernmental trust-fund holdings — so always say which one you are quoting.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			inputSchema: z.object({
				include_strips: z
					.boolean()
					.optional()
					.describe(
						"Also return how much of the debt is held as STRIPS — separated coupon and principal payments traded as zero-coupon instruments.",
					),
				on: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe(
						"Any date; the month-end statement in force on it is returned, so a mid-month date gives the prior month-end. Defaults to today.",
					),
			}),
		},
		wrap("get_treasury_debt", async (args) => {
			const result = await getTreasuryDebt(args, deps);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		}),
	);

	server.registerTool(
		"get_treasury_rich_cheap",
		{
			description:
				"Rank U.S. Treasuries by how rich or cheap they are to Safe Rate's fitted curve on one day. Ranked by z-score (today's curve residual against the security's own history), so it surfaces what has MOVED, not what always trades off the curve. Use for relative-value questions: 'which notes look cheap', 'what has richened in the 5 to 10 year sector'. Notes and bonds at least a year from maturity by default (TIPS are not scored yet). Read how_to_read before quoting a residual: the price and yield residuals have opposite signs.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			inputSchema: z.object({
				date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe(
						"Trading day as YYYY-MM-DD. Omit for the most recent day with analytics.",
					),
				direction: z
					.enum(["richer", "cheaper"])
					.optional()
					.describe(
						"Only securities that have richened (negative z) or cheapened (positive z) against their own history.",
					),
				family: z
					.enum(["note", "bond"])
					.optional()
					.describe("Restrict to notes or to bonds."),
				min_years: z
					.number()
					.min(0)
					.max(40)
					.optional()
					.describe(
						"Minimum years to maturity. Default 1: shorter securities sit where the curve is extrapolated and their residuals are inflated. Pass 0 to include them.",
					),
				max_years: z
					.number()
					.min(0)
					.max(40)
					.optional()
					.describe("Maximum years to maturity."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("How many to return. Default 15."),
			}),
		},
		wrap("get_treasury_rich_cheap", async (args) => {
			const result = await getRichCheap(args, deps);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		}),
	);
}
