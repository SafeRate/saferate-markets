import { describe, expect, test } from "bun:test";
import analytics from "./fixtures/broad-analytics.json";
import closed from "./fixtures/broad-constituents-2026-08-31.json";
import daily from "./fixtures/broad-daily.json";
import dailyLatest from "./fixtures/daily-latest.json";
import dailyOn from "./fixtures/daily-on-2026-08-31.json";
import open from "./fixtures/broad-open.json";
import returns from "./fixtures/broad-returns.json";
import levels from "./fixtures/indices.json";
import { bearer, setup } from "./helpers";

/**
 * The index routes, driven by REAL upstream rows: fetched from production
 * treasury-api on 2026-09-28 and trimmed to a few rows each.
 *
 * Every handler parses its output through its .strict() response schema before
 * sending it, so "200 with a real fixture" IS the parity test between the
 * client's transforms and the published OpenAPI document. A field added,
 * dropped or renamed upstream turns one of these into a 500.
 */

const refusal = (code: string) => {
	const error = new Error(code);
	error.name = code;
	return error;
};

/** The TREASURY RPC methods the index routes call, answering from fixtures. */
const treasury = (overrides: Record<string, unknown> = {}) => ({
	indexLevels: async () => levels,
	indexLevelsDailyOn: async (input?: { date?: string }) =>
		input?.date === undefined
			? dailyLatest
			: input.date === "2026-08-31"
				? dailyOn
				: [],
	indexLevelsDaily: async () => daily,
	indexReturns: async () => returns,
	indexAnalytics: async () => analytics,
	indexConstituents: async ({ date }: { date: string }) =>
		date === "2026-08-31" ? closed : [],
	openConstituents: async () => open,
	...overrides,
});

const get = async (path: string, overrides?: Record<string, unknown>) => {
	const { call, key } = await setup({ treasury: treasury(overrides) });
	const response = await call(path, { headers: bearer(key) });
	return { status: response.status, body: await response.json() };
};

describe("every index route accepts real upstream data", () => {
	test("GET /v1/indices lists all eleven, in display order, with latest levels", async () => {
		const { status, body } = await get("/v1/indices");
		expect(status).toBe(200);
		expect(body.indices.map((i: { code: string }) => i.code)).toEqual([
			"broad",
			"0103",
			"0307",
			"0710",
			"1020",
			"20PL",
			"BILL",
			"SHRT",
			"TIPS",
			"AGG",
			"FRN",
		]);
		const broad = body.indices[0];
		expect(broad.ticker).toBe("SR-UST-TR");
		expect(typeof broad.latest.level).toBe("number");
		expect(
			body.indices.find((i: { code: string }) => i.code === "AGG").former_ticker,
		).toBe("SR-UST-AGG");
	});

	// The bug this pair of fields exists to prevent: upstream's indexLevels is
	// the latest MONTH-END (2026-08-31 on 2026-09-28) while daily ran to
	// 2026-09-25. Serving it as "latest" would have been four weeks stale.
	test("latest is the newest business day, and the month-end is labelled apart", async () => {
		const { body } = await get("/v1/indices");
		const broad = body.indices[0];
		expect(broad.latest.date).toBe("2026-09-25");
		expect(broad.latest.is_provisional).toBe(true);
		expect(broad.last_month_end.date).toBe("2026-08-31");
		expect(typeof broad.last_month_end.month_return_percent).toBe("number");
	});

	test("GET /v1/indices?date= gives every daily level on that day, and no month-end", async () => {
		const { status, body } = await get("/v1/indices?date=2026-08-31");
		expect(status).toBe(200);
		expect(body.indices[0].latest.date).toBe("2026-08-31");
		expect(body.indices[0].latest.is_provisional).toBe(false);
		expect(body.indices[0].last_month_end).toBeNull();
	});

	test("GET /v1/indices/{code}", async () => {
		const { status, body } = await get("/v1/indices/TIPS");
		expect(status).toBe(200);
		expect(body.name).toBe("Inflation-Linked");
	});

	test("GET /v1/indices/{code}/levels, oldest first, code stated once", async () => {
		const { status, body } = await get("/v1/indices/broad/levels");
		expect(status).toBe(200);
		expect(body.code).toBe("broad");
		const dates = body.levels.map((l: { date: string }) => l.date);
		expect(dates).toEqual([...dates].sort());
		expect(body.levels[0]).not.toHaveProperty("code");
		expect(body.levels[0].is_provisional).toBe(true);
	});

	test("levels honours `to`", async () => {
		const { body } = await get("/v1/indices/broad/levels?to=2026-09-24");
		expect(body.levels.at(-1).date).toBe("2026-09-24");
	});

	test("GET /v1/indices/{code}/returns, in percent", async () => {
		const { status, body } = await get("/v1/indices/broad/returns");
		expect(status).toBe(200);
		// Upstream stores fractions (-0.0174); the API publishes percent.
		expect(body.mtd_percent).toBeCloseTo(returns.mtd * 100, 10);
	});

	test("GET /v1/indices/{code}/analytics", async () => {
		const { status, body } = await get("/v1/indices/broad/analytics");
		expect(status).toBe(200);
		const row = body.analytics[0];
		expect(row.rebalance_date).toBe("2026-08-31");
		expect(row.key_rate_durations.length).toBeGreaterThan(0);
	});

	test("GET /v1/indices/{code}/constituents is the open period, heaviest first", async () => {
		const { status, body } = await get("/v1/indices/broad/constituents");
		expect(status).toBe(200);
		expect(body.rebalance_date).toBe("2026-08-31");
		expect(body.as_of_date).toBe("2026-09-25");
		const weights = body.constituents.map(
			(c: { weight_percent: number }) => c.weight_percent,
		);
		expect(weights).toEqual([...weights].sort((a, b) => b - a));
		expect(body.constituents[0]).not.toHaveProperty("rebalance_date");
	});

	test("GET /v1/indices/{code}/constituents/{date} is a completed period", async () => {
		const { status, body } = await get(
			"/v1/indices/broad/constituents/2026-08-31",
		);
		expect(status).toBe(200);
		expect(body.date).toBe("2026-08-31");
		expect(body.constituents[0].cusip).toMatch(/^[0-9A-Z]{9}$/);
	});
});

describe("absence, outage and a wrong code stay distinguishable", () => {
	test("an unknown code is a 404 that lists the real ones", async () => {
		const { status, body } = await get("/v1/indices/SPX/returns");
		expect(status).toBe(404);
		expect(body.code).toBe("unknown_index");
		expect(body.message).toContain("broad");
	});

	test("a non-period-end date is a 404 that says periods end at month-ends", async () => {
		const { status, body } = await get(
			"/v1/indices/broad/constituents/2026-08-15",
		);
		expect(status).toBe(404);
		expect(body.message).toContain("month-end");
	});

	test("no levels on a weekend is a 404, not an empty list", async () => {
		const { status } = await get("/v1/indices?date=2026-08-30");
		expect(status).toBe(404);
	});

	// The client's own getIndexAnalytics would have returned [] here, and a
	// customer would read that as "this index has no analytics".
	test("an upstream OUTAGE is a 503, never empty data", async () => {
		const { status, body } = await get("/v1/indices/broad/analytics", {
			indexAnalytics: async () => {
				throw new Error("network");
			},
		});
		expect(status).toBe(503);
		expect(body.message).toContain("outage");
	});

	test("a service method this deployment LACKS is a 503 that says so", async () => {
		const { status, body } = await get("/v1/indices/broad/returns", {
			indexReturns: undefined,
		});
		expect(status).toBe(503);
		expect(body.message).toContain("not an absence of data");
	});

	// How a REAL binding reports a method the deployed treasury-api lacks,
	// measured 2026-09-28: the property is callable (so a typeof check passes)
	// and the CALL throws this TypeError. It must read as "not deployed", not be
	// retried and reported as an outage.
	test("a real stub's missing method is a 503 naming a fault, not an outage", async () => {
		const { status, body } = await get("/v1/indices/broad/returns", {
			indexReturns: async () => {
				throw new TypeError(
					'The RPC receiver does not implement the method "indexReturns".',
				);
			},
		});
		expect(status).toBe(503);
		expect(body.message).toContain("not an absence of data");
		expect(body.message).not.toContain("outage");
	});

	test("an empty open snapshot (refused as unknown_index) is a 404, not a 400", async () => {
		const { status } = await get("/v1/indices/broad/constituents", {
			openConstituents: async () => {
				throw refusal("unknown_index");
			},
		});
		expect(status).toBe(404);
	});
});

describe("the strict schemas can fail", () => {
	// Without this, "every route returned 200" could mean the schemas accept
	// anything. An extra upstream field must make the route refuse to publish it.
	test("an undeclared field reaching a response is a 500, not a silent pass", async () => {
		const { status } = await get("/v1/indices/broad/returns", {
			indexReturns: async () => returns,
		});
		expect(status).toBe(200);
		const { ZIndexReturnsOut } = await import("../src/routes/indices");
		expect(() =>
			ZIndexReturnsOut.parse({
				code: "broad",
				as_of: "2026-09-25",
				mtd_percent: 1,
				qtd_percent: 1,
				ytd_percent: 1,
				surprise: true,
			}),
		).toThrow();
	});
});
