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
import { TREASURY_TOOL_NAMES } from "@markets/mcp-tools";
import {
	resolveMarketsEnv,
	SITE_HOSTS,
	type TMarketsEnv,
} from "@markets/schema";
import { z } from "zod";
import {
	ZBreakevenOut,
	ZMoneyMarketCurveOut,
	ZParCurveOut,
	ZRealCurveOut,
} from "../src/routes/curveFamilies";
import { ZBillPriceOut, ZCouponPriceOut } from "../src/routes/pricing";
import { ZRichCheapOut } from "../src/routes/richCheap";
import { ZOnTheRunOut, ZSecurityListOut } from "../src/routes/securityLists";
import { ZZeroCurveOut, ZZeroCurvePointOut } from "../src/routes/curves";
import {
	ZSecurityAnalyticsOut,
	ZSecurityOut,
	ZSecurityPricesOut,
} from "../src/routes/securities";
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
const PACE_MS = 1_300; // ~46/min, under the 60/min Individual limit
const MCP_TOOLS_EXPECTED = TREASURY_TOOL_NAMES.length;

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

// ── The other curves: each must be on the same recent day as the zero curve
// or close to it, and every history non-empty over the last two weeks.
for (const [path, schema] of [
	["/v1/curves/par", ZParCurveOut],
	["/v1/curves/money-market", ZMoneyMarketCurveOut],
	["/v1/curves/real", ZRealCurveOut],
	["/v1/curves/breakeven", ZBreakevenOut],
] as const) {
	const day = (await check(path, schema as z.ZodType)) as {
		date: string;
	} | null;
	if (day && day.date < daysAgo(7)) fail(`${path} date`, `stale: ${day.date}`);
}
for (const [slug, field, schema] of [
	["zero", "points", ZZeroCurvePointOut],
	["money-market", "days", ZMoneyMarketCurveOut],
	["real", "days", ZRealCurveOut],
] as const) {
	const history = (await check(
		`/v1/curves/${slug}/history?from=${daysAgo(14)}&to=${daysAgo(0)}`,
		z
			.object({ from: z.string(), to: z.string(), [field]: z.array(schema) })
			.strict(),
	)) as Record<string, unknown[]> | null;
	if (history && (history[field] ?? []).length === 0)
		fail(`${slug} history`, "empty over the last two weeks");
}
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
// Each one's heaviest constituent is kept for the security checks below, so
// those always use a live CUSIP of that kind rather than a hardcoded one.
const cusipsByIndex = new Map<string, string>();
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
	const open = await check(
		`/v1/indices/${code}/constituents`,
		ZOpenConstituentsOut,
	);
	const top = open?.constituents[0]?.cusip;
	if (top) cusipsByIndex.set(code, top);
	if (monthEnd)
		await check(
			`/v1/indices/${code}/constituents/${monthEnd}`,
			ZClosedConstituentsOut,
		);
}
await expectStatus("an unknown index is a 404", "/v1/indices/SPX", {}, 404);

// ── Securities (CUSIP lookup) ───────────────────────────────────────────────
// One of each analytics basis: the broad index's top holding is a note or bond
// (nominal), BILL's a bill (nominal), TIPS's a TIPS, FRN's a floater.
const EXPECTED_BASIS: Record<string, string> = {
	broad: "nominal",
	BILL: "nominal",
	TIPS: "tips",
	FRN: "frn",
};
for (const [code, basis] of Object.entries(EXPECTED_BASIS)) {
	const cusip = cusipsByIndex.get(code);
	if (!cusip) {
		fail(`security from ${code}`, "no constituent to look up");
		continue;
	}
	const security = await check(`/v1/securities/${cusip}`, ZSecurityOut);
	if (security && security.analytics_basis !== basis) {
		fail(
			`${cusip} analytics basis`,
			`expected ${basis}, got ${security.analytics_basis}`,
		);
	}
	await check(
		`/v1/securities/${cusip}/prices?from=${daysAgo(14)}`,
		ZSecurityPricesOut,
	);
	await check(
		`/v1/securities/${cusip}/analytics?from=${daysAgo(14)}`,
		ZSecurityAnalyticsOut,
	);
}
// ── Finding a CUSIP ─────────────────────────────────────────────────────────
// The whole priced stock is several hundred securities of every family, and
// every on-the-run security is priced: a short or unpriced list is absence.
const listed = await check("/v1/securities", ZSecurityListOut);
if (listed) {
	const families = new Set(listed.securities.map((s) => s.family));
	const missing = ["bill", "note", "bond", "tips", "frn"].filter(
		(f) => !families.has(f as never),
	);
	if (listed.count < 200 || missing.length > 0)
		fail(
			"securities list",
			`${listed.count} listed; missing ${missing.join(", ") || "none"}`,
		);
	else pass("securities list", `${listed.date}: ${listed.count} securities`);
}
const onTheRun = await check("/v1/on-the-run", ZOnTheRunOut);
if (onTheRun) {
	const unpriced = onTheRun.queues
		.map((q) => q.members[0])
		.filter((m) => m?.run_rank !== 0 || m.maturity_date === null);
	if (onTheRun.queues.length < 10 || unpriced.length > 0)
		fail(
			"on-the-run",
			`${onTheRun.queues.length} queues; ${unpriced.length} leaders unpriced`,
		);
	else pass("on-the-run", `${onTheRun.date}: ${onTheRun.queues.length} queues`);
}
await check("/v1/on-the-run?basis=auction", ZOnTheRunOut);

// ── Calculators: price a real note and a real bill at their own closes ─────
// Well inside their lives: the first in the list mature within days, where
// a yield is a degenerate check.
const aNote = listed?.securities.find(
	(s) => s.family === "note" && s.maturity_date > daysAgo(-730),
);
const aBill = listed?.securities.find(
	(s) => s.family === "bill" && s.maturity_date > daysAgo(-90),
);
if (listed && aNote) {
	const priced = await check(
		`/v1/price/coupon?cusip=${aNote.cusip}&clean_price=${aNote.price}&trade_date=${listed.date}`,
		ZCouponPriceOut,
	);
	if (
		priced &&
		!(
			priced.yield_to_maturity_percent > 0 && priced.yield_to_maturity_percent < 15
		)
	)
		fail(
			"coupon yield",
			`${priced.yield_to_maturity_percent}% for ${aNote.cusip}`,
		);
}
if (listed && aBill) {
	const priced = await check(
		`/v1/price/bill?maturity_date=${aBill.maturity_date}&price=${aBill.price}&trade_date=${listed.date}`,
		ZBillPriceOut,
	);
	// For a positive rate the investment rate always exceeds the discount rate.
	if (priced && !(priced.investment_rate_percent > priced.discount_rate_percent))
		fail(
			"bill rates",
			`investment ${priced.investment_rate_percent} vs discount ${priced.discount_rate_percent}`,
		);
}

await expectStatus(
	"an unknown CUSIP is a 404",
	"/v1/securities/912810ZZ9",
	{},
	404,
);

// ── Rich/cheap ──────────────────────────────────────────────────────────────
// Ranked by |z|, on a recent day, non-empty, and nothing inside the one-year
// floor: an empty ranking on a normal day is absence wearing a 200.
const ranking = await check("/v1/rich-cheap?limit=100", ZRichCheapOut);
if (ranking) {
	const zs = ranking.securities.map((s) => Math.abs(s.z_score));
	const detail = `${ranking.date}: ${ranking.matched_count} scored, ${ranking.unscored_count} unscored`;
	if (!zs.every((z, i) => i === 0 || zs[i - 1] >= z))
		fail("rich-cheap order", "not sorted by |z|");
	else if (ranking.date < daysAgo(7)) fail("rich-cheap date", detail);
	else if (ranking.matched_count === 0)
		fail("rich-cheap", `nothing scored: ${detail}`);
	else if (
		ranking.securities.some((s) => s.years_to_maturity < ranking.min_years)
	)
		fail("rich-cheap floor", `a security inside ${ranking.min_years}y`);
	else pass("rich-cheap ranking", detail);
}
await check(
	"/v1/rich-cheap?family=bond&direction=cheaper&min_years=10&limit=5",
	ZRichCheapOut,
);
await expectStatus(
	"rich-cheap on a Sunday is a 404",
	"/v1/rich-cheap?date=2026-09-27",
	{},
	404,
);

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
	["get_treasury_index", {}],
	["get_treasury_index", { code: "broad" }],
	["list_treasury_securities", {}],
	["get_treasury_rich_cheap", {}],
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
	const label = `MCP ${name}${Object.keys(args).length ? ` ${JSON.stringify(args)}` : ""}`;
	// The listing must carry a DAILY latest per index, never the month-end
	// mislabelled as latest (the defect fixed 2026-09-28).
	type TListed = {
		latest?: { date: string } | null;
		last_month_end?: { date: string } | null;
	};
	const isStaleListing =
		Array.isArray(payload?.indices) &&
		(payload.indices as TListed[]).some(
			(i) =>
				!i.latest || (i.last_month_end && i.latest.date < i.last_month_end.date),
		);
	if (isStaleListing) {
		fail(label, "an index has no latest, or one older than its month-end");
	} else if (
		call.status === 200 &&
		result &&
		!result.isError &&
		payload?.ok !== false
	) {
		pass(label);
	} else {
		fail(`MCP ${name}`, JSON.stringify(call.body).slice(0, 200));
	}
}

console.info(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
