import {
	readLatestPriceDate,
	readPricesOn,
	readSecurityDetail,
	type TEnv,
} from "@markets/mcp-tools";
import { securityFamilyFromPriceType } from "@saferate/treasury-client/types";
import { describeSecurity } from "@/lib/format";

/**
 * CUSIP search over today's priced securities, shared by the trade form's
 * picker (routes/dashboard.securities.search.ts) and Security Lookup. Matches
 * every word of the query (CUSIP prefix, coupon, maturity year or month,
 * kind), so "4.625 2035" and "note feb 2035" both work. A full CUSIP not
 * priced today (a matured security, say) is looked up directly.
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

export type TSecurityMatch = {
	cusip: string;
	label: string;
	family: string | null;
	maturityDate: string;
	close: number | null;
	closeDate: string | null;
};

export const searchSecurities = async (
	env: TEnv,
	query: string,
	limit = 20,
): Promise<TSecurityMatch[]> => {
	const q = query.trim().toLowerCase();
	if (q.length < 2) return [];
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
		.slice(0, limit)
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
			return [
				{
					cusip: detail.cusip,
					label: `${describeSecurity({ couponPercent: detail.couponPercent ?? 0, maturityDate: detail.maturityDate, family: null })} ${detail.detailSecurityType} (not priced today)`,
					family: null,
					maturityDate: detail.maturityDate,
					close: null,
					closeDate: null,
				},
			];
	}
	return results;
};
