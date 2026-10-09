import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
	AUCTION_PRIORS,
	loadAuctionWindow,
	publishAuction,
	publishLatestByTerm,
	readAuctionsBetween,
	readLatestPriceDate,
	shiftDays,
} from "@markets/mcp-tools";
import type { AppEnv } from "../env";
import { GATE_RESPONSES, ZError } from "../lib/errors";
import { treasuryErrorResponse, treasuryUnbound } from "../lib/treasury";

/**
 * Treasury auctions: the schedule and the results, by date and by term. The
 * reader, the analysis and the published shape are in
 * packages/mcp-tools/src/reads/auctions.ts, shared with the dashboard's
 * Auctions page and the get_treasury_auctions MCP tool, so all three quote the
 * same figures. Pinned by tests/auctions.test.ts.
 */

const KINDS = ["Bill", "Note", "Bond", "TIPS", "FRN"] as const;
/** A real calendar date: the pattern alone lets 2026-13-01 through to the arithmetic. */
const zIsoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
	.refine((value) => {
		const time = Date.parse(`${value}T00:00:00Z`);
		return (
			Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
		);
	}, "not a calendar date");

/** The widest window one request may ask for. */
const MAX_WINDOW_DAYS = 400;
/** The default window: a month back, and everything announced. */
const DEFAULT_BACK_DAYS = 30;
const DEFAULT_AHEAD_DAYS = 60;

const ZClearingRate = z
	.object({
		measure: z
			.enum(["discount", "yield", "real yield", "discount margin"])
			.openapi({
				description:
					"What the auction cleared on: a bill's DISCOUNT rate (Treasury's headline for bills, and the only bill rate with a published median), a note's or bond's yield, a TIPS's real yield, or a floating-rate note's discount margin.",
			}),
		high_percent: z.number().nullable().openapi({
			description:
				"The stop: the highest rate accepted, percent. Null until the auction is held.",
		}),
		median_percent: z.number().nullable().openapi({
			description:
				"The median accepted rate, percent, on the same measure. Null for floating-rate notes and before the auction.",
		}),
		investment_rate_percent: z.number().nullable().openapi({
			description:
				"Bills only: the coupon-equivalent investment rate, comparable with a note's yield. Null for everything else.",
		}),
	})
	.strict();

export const ZAuctionOut = z
	.object({
		cusip: z.string().openapi({ example: "912797VP9" }),
		kind: z.enum(KINDS).nullable().openapi({
			description:
				"Bill, Note, Bond, TIPS or FRN, derived from the auction. Null only when it cannot be told.",
		}),
		term: z.string().openapi({
			description:
				"The term it is grouped under: for a bill the term offered (a 4-week reopening of a 17-week bill is a 4-week auction); for everything else the original term (a reopened 10-year is still a 10-year).",
			example: "4-Week",
		}),
		original_security_term: z.string(),
		security_term: z.string().nullable().openapi({
			description: "The term as offered at this auction.",
		}),
		is_reopening: z.boolean(),
		status: z.enum(["announced", "auctioned", "settled"]).openapi({
			description:
				"Against the newest priced day: announced (not yet held), auctioned (held, not yet issued) or settled.",
		}),
		auction_date: z.string(),
		issue_date: z.string(),
		maturity_date: z.string().nullable().openapi({
			description:
				"Null for a NEW security not yet issued: it is not on record until then.",
		}),
		coupon_percent: z.number().nullable().openapi({
			description:
				"Percent. Null for a new note or bond before issue (its coupon is set at the auction) and for bills.",
		}),
		offering_amount: z.number().nullable().openapi({ description: "Dollars." }),
		total_tendered: z.number().nullable().openapi({ description: "Dollars." }),
		total_accepted: z.number().nullable().openapi({ description: "Dollars." }),
		bid_to_cover_ratio: z.number().nullable(),
		clearing_rate: ZClearingRate,
		high_less_median_basis_points: z.number().nullable().openapi({
			description:
				"How far the stop sat above the median accepted rate, in basis points, on the clearing measure. Not the tail, which is measured against the when-issued yield.",
		}),
		bidders: z
			.object({
				primary_dealer_percent: z.number().nullable(),
				direct_percent: z.number().nullable(),
				indirect_percent: z.number().nullable(),
			})
			.strict()
			.nullable()
			.openapi({
				description:
					"Shares of the COMPETITIVE award (primary dealers, direct and indirect bidders), percent. The Fed's SOMA rollover and non-competitive bids are left out: they do not bid on price. Null until reported.",
			}),
		soma_accepted: z.number().nullable().openapi({
			description: "Dollars: the Fed's rollover, on top of the offering.",
		}),
		allocation_percent: z.number().nullable().openapi({
			description:
				"Share of bids AT the stop that were filled, percent. Low means the stop was crowded.",
		}),
	})
	.strict()
	.openapi("Auction");

export const ZAuctionsOut = z
	.object({
		as_of: z.string().openapi({
			description: "The newest priced day, which `status` is measured against.",
		}),
		from: z.string(),
		to: z.string(),
		count: z.number().int(),
		auctions: z.array(ZAuctionOut).openapi({
			description: "Newest auction date first.",
		}),
	})
	.strict()
	.openapi("Auctions");

const ZDemandOut = z
	.object({
		verdict: z.enum(["strong", "average", "weak"]).nullable().openapi({
			description:
				"How many of the four measures sit in the top third (strong) or bottom third (weak) of this term's recent auctions. It counts measures rather than averaging them, so mixed demand reads as average. Null when fewer than two measures could be ranked.",
		}),
		sample_size: z.number().int().openapi({
			description:
				"Prior auctions of the same term in the window, this one excluded. A verdict over a few auctions is a weaker claim than one over many.",
		}),
		window_months: z.number().int().openapi({
			description: "How far back the comparison reaches, in months.",
			example: 24,
		}),
		measures: z.array(
			z.object({
				key: z.string().openapi({ example: "bidToCover" }),
				label: z.string(),
				percentile: z.number().nullable().openapi({
					description:
						"0 to 100, and 100 is strong demand on every measure: dealer takedown and high-less-median are stronger when lower and are flipped before publication.",
				}),
				value: z.number().nullable().openapi({
					description:
						"The measure itself: the bid-to-cover ratio, a share as a fraction, or high-less-median in basis points.",
				}),
				sample_size: z.number().int(),
			}),
		),
	})
	.openapi("AuctionDemand", {
		description:
			"Auction strength, from Safe Rate's treasury service (the same figures saferate.com shows). Not a tail: that is measured against the when-issued yield, which Safe Rate does not hold.",
	});

const ZLatestTermOut = z
	.object({
		group: z.string().openapi({ example: "Bill 4-Week" }),
		kind: z.enum(KINDS).nullable(),
		term: z.string(),
		auction: ZAuctionOut,
		bid_to_cover_change: z
			.number()
			.nullable()
			.openapi({
				description: `This auction's bid-to-cover less the mean of up to ${AUCTION_PRIORS} previous auctions of the same term.`,
			}),
		bid_to_cover_compared_with: z.number().int().openapi({
			description:
				"How many previous auctions that mean actually averaged (auctions missing the figure are skipped).",
		}),
		primary_dealer_change_points: z
			.number()
			.nullable()
			.openapi({
				description: `The primary-dealer share less its mean over up to ${AUCTION_PRIORS} previous auctions, percentage points. Dealers take what others do not, so a rise is weaker demand at the price.`,
			}),
		primary_dealer_compared_with: z.number().int(),
		demand: ZDemandOut.nullable().openapi({
			description:
				"This auction's demand ranked against the same term's recent history. Null when the term has fewer than eight prior auctions in the window, or the ranking is unavailable.",
		}),
	})
	.strict()
	.openapi("AuctionTermLatest");

export const ZAuctionsLatestOut = z
	.object({
		as_of: z.string(),
		terms: z.array(ZLatestTermOut).openapi({
			description:
				"Bills shortest first, then notes, bonds, TIPS and FRNs by term.",
		}),
	})
	.strict()
	.openapi("AuctionsLatest");

const listRoute = createRoute({
	method: "get",
	path: "/v1/auctions",
	summary: "Treasury auctions in a date window",
	description:
		"Every Treasury auction with an auction date in [`from`, `to`]: what is announced, what has been auctioned and is not yet issued, and what has settled, with each auction's results. Omit both dates for the last 30 days and everything announced. New securities appear as soon as they are announced, before they are issued, with `maturity_date` and `coupon_percent` null until then. A window may be at most 400 days.",
	tags: ["Auctions"],
	request: {
		query: z.object({
			from: zIsoDate.optional().openapi({ example: "2026-09-01" }),
			to: zIsoDate.optional().openapi({ example: "2026-10-31" }),
			kind: z.enum(KINDS).optional(),
			term: z.string().max(40).optional().openapi({
				description:
					'Only this term, as in `term` on each auction ("4-Week", "10-Year"). Case-insensitive.',
			}),
			status: z.enum(["announced", "auctioned", "settled"]).optional(),
		}),
	},
	responses: {
		...GATE_RESPONSES,
		400: {
			content: { "application/json": { schema: ZError } },
			description: "Malformed parameters, or a window wider than 400 days.",
		},
		503: {
			content: { "application/json": { schema: ZError } },
			description: "The Treasury data service is unavailable.",
		},
		200: {
			content: { "application/json": { schema: ZAuctionsOut } },
			description: "The auctions, newest first.",
		},
	},
});

const latestRoute = createRoute({
	method: "get",
	path: "/v1/auctions/latest",
	summary: "The latest auction result of every term",
	description: `For each term auctioned in the last 400 days, its most recent held auction, with \`demand\`: bid-to-cover, indirect share, dealer takedown and high-less-median ranked against that term's last 24 months, and a strong, average or weak verdict. Also the change in bid-to-cover and in the primary-dealer share against the mean of up to ${AUCTION_PRIORS} previous auctions of that term, each saying how many it averaged.`,
	tags: ["Auctions"],
	request: {
		query: z.object({ kind: z.enum(KINDS).optional() }),
	},
	responses: {
		...GATE_RESPONSES,
		400: {
			content: { "application/json": { schema: ZError } },
			description: "Malformed parameters, or a window wider than 400 days.",
		},
		503: {
			content: { "application/json": { schema: ZError } },
			description: "The Treasury data service is unavailable.",
		},
		200: {
			content: { "application/json": { schema: ZAuctionsLatestOut } },
			description: "One entry per term.",
		},
	},
});

const daysBetween = (from: string, to: string) =>
	(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

export const registerAuctionRoutes = (app: OpenAPIHono<AppEnv>) => {
	app.openapi(listRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const query = c.req.valid("query");
		try {
			const on = await readLatestPriceDate(c.env);
			const from =
				query.from ??
				(query.to === undefined
					? shiftDays(on, -DEFAULT_BACK_DAYS)
					: shiftDays(query.to, -DEFAULT_BACK_DAYS));
			const to =
				query.to ??
				(query.from === undefined
					? shiftDays(on, DEFAULT_AHEAD_DAYS)
					: shiftDays(query.from, DEFAULT_BACK_DAYS + DEFAULT_AHEAD_DAYS));
			if (from > to)
				return c.json(
					{ error: "bad_request" as const, message: "`from` is after `to`." },
					400,
				);
			if (daysBetween(from, to) > MAX_WINDOW_DAYS)
				return c.json(
					{
						error: "bad_request" as const,
						message: `A window may be at most ${MAX_WINDOW_DAYS} days; ${from} to ${to} is ${daysBetween(from, to)}. Ask in pieces.`,
					},
					400,
				);
			const term = query.term?.toLowerCase();
			const auctions = (await readAuctionsBetween(c.env, { from, to }))
				.map((a) => publishAuction(a, on))
				.filter(
					(a) =>
						(query.kind === undefined || a.kind === query.kind) &&
						(term === undefined || a.term.toLowerCase() === term) &&
						(query.status === undefined || a.status === query.status),
				);
			return c.json(
				ZAuctionsOut.parse({
					as_of: on,
					from,
					to,
					count: auctions.length,
					auctions,
				}),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});

	app.openapi(latestRoute, async (c) => {
		const unbound = treasuryUnbound(c);
		if (unbound) return unbound;
		const query = c.req.valid("query");
		try {
			const loaded = await loadAuctionWindow(c.env);
			if (loaded === null)
				return c.json(
					{
						error: "unavailable" as const,
						message:
							"Auctions are not available from the Treasury service yet. This is a fault on our side, not an absence of data.",
					},
					503,
				);
			return c.json(
				ZAuctionsLatestOut.parse({
					as_of: loaded.on,
					terms: loaded.latestByTerm
						.filter((row) => query.kind === undefined || row.kind === query.kind)
						.map((row) => publishLatestByTerm(row, loaded.on)),
				}),
				200,
			);
		} catch (error) {
			return treasuryErrorResponse(c, error);
		}
	});
};
