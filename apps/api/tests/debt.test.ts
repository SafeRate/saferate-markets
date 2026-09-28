import { describe, expect, test } from "bun:test";
import summary from "./fixtures/debt/debt-summary-2026-08-31.json";
import stripsOn from "./fixtures/debt/strips-on-2026-08-31.json";
import stripsSeries from "./fixtures/debt/strips-series-last24.json";
import { bearer, setup } from "./helpers";

/**
 * /v1/debt and /v1/strips on the PRODUCTION statement for 2026-08-31 (read
 * through get_treasury_debt on api.saferate.markets, 2026-09-28, mapped back to
 * upstream's columns): all 14 debt lines, the ten most-stripped securities and
 * the last 24 monthly STRIPS statements.
 */

const treasury = (overrides: Record<string, unknown> = {}) => ({
	debtSummary: async ({ date }: { date: string }) =>
		date >= "2001-01-31" ? summary : [],
	stripsOn: async () => stripsOn,
	stripsSeries: async () => stripsSeries,
	...overrides,
});

const get = async (path: string, overrides?: Record<string, unknown>) => {
	const { call, key } = await setup({ treasury: treasury(overrides) });
	const response = await call(path, { headers: bearer(key) });
	return { status: response.status, body: await response.json() };
};

describe("/v1/debt", () => {
	test("the statement, with the headline and both groups", async () => {
		const { status, body } = await get("/v1/debt?on=2026-09-25");
		expect(status).toBe(200);
		expect(body.record_date).toBe("2026-08-31");
		expect(body.headline.security_type).toBe("Total Public Debt Outstanding");
		expect(body.headline.total).toBeGreaterThan(body.headline.debt_held_public);
		expect(body.marketable).toHaveLength(6);
		expect(body.nonmarketable).toHaveLength(5);
		expect(body).not.toHaveProperty("details");
	});

	test("the class lines tie to the published totals", async () => {
		const { body } = await get("/v1/debt");
		expect(Math.abs(body.marketable_tie.gap)).toBeLessThan(1);
		expect(Math.abs(body.nonmarketable_tie.gap)).toBeLessThan(1);
	});

	test("before the first statement is a 404", async () => {
		const { status } = await get("/v1/debt?on=1999-12-31");
		expect(status).toBe(404);
	});
});

describe("/v1/strips", () => {
	test("the float, by class and most stripped", async () => {
		const { status, body } = await get("/v1/strips?on=2026-09-25");
		expect(status).toBe(200);
		expect(body.latest.record_date).toBe("2026-08-31");
		expect(body.latest.stripped_share_percent).toBeCloseTo(2.6217, 4);
		expect(body.most_stripped).toHaveLength(10);
		expect(body.trailing_statements).toBe(12);
		const shares = body.most_stripped.map(
			(s: { stripped_share_of_size: number }) => s.stripped_share_of_size,
		);
		expect(shares).toEqual([...shares].sort((a, b) => b - a));
	});

	test("nothing on file is a 404, not an empty float", async () => {
		const { status } = await get("/v1/strips", { stripsOn: async () => [] });
		expect(status).toBe(404);
	});
});
