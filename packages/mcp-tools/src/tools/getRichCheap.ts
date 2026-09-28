import { z } from "zod";
import { rankRichCheap, readRichCheap } from "../reads/richCheap";
import {
	DISCLOSURE_TREASURY,
	noData,
	runTreasury,
	snakeKeys,
	type TDepsTreasury,
} from "./shared";

/**
 * `get_treasury_rich_cheap` — which Treasuries are furthest from the fitted
 * curve, ranked by how unusual that is for each security. The same reader as
 * GET /v1/rich-cheap; the conventions are in reads/richCheap.ts.
 *
 * The two `vs_` fields are spelled out for the model because the residual
 * signs are opposite (cents positive = rich, basis points positive = cheap) and
 * an assistant quoting one against the other's convention states the wrong
 * side with confidence.
 */

export const ZInputGetRichCheap = z.object({
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
	basis: z.enum(["nominal", "tips"]).optional(),
	direction: z.enum(["richer", "cheaper"]).optional(),
	family: z.enum(["note", "bond"]).optional(),
	min_years: z.number().min(0).max(40).optional(),
	max_years: z.number().min(0).max(40).optional(),
	limit: z.number().int().min(1).max(100).optional(),
});

export async function getRichCheap(
	_input: z.input<typeof ZInputGetRichCheap>,
	_deps: TDepsTreasury,
) {
	const input = ZInputGetRichCheap.parse(_input);
	const basis = input.basis ?? "nominal";
	if (input.family !== undefined && basis === "tips") {
		return {
			ok: false as const,
			error: "bad_request",
			message: "`family` applies to basis nominal only; every TIPS is one family.",
		};
	}

	const day = await runTreasury(() =>
		readRichCheap(_deps.env, {
			basis,
			date: input.date,
		}),
	);
	if (day !== null && "ok" in day) return day;
	if (day === null) return noData("security analytics", input.date);

	const ranking = rankRichCheap(day.rows, {
		direction: input.direction,
		families:
			basis === "tips"
				? ["tips"]
				: input.family === undefined
					? ["note", "bond"]
					: [input.family],
		minYears: input.min_years,
		maxYears: input.max_years,
		limit: input.limit ?? 15,
	});

	return {
		ok: true,
		date: day.date,
		basis,
		ranked_by: "abs_z_score",
		matched_count: ranking.matchedCount,
		unscored_count: ranking.unscoredCount,
		securities: ranking.ranked.map((row, index) => ({
			rank: index + 1,
			...(snakeKeys(row) as Record<string, unknown>),
		})),
		how_to_read:
			"residual_basis_points is yield minus the fitted curve: POSITIVE = CHEAP. price_residual_cents is price minus model: POSITIVE = RICH (opposite sign, same fact). vs_curve says which, in words. z_score compares today's residual with the security's own history: positive = cheaper than usual. vs_history says which; it can disagree with vs_curve. Ranked by |z_score|. Securities with no z-score (new issues for about a month, anything within a month of maturity; bills are never scored) are counted in unscored_count, not ranked: a missing z is not zero.",
		disclosure: DISCLOSURE_TREASURY,
	};
}
