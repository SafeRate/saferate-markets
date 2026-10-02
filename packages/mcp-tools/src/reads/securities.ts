import {
	RUN_KIND_ORDER,
	securityFamilyFromPriceType,
	termYears,
	type TSecurityFamily,
	ZFrnAnalytics,
	ZPriceOnDate,
	ZRunStatus,
	ZSecurityAnalytics,
	ZSecurityDetail,
	ZSecurityPrice,
	ZTipsAnalytics,
} from "@saferate/treasury-client/types";
import { z } from "zod";
import { call, type TEnv } from "./treasury";

/**
 * Security (CUSIP) reads for REST and MCP, through the client's zod schemas and
 * the shared caller (outage, not-deployed and empty kept apart; see treasury.ts).
 *
 * Measured on production data 2026-09-28 (apps/api/tests/fixtures/securities):
 *
 *  - History comes back NEWEST FIRST from upstream. Every reader here sorts
 *    oldest first, the order an API caller expects for a time series.
 *  - TIPS and FRNs have NO rows in the nominal analytics table; theirs live in
 *    separate tables with their own fields (real yield and index ratio; discount
 *    margin and spread duration). So "analytics for this CUSIP" has to pick the
 *    table by family, which readAnalyticsFor does.
 *  - The family comes from the price type (MARKET BASED NOTE -> note, TIPS ->
 *    tips, MARKET BASED FRN -> frn), the client's securityFamilyFromPriceType.
 */

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const byDate = <T extends { date: string }>(rows: T[]) =>
	[...rows].sort((left, right) => left.date.localeCompare(right.date));

const within = (date: string, from?: string, to?: string) =>
	(from === undefined || date >= from) && (to === undefined || date <= to);

/** Terms and auction history, or null when no such CUSIP. */
export const readSecurityDetail = async (env: TEnv, cusip: string) => {
	const row = await call(env, "security")(cusip);
	return row === null || row === undefined ? null : ZSecurityDetail.parse(row);
};

export const readSecurityPrices = async (
	env: TEnv,
	input: { cusip: string; from?: string; to?: string },
) => {
	const rows = await call(env, "securityPrices")(input.cusip);
	return byDate(z.array(ZSecurityPrice).parse(rows ?? [])).filter((row) =>
		within(row.date, input.from, input.to),
	);
};

/** The family a CUSIP belongs to, from its latest price. Null when never priced. */
export const familyOf = (prices: { securityType: string }[]) => {
	const latest = prices.at(-1);
	return latest === undefined
		? null
		: securityFamilyFromPriceType(latest.securityType);
};

/** Which analytics table a family's rows live in. */
export type TAnalyticsBasis = "nominal" | "tips" | "frn";

export const analyticsBasisFor = (
	family: TSecurityFamily | null,
): TAnalyticsBasis | null =>
	family === null
		? null
		: family === "tips"
			? "tips"
			: family === "frn"
				? "frn"
				: "nominal";

export const readAnalyticsFor = async (
	env: TEnv,
	input: { cusip: string; basis: TAnalyticsBasis; from?: string; to?: string },
) => {
	const keep = <T extends { date: string }>(rows: T[]) =>
		byDate(rows).filter((row) => within(row.date, input.from, input.to));
	if (input.basis === "tips") {
		const rows = await call(env, "tipsAnalytics")({ cusip: input.cusip });
		return {
			basis: "tips" as const,
			rows: keep(z.array(ZTipsAnalytics).parse(rows ?? [])),
		};
	}
	if (input.basis === "frn") {
		const rows = await call(env, "frnAnalytics")({ cusip: input.cusip });
		return {
			basis: "frn" as const,
			rows: keep(z.array(ZFrnAnalytics).parse(rows ?? [])),
		};
	}
	const rows = await call(env, "securityAnalytics")(input.cusip);
	return {
		basis: "nominal" as const,
		rows: keep(z.array(ZSecurityAnalytics).parse(rows ?? [])),
	};
};

/** Every security priced on a date, oldest maturity first. Empty when none. */
export const readPricesOn = async (env: TEnv, date: string) =>
	z
		.array(ZPriceOnDate)
		.parse((await call(env, "pricesOn")({ date })) ?? [])
		.sort((left, right) => left.maturityDate.localeCompare(right.maturityDate));

/** The latest date the price archive holds. */
export const readLatestPriceDate = async (env: TEnv) =>
	z
		.union([zDate, z.object({ date: zDate })])
		.transform((value) => (typeof value === "string" ? value : value.date))
		.parse(await call(env, "latestPriceDate")());

/**
 * Each on-the-run queue on a date: the security kind and original term, and
 * its members by run rank (0 is on the run). Upstream tracks ranks 0 to 10.
 * Kinds in RUN_KIND_ORDER, then shortest term first, as the client orders them.
 */
export const readRunQueuesOn = async (
	env: TEnv,
	input: { date: string; basis: "auction" | "issue" },
) => {
	const rows = z
		.array(ZRunStatus)
		.parse(
			(await call(env, "runStatusOn")({ basis: input.basis, date: input.date })) ??
				[],
		);
	const queues = new Map<string, typeof rows>();
	for (const row of rows) {
		const key = `${row.securityKind}|${row.originalSecurityTerm}`;
		queues.set(key, [...(queues.get(key) ?? []), row]);
	}
	return [...queues.values()]
		.map((members) => [...members].sort((a, b) => a.runRank - b.runRank))
		.sort(
			(left, right) =>
				RUN_KIND_ORDER.indexOf(left[0].securityKind) -
					RUN_KIND_ORDER.indexOf(right[0].securityKind) ||
				termYears(left[0].originalSecurityTerm) -
					termYears(right[0].originalSecurityTerm),
		);
};
