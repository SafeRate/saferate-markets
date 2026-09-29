import {
	readLatestPriceDate,
	readPricesOn,
	readSecurityDetail,
} from "@markets/mcp-tools";
import { securityFamilyFromPriceType } from "@saferate/treasury-client/types";
import { describeSecurity } from "@/lib/format";
import { requireOrganization } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.securities.search";

/**
 * CUSIP search for the trade form: JSON, signed-in only. Matches every word of
 * the query against today's priced securities (CUSIP prefix, coupon, maturity
 * year or month, kind), so "4.625 2035" and "note feb 2035" both work. A full
 * CUSIP not priced today (a matured security, say) is looked up directly.
 */

const MONTHS = [
	"jan",
	"feb",
	"mar",
	"apr",
	"may",
	"jun",
	"jul",
	"aug",
	"sep",
	"oct",
	"nov",
	"dec",
];

export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	await requireOrganization(request, env);
	const q =
		new URL(request.url).searchParams.get("q")?.trim().toLowerCase() ?? "";
	if (q.length < 2) return Response.json({ results: [] });

	const asOf = await readLatestPriceDate(env);
	const priced = await readPricesOn(env, asOf);
	const tokens = q.split(/\s+/);
	const results = priced
		.map((row) => {
			const family = securityFamilyFromPriceType(row.securityType);
			const [year, month] = row.maturityDate.split("-");
			const haystack = [
				row.cusip.toLowerCase(),
				row.couponPercent.toFixed(3),
				String(Number(row.couponPercent.toFixed(3))),
				year,
				`${year}-${month}`,
				MONTHS[Number(month) - 1],
				family ?? "",
			];
			return { row, family, haystack };
		})
		.filter(({ haystack }) =>
			tokens.every((t) =>
				haystack.some(
					(h) =>
						(t.length >= 4 && /^[0-9a-z]+$/.test(t) && h.startsWith(t)) || h === t,
				),
			),
		)
		.slice(0, 20)
		.map(({ row, family }) => ({
			cusip: row.cusip,
			label: describeSecurity({
				couponPercent: row.couponPercent,
				maturityDate: row.maturityDate,
				family,
			}),
			family,
			maturityDate: row.maturityDate,
			close: row.close,
			closeDate: asOf,
		}));

	if (results.length === 0 && /^[0-9a-z]{9}$/.test(q)) {
		const detail = await readSecurityDetail(env, q.toUpperCase());
		if (detail !== null)
			return Response.json({
				results: [
					{
						cusip: detail.cusip,
						label: `${describeSecurity({ couponPercent: detail.couponPercent ?? 0, maturityDate: detail.maturityDate, family: null })} ${detail.detailSecurityType} (not priced today)`,
						family: null,
						maturityDate: detail.maturityDate,
						close: null,
						closeDate: null,
					},
				],
			});
	}
	return Response.json({ results });
};
