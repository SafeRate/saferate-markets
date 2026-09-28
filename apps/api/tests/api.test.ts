import { describe, expect, test } from "bun:test";
import { snakeKeys } from "@markets/mcp-tools";
import { generateApiKey } from "@markets/persistence";
import { getLatestCurve } from "@saferate/treasury-client/client";
import { ZZeroCurveOut } from "../src/routes/curves";
import { bearer, setup, TREASURY } from "./helpers";

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

	test("a real key with no live subscription is a 402 naming the fix", async () => {
		const { call, key, batches } = await setup({ isEntitled: false });
		const response = await call("/v1/curves/zero", { headers: bearer(key) });
		expect(response.status).toBe(402);
		const body = await response.json();
		expect(body.error).toBe("payment_required");
		expect(body.message).toContain("/dashboard/billing");
		expect(batches).toHaveLength(0);
	});

	test("the 402 covers MCP too", async () => {
		const { call, key } = await setup({ isEntitled: false });
		const response = await call("/mcp", {
			method: "POST",
			headers: { ...bearer(key), "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(response.status).toBe(402);
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

	// Derived from the published spec, so a /v1 route added without the gate's
	// responses fails here rather than shipping a reference that omits them.
	test("every /v1 operation documents the gate's 401, 402 and 429", async () => {
		const { call } = await setup();
		const doc = await (await call("/openapi.json")).json();
		const v1 = Object.entries(doc.paths).filter(([p]) => p.startsWith("/v1/"));
		expect(v1.length).toBeGreaterThan(0);
		for (const [path, ops] of v1) {
			for (const [method, op] of Object.entries(
				ops as Record<string, { responses: Record<string, unknown> }>,
			)) {
				for (const status of ["401", "402", "429"]) {
					expect({
						route: `${method} ${path}`,
						has: status in op.responses,
					}).toEqual({
						route: `${method} ${path}`,
						has: true,
					});
				}
			}
		}
		const zero = doc.paths["/v1/curves/zero"].get.responses;
		expect(Object.keys(zero["429"].headers)).toContain("Retry-After");
	});

	test("the OpenAPI document declares bearer auth at document level", async () => {
		const { call } = await setup();
		const doc = await (await call("/openapi.json")).json();
		expect(doc.security).toEqual([{ bearerAuth: [] }]);
		expect(Object.keys(doc.paths)).toContain("/v1/curves/zero");
	});
});
