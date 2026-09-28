import { describe, expect, test } from "bun:test";
import frnDetail from "./fixtures/securities/frn-detail.json";
import frnAnalytics from "./fixtures/securities/frn-frn-analytics.json";
import frnPrices from "./fixtures/securities/frn-prices.json";
import billAnalytics from "./fixtures/securities/bill-analytics.json";
import billDetail from "./fixtures/securities/bill-detail.json";
import billPrices from "./fixtures/securities/bill-prices.json";
import noteAnalytics from "./fixtures/securities/nominal-analytics.json";
import noteDetail from "./fixtures/securities/nominal-detail.json";
import notePrices from "./fixtures/securities/nominal-prices.json";
import tipsDetail from "./fixtures/securities/tips-detail.json";
import tipsPrices from "./fixtures/securities/tips-prices.json";
import tipsAnalytics from "./fixtures/securities/tips-tips-analytics.json";
import { bearer, setup } from "./helpers";

/**
 * CUSIP lookup, driven by REAL rows for one security of each kind (fetched from
 * production treasury-api 2026-09-28: 10-year note 91282CMM0, TIPS 91282CNS6,
 * FRN 91282CPG0, bill 912797UJ4). Every handler parses its output with its
 * .strict() schema, so a 200 here is the parity test with the client.
 */

const KINDS = {
	note: { detail: noteDetail, prices: notePrices, analytics: noteAnalytics },
	tips: { detail: tipsDetail, prices: tipsPrices, analytics: tipsAnalytics },
	frn: { detail: frnDetail, prices: frnPrices, analytics: frnAnalytics },
	bill: { detail: billDetail, prices: billPrices, analytics: billAnalytics },
} as const;

/** One kind's security, as the service would answer; the others unknown. */
const treasuryFor = (
	kind: keyof typeof KINDS,
	overrides: Record<string, unknown> = {},
) => {
	const k = KINDS[kind];
	return {
		security: async () => k.detail,
		securityPrices: async () => k.prices,
		// TIPS and FRNs have no nominal rows, as upstream (measured).
		securityAnalytics: async () =>
			kind === "note" || kind === "bill" ? k.analytics : [],
		tipsAnalytics: async () => (kind === "tips" ? k.analytics : []),
		frnAnalytics: async () => (kind === "frn" ? k.analytics : []),
		...overrides,
	};
};

const get = async (
	kind: keyof typeof KINDS,
	path: string,
	overrides?: Record<string, unknown>,
) => {
	const { call, key } = await setup({ treasury: treasuryFor(kind, overrides) });
	const response = await call(path, { headers: bearer(key) });
	return { status: response.status, body: await response.json() };
};

describe("every kind of security, from real data", () => {
	for (const [kind, basis] of [
		["note", "nominal"],
		["bill", "nominal"],
		["tips", "tips"],
		["frn", "frn"],
	] as const) {
		test(`${kind}: lookup picks the ${basis} analytics table`, async () => {
			const { status, body } = await get(kind, "/v1/securities/ABCDEFGH1");
			expect(status).toBe(200);
			expect(body.analytics_basis).toBe(basis);
			expect(body.latest_analytics).not.toBeNull();
			expect(body.latest_price.date).toBe("2026-09-25");
		});

		test(`${kind}: prices and analytics are oldest first`, async () => {
			const prices = await get(kind, "/v1/securities/ABCDEFGH1/prices");
			const analytics = await get(kind, "/v1/securities/ABCDEFGH1/analytics");
			expect(prices.status).toBe(200);
			expect(analytics.status).toBe(200);
			for (const rows of [prices.body.prices, analytics.body.analytics]) {
				const dates = rows.map((r: { date: string }) => r.date);
				expect(dates).toEqual([...dates].sort());
			}
		});
	}

	test("a CUSIP is case-insensitive", async () => {
		const { body } = await get("note", "/v1/securities/91282cmm0");
		expect(body.cusip).toBe("91282CMM0");
	});

	test("prices honour from and to", async () => {
		const { body } = await get(
			"note",
			"/v1/securities/91282CMM0/prices?from=2026-09-24&to=2026-09-24",
		);
		expect(body.prices.map((p: { date: string }) => p.date)).toEqual([
			"2026-09-24",
		]);
	});
});

describe("the conventions a client could misread", () => {
	// Measured: every bill has a null z (it is not scored). Null must survive
	// as null, never become 0, or a screen ranks every bill as "ordinary".
	test("a bill's z-score is null, not zero", async () => {
		const { body } = await get("bill", "/v1/securities/912797UJ4/analytics");
		for (const row of body.analytics) expect(row.residual_z_score).toBeNull();
	});

	test("the residual field names split the acronym: residual_z_score", async () => {
		const { body } = await get("note", "/v1/securities/91282CMM0");
		expect(body.latest_analytics).toHaveProperty("residual_z_score");
		expect(body.latest_analytics).not.toHaveProperty("residual_zscore");
	});

	// Upstream stores "no bid" as 0. It must reach a client as null.
	test("a zero bid from upstream is published as null", async () => {
		const zeroBid = notePrices.map((p, i) => (i === 0 ? { ...p, buy: 0 } : p));
		const { body } = await get("note", "/v1/securities/91282CMM0/prices", {
			securityPrices: async () => zeroBid,
		});
		expect(body.prices.some((p: { bid: number | null }) => p.bid === null)).toBe(
			true,
		);
		expect(body.prices.some((p: { bid: number | null }) => p.bid === 0)).toBe(
			false,
		);
	});
});

// The privacy policy (section 3) promises our usage records hold the route
// PATTERN, not the CUSIP or dates asked about. This keeps that promise true.
describe("what the meter records", () => {
	test("the route pattern, never the CUSIP or the query", async () => {
		const { call, key, batches } = await setup({ treasury: treasuryFor("note") });
		await call("/v1/securities/91282CMM0/prices?from=2026-09-24", {
			headers: bearer(key),
		});
		const operation = String(batches[0][0].args[4]);
		expect(operation).toBe("/v1/securities/:cusip/prices");
		expect(operation).not.toContain("91282CMM0");
		expect(operation).not.toContain("2026");
	});
});

describe("absence, and an unknown CUSIP", () => {
	test("an unknown CUSIP is a 404", async () => {
		const { status, body } = await get("note", "/v1/securities/912810ZZ9", {
			security: async () => null,
			securityPrices: async () => [],
		});
		expect(status).toBe(404);
		expect(body.message).toContain("912810ZZ9");
	});

	test("a malformed CUSIP is a 400", async () => {
		const { status } = await get("note", "/v1/securities/not-a-cusip");
		expect(status).toBe(400);
	});

	test("an empty date range is a 404 that says so, not an empty list", async () => {
		const { status, body } = await get(
			"note",
			"/v1/securities/91282CMM0/prices?from=2030-01-01",
		);
		expect(status).toBe(404);
		expect(body.message).toContain("in that range");
	});

	test("an upstream outage is a 503, never a 404", async () => {
		const { status } = await get("note", "/v1/securities/91282CMM0", {
			security: async () => {
				throw new Error("network");
			},
		});
		expect(status).toBe(503);
	});
});
