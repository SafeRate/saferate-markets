import { describe, expect, test } from "bun:test";
import { generateApiKey, sha256Hex } from "@markets/persistence";
import { getLatestCurve } from "@saferate/treasury-client/client";
import { snakeKeys } from "@markets/mcp-tools";
import app from "../src/index";
import { ZZeroCurveOut } from "../src/routes/curves";

/**
 * The API Worker end to end, through app.fetch, with a fake D1 and a fake
 * TREASURY binding. What is real: routing, the auth and meter middleware, the
 * vendored client's parsing, the MCP handler.
 */

/** Rows in the shape upstream SENDS: snake_case, straight off SQL. */
const ZERO_ROW = {
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

const TREASURY = {
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
const fakeDb = (liveHash: string | null) => {
	const batches: TStatement[][] = [];
	const statement = (sql: string, args: unknown[] = []): unknown => ({
		sql,
		args,
		bind: (...bound: unknown[]) => statement(sql, bound),
		first: async () =>
			sql.includes("from apiKeys") && args[0] === liveHash
				? { idApiKey: "key-1", idOrganization: "org-1", lastUsedAt: null }
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

const setup = async (overrides: { treasury?: unknown } = {}) => {
	const { key } = await generateApiKey();
	const d1 = fakeDb(await sha256Hex(key));
	const pending: Promise<unknown>[] = [];
	const env = {
		DB: d1.db,
		MARKETS_ENV: "development",
		TREASURY: "treasury" in overrides ? overrides.treasury : TREASURY,
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
	return { key, call, batches: d1.batches };
};

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

describe("the declared REST schema matches what the client produces", () => {
	// The schema in routes/curves.ts is written by hand because the client's
	// transforms have no OpenAPI form. This is what stops it drifting.
	test("the real parse of a real-shaped row is accepted exactly", async () => {
		const curve = await getLatestCurve({ env: { TREASURY } as never });
		expect(() => ZZeroCurveOut.parse(snakeKeys(curve))).not.toThrow();
	});

	// Proves the check can fail. Without .strict() an extra field would pass.
	test("a field the schema does not declare is rejected", async () => {
		const curve = snakeKeys(
			await getLatestCurve({ env: { TREASURY } as never }),
		) as { points: Record<string, unknown>[] };
		curve.points[0].convexity = 1;
		expect(() => ZZeroCurveOut.parse(curve)).toThrow();
	});
});

describe("authentication", () => {
	test("no key is a 401 that says how, with WWW-Authenticate", async () => {
		const { call } = await setup();
		const response = await call("/v1/curves/zero");
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
		expect((await response.json()).message).toContain("srm_live_");
	});

	test("a well-formed key that is not ours is a 401", async () => {
		const { call } = await setup();
		const { key: stranger } = await generateApiKey();
		const response = await call("/v1/curves/zero", {
			headers: bearer(stranger),
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain("invalid_token");
	});

	test("/mcp is authenticated too", async () => {
		const { call } = await setup();
		const response = await call("/mcp", { method: "POST" });
		expect(response.status).toBe(401);
	});

	test("a refused request is not metered", async () => {
		const { call, batches } = await setup();
		await call("/v1/curves/zero");
		expect(batches).toHaveLength(0);
	});
});

describe("GET /v1/curves/zero", () => {
	test("latest, when no date is given", async () => {
		const { call, key } = await setup();
		const response = await call("/v1/curves/zero", { headers: bearer(key) });
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.date).toBe("2026-09-25");
		expect(body.points[0]).toEqual({
			date: "2026-09-25",
			tenor_years: 10,
			zero_rate: 4.02,
			par_yield: 4.05,
			forward_rate: 4.1,
		});
		expect(body.diagnostics.has_converged).toBe(true);
	});

	test("a day with no fit is a 404 that says why", async () => {
		const { call, key } = await setup();
		const response = await call("/v1/curves/zero?date=2026-09-27", {
			headers: bearer(key),
		});
		expect(response.status).toBe(404);
		expect((await response.json()).message).toContain("business days only");
	});

	test("a malformed date is a 400 in the error envelope", async () => {
		const { call, key } = await setup();
		const response = await call("/v1/curves/zero?date=yesterday", {
			headers: bearer(key),
		});
		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("bad_request");
	});

	// The client returns null for BOTH "no binding" and "no curve". Over HTTP
	// that would be a 404 on every date, reading as missing data.
	test("an absent binding is a 503, never a 404", async () => {
		const { call, key } = await setup({ treasury: undefined });
		const response = await call("/v1/curves/zero", { headers: bearer(key) });
		expect(response.status).toBe(503);
		expect((await response.json()).message).toContain("not an absence of data");
	});

	test("an upstream outage is a 503, never a 404", async () => {
		const { call, key } = await setup({
			treasury: {
				latestCurve: async () => {
					throw new Error("network");
				},
			},
		});
		const response = await call("/v1/curves/zero", { headers: bearer(key) });
		expect(response.status).toBe(503);
	});

	test("a served request is metered as rest, by route pattern", async () => {
		const { call, key, batches } = await setup();
		await call("/v1/curves/zero", { headers: bearer(key) });
		expect(batches).toHaveLength(1);
		const [event] = batches[0];
		expect(event.sql).toContain("insert into apiUsageEvents");
		// idApiUsageEvent, idOrganization, idApiKey, surface, operation, status
		expect(event.args.slice(1, 6)).toEqual([
			"org-1",
			"key-1",
			"rest",
			"/v1/curves/zero",
			200,
		]);
	});
});

describe("MCP over /mcp", () => {
	const rpc = (key: string, method: string, params: unknown = {}) => ({
		method: "POST",
		headers: {
			...bearer(key),
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});

	/** The handler may answer as JSON or as a single SSE event. */
	const readRpc = async (response: Response) => {
		const text = await response.text();
		const json = text.trimStart().startsWith("{")
			? text
			: (text
					.split("\n")
					.find((l) => l.startsWith("data:"))
					?.slice(5) ?? "null");
		return JSON.parse(json);
	};

	test("lists the nine treasury tools to an authenticated caller", async () => {
		const { call, key } = await setup();
		const response = await call("/mcp", rpc(key, "tools/list"));
		expect(response.status).toBe(200);
		const body = await readRpc(response);
		const names = body.result.tools.map((t: { name: string }) => t.name);
		expect(names).toHaveLength(9);
		expect(names).toContain("get_treasury_curve");
	});

	test("a tool call answers from the binding and is metered as mcp", async () => {
		const { call, key, batches } = await setup();
		const response = await call(
			"/mcp",
			rpc(key, "tools/call", { name: "get_treasury_curve", arguments: {} }),
		);
		const body = await readRpc(response);
		expect(body.result.isError).not.toBe(true);
		const payload = JSON.parse(body.result.content[0].text);
		expect(payload.disclosure).toContain("U.S. Department of the Treasury");
		expect(JSON.stringify(payload)).toContain('"zero_rate":4.02');
		expect(batches).toHaveLength(1);
		expect(batches[0][0].args[3]).toBe("mcp");
		// The tool is named from the body when no Mcp-Name header is sent.
		expect(batches[0][0].args[4]).toBe("tools/call get_treasury_curve");
	});
});

describe("the public surface", () => {
	test("/health needs no key", async () => {
		const { call } = await setup();
		expect((await call("/health")).status).toBe(200);
	});

	test("an unknown path is JSON, not HTML", async () => {
		const { call } = await setup();
		const response = await call("/nope");
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toContain("application/json");
	});

	test("the OpenAPI document declares bearer auth at document level", async () => {
		const { call } = await setup();
		const doc = await (await call("/openapi.json")).json();
		expect(doc.security).toEqual([{ bearerAuth: [] }]);
		expect(Object.keys(doc.paths)).toContain("/v1/curves/zero");
	});
});
