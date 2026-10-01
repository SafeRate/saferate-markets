import {
	isTreasuryRefusal,
	treasuryRefusalCode,
} from "@saferate/treasury-client/client";
import { call, type TEnv } from "./treasury";
import {
	INDEX_DISPLAY_ORDER,
	isIndexCode,
	type TIndexCode,
	ZIndexAnalytics,
	ZIndexConstituent,
	ZIndexLevel,
	ZIndexLevelDaily,
	ZIndexReturns,
	ZOpenConstituents,
	ZOpenConstituentsStatus,
} from "@saferate/treasury-client/types";
import { z } from "zod";

/**
 * Index reads for BOTH surfaces, REST (apps/api routes/indices.ts) and MCP
 * (tools/getTreasuryIndex.ts), and why they do NOT call the client's getIndex*
 * functions. One set of readers so a fix to either surface is a fix to both;
 * moved here from apps/api on 2026-09-28 after the MCP tool was found serving
 * the month-end as "latest" while REST had been fixed.
 *
 * Those functions were written for web pages, where an index panel is optional
 * and a degraded page beats a 503. So several of them SWALLOW failure:
 * getIndexAnalytics returns [] on a 503 and when the RPC method is missing,
 * getIndexReturns returns null for both, getIndexLevelsDaily returns an
 * "absent" marker. Over an API that turns "the service is down" into "this index
 * has no analytics", which a customer would believe. (Measured by reading the
 * vendored client at 276a2b6, 2026-09-28.)
 *
 * So these read through the same zod schemas (the parsing, the unit conversions
 * and the naming are the client's, unchanged) and treasuryRead's retry policy,
 * but keep three states apart:
 *
 *   outage          treasuryRead throws a 503 Response   -> 503
 *   not deployed    the RPC method does not exist        -> 503 (TreasuryAbsent)
 *   nothing there   a real empty answer                  -> null, the route 404s
 */

const byDisplayOrder = <T extends { code: string }>(rows: T[]) =>
	rows
		.filter((row) => isIndexCode(row.code))
		.sort(
			(left, right) =>
				INDEX_DISPLAY_ORDER.indexOf(left.code as TIndexCode) -
				INDEX_DISPLAY_ORDER.indexOf(right.code as TIndexCode),
		);

/** The latest MONTH-END level of every index, with its month return. */
export const readLatestLevels = async (env: TEnv) => {
	const rows = await call(env, "indexLevels")();
	return byDisplayOrder(z.array(ZIndexLevel).parse(rows ?? []));
};

/**
 * Every index's DAILY level on one day, or the latest day. This, not
 * readLatestLevels, is "the level now": indexLevels is the latest MONTH-END
 * (2026-08-31 on 2026-09-28, while daily ran to 2026-09-25).
 */
export const readDailyLevelsOn = async (env: TEnv, date?: string) => {
	const rows = await call(
		env,
		"indexLevelsDailyOn",
	)(date === undefined ? {} : { date });
	return byDisplayOrder(z.array(ZIndexLevelDaily).parse(rows ?? []));
};

export const readDailyLevels = async (
	env: TEnv,
	input: { code: TIndexCode; from?: string; to?: string },
) => {
	const rows = await call(
		env,
		"indexLevelsDaily",
	)({
		code: input.code,
		...(input.from === undefined ? {} : { since: input.from }),
	});
	return z
		.array(ZIndexLevelDaily)
		.parse(rows ?? [])
		.filter((row) => input.to === undefined || row.date <= input.to)
		.sort((left, right) => left.date.localeCompare(right.date));
};

export const readReturns = async (env: TEnv, code: TIndexCode) => {
	const row = await call(env, "indexReturns")({ code });
	return row === null || row === undefined ? null : ZIndexReturns.parse(row);
};

export const readAnalytics = async (
	env: TEnv,
	input: { code: TIndexCode; date?: string },
) => {
	const rows = await call(
		env,
		"indexAnalytics",
	)({
		code: input.code,
		...(input.date === undefined ? {} : { date: input.date }),
	});
	return z.array(ZIndexAnalytics).parse(rows ?? []);
};

/**
 * `unknown_index` from these two methods is NOT always a mistyped code: the
 * open snapshot is written by a producer run that can be behind, so an empty
 * snapshot refuses the same way. The code has already been validated by the
 * route, so here it means "nothing there" and becomes null.
 */
const nullOnUnknownIndex = async <T>(run: () => Promise<T>) => {
	try {
		return await run();
	} catch (error) {
		if (
			isTreasuryRefusal(error) &&
			treasuryRefusalCode(error) === "unknown_index"
		) {
			return null;
		}
		throw error;
	}
};

export const readConstituentsOn = (
	env: TEnv,
	input: { code: TIndexCode; date: string },
) =>
	nullOnUnknownIndex(async () => {
		const rows = await call(
			env,
			"indexConstituents",
		)({
			code: input.code,
			date: input.date,
		});
		const parsed = z.array(ZIndexConstituent).parse(rows ?? []);
		return parsed.length === 0
			? null
			: [...parsed].sort((a, b) => b.weightPercent - a.weightPercent);
	});

/**
 * Why there is no open-period list, for the branch that already found none.
 * Two different facts share that empty reply (treasury-integration,
 * 2026-10-01): a list never written, which the next run fills; and a list
 * WITHHELD because a newer month-end rebalance superseded the one it was
 * struck at, which rolls forward once the first business day after that
 * rebalance is priced. Saying "written after each run" for the second tells a
 * reader to wait for a run that already happened. When the status cannot be
 * read, say only that it is unavailable.
 */
export const explainNoOpenConstituents = async (
	env: TEnv,
	code: TIndexCode,
): Promise<string> => {
	const status = await call(
		env,
		"openConstituentsStatus",
	)({ code })
		.then((reply) =>
			reply === null || reply === undefined
				? null
				: ZOpenConstituentsStatus.parse(reply),
		)
		.catch(() => null);
	if (status?.state === "superseded" && status.held && status.supersededBy)
		return `The most recent open-period list for ${code} was struck at the ${status.held} rebalance, which the ${status.supersededBy} rebalance has superseded, so it is withheld rather than served as current. It rolls forward once the first business day after ${status.supersededBy} is priced.`;
	if (status?.state === "never-written")
		return `No open-period list for ${code} has been written yet. It is written after each business day's run.`;
	return `The open-period list for ${code} is not available right now.`;
};

export const readOpenConstituents = (env: TEnv, code: TIndexCode) =>
	nullOnUnknownIndex(async () => {
		const reply = await call(env, "openConstituents")({ code });
		if (reply === null || reply === undefined) return null;
		const parsed = ZOpenConstituents.parse(reply);
		return parsed.rows.length === 0 ? null : parsed;
	});
