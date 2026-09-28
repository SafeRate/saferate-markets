import { generateApiKey, sha256Hex } from "@markets/persistence";
import app from "../src/index";

/**
 * Drives the API Worker through app.fetch with a fake D1, a fake TREASURY
 * binding and a fake rate limiter. What is real: routing, every middleware,
 * the vendored client's parsing, the MCP handler.
 */

/** Rows in the shape upstream SENDS: snake_case, straight off SQL. */
export const ZERO_ROW = {
	converged: 1,
	date: "2026-09-25",
	forward_rate: 4.1,
	lambda_1: 0.6,
	lambda_2: 0.1,
	par_yield: 4.05,
	rmse_basis_points: 1.1,
	rmse_price_cents: 3.2,
	security_count: 220,
	tenor_years: 10,
	theta_0: 4.0,
	theta_1: -0.5,
	theta_2: 0.2,
	theta_3: 0.1,
	zero_rate: 4.02,
};

export const TREASURY = {
	latestCurve: async () => ({ date: "2026-09-25", zero: [ZERO_ROW] }),
	curvesOn: async (date: string) =>
		date === "2026-09-27" ? { zero: [] } : { zero: [ZERO_ROW] },
};

type TStatement = { sql: string; args: unknown[] };

/**
 * Just enough D1 for the key lookup and the meter. It answers the
 * authentication query when the bound hash is the one live key's, and records
 * every batch so a test can see what was metered.
 */
const fakeDb = (liveHash: string | null, isEntitled = true) => {
	const batches: TStatement[][] = [];
	const statement = (sql: string, args: unknown[] = []): unknown => ({
		sql,
		args,
		bind: (...bound: unknown[]) => statement(sql, bound),
		first: async () =>
			sql.includes("from apiKeys") && args[0] === liveHash
				? {
						idApiKey: "key-1",
						idOrganization: "org-1",
						lastUsedAt: null,
						isEntitled: isEntitled ? 1 : 0,
					}
				: null,
		run: async () => ({ meta: { changes: 1 } }),
		all: async () => ({ results: [] }),
	});
	return {
		batches,
		db: {
			prepare: (sql: string) => statement(sql),
			batch: async (stmts: TStatement[]) => {
				batches.push(stmts);
				return [];
			},
		},
	};
};

type TSetup = {
	treasury?: unknown;
	/** Default: always allows, and records which key it was asked about. */
	limiter?: { limit: (o: { key: string }) => Promise<{ success: boolean }> };
	omitLimiter?: boolean;
	/** Whether the key's organization has a live subscription. Default true. */
	isEntitled?: boolean;
};

export const setup = async (overrides: TSetup = {}) => {
	const limitedKeys: string[] = [];
	const { key } = await generateApiKey();
	const d1 = fakeDb(await sha256Hex(key), overrides.isEntitled ?? true);
	const pending: Promise<unknown>[] = [];
	const env = {
		DB: d1.db,
		MARKETS_ENV: "development",
		TREASURY: "treasury" in overrides ? overrides.treasury : TREASURY,
		...(overrides.omitLimiter
			? {}
			: {
					RATE_LIMITER: overrides.limiter ?? {
						limit: async ({ key }: { key: string }) => {
							limitedKeys.push(key);
							return { success: true };
						},
					},
				}),
	};
	const ctx = {
		waitUntil: (p: Promise<unknown>) => pending.push(p),
		passThroughOnException: () => {},
		props: {},
	};
	const call = async (path: string, init: RequestInit = {}) => {
		const response = await app.fetch(
			new Request(`https://api.test${path}`, init),
			env as never,
			ctx as never,
		);
		await Promise.all(pending);
		return response;
	};
	return { key, call, batches: d1.batches, limitedKeys };
};

export const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });
