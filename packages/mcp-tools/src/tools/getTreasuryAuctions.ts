import { z } from "zod";
import {
	loadAuctionWindow,
	publishAuction,
	publishLatestByTerm,
	readAuctionsBetween,
	shiftDays,
} from "../reads/auctions";
import { readLatestPriceDate } from "../reads/securities";
import { TreasuryAbsent } from "../reads/treasury";
import {
	DISCLOSURE_TREASURY,
	readableOutage,
	runTreasury,
	type TDepsTreasury,
} from "./shared";

/**
 * `get_treasury_auctions` — the Treasury auction schedule and results. The same
 * reader, analysis and record shape as GET /v1/auctions and
 * /v1/auctions/latest (reads/auctions.ts), so an assistant quotes what the API
 * and the dashboard show.
 *
 * Two views. `schedule` (default): auctions in a window, by default the last
 * two weeks and everything announced. `latest_by_term`: each term's most
 * recent result with its changes against up to six previous auctions.
 */

const KINDS = ["Bill", "Note", "Bond", "TIPS", "FRN"] as const;

/** A real calendar date: the pattern alone lets 2026-13-01 through. */
const zDay = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((value) => {
		const time = Date.parse(`${value}T00:00:00Z`);
		return (
			Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
		);
	}, "not a calendar date");

export const ZInputGetTreasuryAuctions = z.object({
	view: z.enum(["schedule", "latest_by_term"]).optional(),
	from: zDay.optional(),
	to: zDay.optional(),
	kind: z.enum(KINDS).optional(),
	term: z.string().max(40).optional(),
	status: z.enum(["announced", "auctioned", "settled"]).optional(),
	limit: z.number().int().min(1).max(200).optional(),
});

const HOW_TO_READ =
	"status is against as_of (the newest priced day): announced = not yet held, auctioned = held but not yet issued, settled. A NEW security not yet issued has maturity_date and coupon_percent null; that is expected, not missing data. clearing_rate.measure says what high_percent is: a bill's DISCOUNT rate (with investment_rate_percent, the coupon-equivalent figure comparable with a note's yield), a note's or bond's yield, a TIPS's real yield, or an FRN's discount margin. high_less_median_basis_points is the stop less the median, not the tail. bidders are shares of the competitive award, leaving out the Fed's SOMA rollover. In latest_by_term, each change is against the mean of the number of previous auctions stated beside it (up to six), not always six.";

export async function getTreasuryAuctions(
	_input: z.input<typeof ZInputGetTreasuryAuctions>,
	_deps: TDepsTreasury,
) {
	const input = ZInputGetTreasuryAuctions.parse(_input);
	if (input.view === "latest_by_term") {
		const loaded = await runTreasury(() => loadAuctionWindow(_deps.env));
		if (loaded !== null && "ok" in loaded) return loaded;
		// A treasury-api without auctionsBetween: the same readable failure
		// every tool raises for deploy skew, never an empty answer.
		if (loaded === null)
			throw readableOutage(new TreasuryAbsent("auctionsBetween"));
		return {
			ok: true,
			view: "latest_by_term",
			as_of: loaded.on,
			terms: loaded.latestByTerm
				.filter((row) => input.kind === undefined || row.kind === input.kind)
				.map((row) => publishLatestByTerm(row, loaded.on)),
			how_to_read: HOW_TO_READ,
			disclosure: DISCLOSURE_TREASURY,
		};
	}

	const on = await runTreasury(() => readLatestPriceDate(_deps.env));
	if (typeof on !== "string") return on;
	const from = input.from ?? shiftDays(input.to ?? on, -14);
	const to = input.to ?? shiftDays(input.from ?? on, 60);
	if (from > to)
		return { ok: false, error: "bad_request", message: "`from` is after `to`." };
	const rows = await runTreasury(() =>
		readAuctionsBetween(_deps.env, { from, to }),
	);
	if (!Array.isArray(rows)) return rows;
	const term = input.term?.toLowerCase();
	const matched = rows
		.map((a) => publishAuction(a, on))
		.filter(
			(a) =>
				(input.kind === undefined || a.kind === input.kind) &&
				(term === undefined || a.term.toLowerCase() === term) &&
				(input.status === undefined || a.status === input.status),
		);
	const limit = input.limit ?? 40;
	return {
		ok: true,
		view: "schedule",
		as_of: on,
		from,
		to,
		matched_count: matched.length,
		auctions: matched.slice(0, limit),
		how_to_read: HOW_TO_READ,
		disclosure: DISCLOSURE_TREASURY,
	};
}
