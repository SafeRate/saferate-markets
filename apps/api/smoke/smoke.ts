/**
 * Smoke test a DEPLOYED environment with a real key.
 *
 *   doppler run --project saferate-markets --config stg -- bun apps/api/smoke/smoke.ts
 *   doppler run --project saferate-markets --config prd -- bun apps/api/smoke/smoke.ts
 *
 * Why this exists: until 2026-09-28 the only authenticated calls ever made
 * against staging or production were Dylan's, to one route. Every other route
 * was proven locally and against fakes. This calls every REST route and the MCP
 * server on the real deployment, with MARKETS_SMOKE_KEY (a key on a subscribed
 * monitoring account), and parses every body with the SAME strict schemas the
 * API publishes, so drift on the deployed service fails here.
 *
 * Run it as its own step after a deploy, never chained to one: the old Worker
 * can still answer for a moment, and you would record old behaviour as new.
 *
 * The key is read from the environment and never printed. Requests are paced
 * well under the 60/min rate limit, which this key's organization shares.
 */
import {
	resolveMarketsEnv,
	SITE_HOSTS,
	type TMarketsEnv,
} from "@markets/schema";
import type { z } from "zod";
import { ZZeroCurveOut } from "../src/routes/curves";
import {
	ZClosedConstituentsOut,
	ZIndexAnalyticsOut,
	ZIndexLevelsOut,
	ZIndexListOut,
	ZIndexReturnsOut,
	ZIndexSummaryOut,
	ZOpenConstituentsOut,
} from "../src/routes/indices";

const ENV_BY_DOPPLER: Record<string, TMarketsEnv> = {
	dev: "development",
	stg: "staging",
	prd: "production",
};

const environment = resolveMarketsEnv(
	ENV_BY_DOPPLER[process.env.DOPPLER_CONFIG ?? ""],
);
if (environment === "development") {
	console.error(
		"error: run under Doppler stg or prd. Development keys live in the local D1 only.",
	);
	process.exit(1);
}
const key = process.env.MARKETS_SMOKE_KEY?.trim() ?? "";
if (!/^srm_live_[A-Za-z0-9]{32}$/.test(key)) {
	console.error("error: MARKETS_SMOKE_KEY is missing or not a well-formed key");
	process.exit(1);
}

const API = SITE_HOSTS[environment].api;
const PACE_MS = 1_200; // 50/min at most, under the 60/min limit
const MCP_TOOLS_EXPECTED = 9;

let failures = 0;
let passes = 0;
const pass = (what: string, detail = "") => {
	passes += 1;
	console.info(`  ok    ${what}${detail ? `  ${detail}` : ""}`);
};
const fail = (what: string, detail: string) => {
	failures += 1;
	console.info(`  FAIL  ${what}  ${detail}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const request = async (
	path: string,
	init: RequestInit & { auth?: boolean } = {},
) => {
	await sleep(PACE_MS);
	const { auth = true, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (auth) headers.set("Authorization", `Bearer ${key}`);
	return fetch(`${API}${path}`, { ...rest, headers });
};

/** GET, expect a status, parse the body with the published schema. */
const check = async <T extends z.ZodType>(
	path: string,
	schema: T,
	expectStatus = 200,
): Promise<z.infer<T> | null> => {
	try {
		const response = await request(path);
		const body = await response.json();
		if (response.status !== expectStatus) {
			fail(
				`GET ${path}`,
				`${response.status} ${JSON.stringify(body).slice(0, 160)}`,
			);
			return null;
		}
		const parsed = schema.safeParse(body);
		if (!parsed.success) {
			fail(
				`GET ${path}`,
				`schema: ${parsed.error.issues[0]?.message} at ${parsed.error.issues[0]?.path.join(".")}`,
			);
			return null;
		}
		pass(`GET ${path}`);
		return parsed.data;
	} catch (error) {
		fail(`GET ${path}`, String(error));
		return null;
	}
};

const expectStatus = async (
	label: string,
	path: string,
	init: RequestInit & { auth?: boolean },
	status: number,
) => {
	const response = await request(path, init);
	if (response.status === status) pass(label, String(status));
	else fail(label, `expected ${status}, got ${response.status}`);
};

/** One MCP JSON-RPC call; the server may answer as JSON or as one SSE event. */
const mcp = async (method: string, params: unknown = {}) => {
	const response = await request("/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const text = await response.text();
	const json = text.trimStart().startsWith("{")
		? text
		: (text
				.split("\n")
				.find((l) => l.startsWith("data:"))
				?.slice(5) ?? "null");
	return { status: response.status, body: JSON.parse(json) };
};

const daysAgo = (n: number) =>
	new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

console.info(`Smoke test: ${environment} (${API})\n`);

// ── The gate ────────────────────────────────────────────────────────────────
const health = await request("/health", { auth: false });
const healthBody = (await health.json()) as { environment?: string };
if (health.status === 200 && healthBody.environment === environment) {
	pass("GET /health", healthBody.environment);
} else fail("GET /health", `${health.status} ${JSON.stringify(healthBody)}`);
await expectStatus("no key is refused", "/v1/indices", { auth: false }, 401);
await expectStatus(
	"MCP without a key is refused",
	"/mcp",
	{ auth: false, method: "POST" },
	401,
);

// ── Curves ──────────────────────────────────────────────────────────────────
const curve = await check("/v1/curves/zero", ZZeroCurveOut);
if (curve && curve.points.length !== 10)
	fail("zero curve has 10 tenors", String(curve.points.length));

// ── Indices ─────────────────────────────────────────────────────────────────
const list = await check("/v1/indices", ZIndexListOut);
if (list) {
	if (list.indices.length === 11) pass("11 indices listed");
	else fail("11 indices listed", String(list.indices.length));
	const stale = list.indices.filter(
		(i) => i.latest && i.last_month_end && i.latest.date < i.last_month_end.date,
	);
	if (stale.length === 0) pass("every latest is on or after its last month-end");
	else fail("latest before last month-end", stale.map((i) => i.code).join(","));
}
const monthEnd = list?.indices[0]?.last_month_end?.date;
// A deep check on four that differ in kind: nominal, bills, linkers, floaters.
for (const code of ["broad", "BILL", "TIPS", "FRN"]) {
	await check(`/v1/indices/${code}`, ZIndexSummaryOut);
	const levels = await check(
		`/v1/indices/${code}/levels?from=${daysAgo(14)}`,
		ZIndexLevelsOut,
	);
	if (levels && levels.levels.length === 0)
		fail(`${code} has recent levels`, "none in 14 days");
	await check(`/v1/indices/${code}/returns`, ZIndexReturnsOut);
	await check(`/v1/indices/${code}/analytics`, ZIndexAnalyticsOut);
	await check(`/v1/indices/${code}/constituents`, ZOpenConstituentsOut);
	if (monthEnd)
		await check(
			`/v1/indices/${code}/constituents/${monthEnd}`,
			ZClosedConstituentsOut,
		);
}
await expectStatus("an unknown index is a 404", "/v1/indices/SPX", {}, 404);

// ── The published contract ──────────────────────────────────────────────────
const spec = (await (
	await request("/openapi.json", { auth: false })
).json()) as {
	paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
};
const v1 = Object.entries(spec.paths).filter(([p]) => p.startsWith("/v1/"));
const undocumented = v1.filter(
	([, ops]) =>
		!Object.values(ops).every((op) =>
			["401", "402", "429"].every((s) => s in op.responses),
		),
);
if (v1.length > 0 && undocumented.length === 0)
	pass("spec documents the gate on every /v1 route", `${v1.length} routes`);
else
	fail(
		"spec documents the gate",
		undocumented.map(([p]) => p).join(", ") || "no /v1 routes",
	);

// ── MCP ─────────────────────────────────────────────────────────────────────
const tools = await mcp("tools/list");
const names = (tools.body?.result?.tools ?? []).map(
	(t: { name: string }) => t.name,
);
if (tools.status === 200 && names.length === MCP_TOOLS_EXPECTED)
	pass("MCP tools/list", `${names.length} tools`);
else fail("MCP tools/list", `${tools.status} ${names.length} tools`);

for (const [name, args] of [
	["get_treasury_curve", {}],
	["get_treasury_index", { code: "broad" }],
	["list_treasury_securities", {}],
] as const) {
	const call = await mcp("tools/call", { name, arguments: args });
	const result = call.body?.result;
	const payload = (() => {
		try {
			return JSON.parse(result?.content?.[0]?.text ?? "null");
		} catch {
			return null;
		}
	})();
	if (
		call.status === 200 &&
		result &&
		!result.isError &&
		payload?.ok !== false
	) {
		pass(`MCP ${name}`);
	} else {
		fail(`MCP ${name}`, JSON.stringify(call.body).slice(0, 200));
	}
}

console.info(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
