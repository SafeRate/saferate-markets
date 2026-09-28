import { describe, expect, test } from "bun:test";
import breakeven from "./fixtures/curves/breakeven.json";
import moneyMarket from "./fixtures/curves/money-market.json";
import par from "./fixtures/curves/par.json";
import real from "./fixtures/curves/real.json";
import { bearer, setup, ZERO_ROW } from "./helpers";

/**
 * Par, money market, real and breakeven curves, and the history routes, on
 * PRODUCTION rows for 2026-09-25 (read through get_treasury_curve on
 * api.saferate.markets on 2026-09-28 and mapped back to upstream's column
 * names; each round-trips through the client's parser). Every handler parses
 * its output with its .strict() schema, so a 200 is the parity test.
 */

const DAY = "2026-09-25";
const FRIDAY_BEFORE = "2026-09-18";

const treasury = (overrides: Record<string, unknown> = {}) => ({
	latestCurve: async () => ({ date: DAY, zero: [ZERO_ROW] }),
	curvesOn: async (date: string) =>
		date === DAY
			? { date, zero: [ZERO_ROW], nss: par, moneyMarket, dieboldLi: null }
			: { date, zero: [], nss: null, moneyMarket: null, dieboldLi: null },
	realCurve: async (input: { date?: string; from?: string; to?: string }) =>
		input.date !== undefined
			? input.date === DAY
				? real
				: null
			: [
					{ ...real, date: DAY },
					{ ...real, date: FRIDAY_BEFORE },
				],
	breakevenOn: async ({ date }: { date: string }) =>
		date === DAY ? breakeven : null,
	curveSeries: async ({ family }: { family: string }) => ({
		rows:
			family === "money-market"
				? [moneyMarket, { ...moneyMarket, date: FRIDAY_BEFORE }]
				: [
						{ ...ZERO_ROW, date: DAY, tenor_years: 2 },
						{ ...ZERO_ROW, date: FRIDAY_BEFORE, tenor_years: 10 },
						{ ...ZERO_ROW, date: FRIDAY_BEFORE, tenor_years: 2 },
					],
		truncated: false,
	}),
	...overrides,
});

const get = async (path: string, overrides?: Record<string, unknown>) => {
	const { call, key } = await setup({ treasury: treasury(overrides) });
	const response = await call(path, { headers: bearer(key) });
	return { status: response.status, body: await response.json() };
};

describe("one day, from real rows", () => {
	for (const slug of ["par", "money-market", "real", "breakeven"]) {
		test(`${slug}: dated and latest both 200 on the same day`, async () => {
			const dated = await get(`/v1/curves/${slug}?date=${DAY}`);
			const latest = await get(`/v1/curves/${slug}`);
			expect(dated.status).toBe(200);
			expect(latest.status).toBe(200);
			expect(latest.body).toEqual(dated.body);
			expect(dated.body.date).toBe(DAY);
		});

		test(`${slug}: a weekend is a 404`, async () => {
			const { status, body } = await get(`/v1/curves/${slug}?date=2026-09-27`);
			expect(status).toBe(404);
			expect(body.error).toBe("no_data");
		});
	}

	test("the values arrive as fitted", async () => {
		const mm = await get(`/v1/curves/money-market?date=${DAY}`);
		expect(mm.body.convention).toBe("bond equivalent");
		expect(mm.body.rates[0]).toEqual({
			label: "1W",
			rate: moneyMarket.rate_01w,
			tenor_years: 7 / 365,
		});
		const be = await get(`/v1/curves/breakeven?date=${DAY}`);
		expect(
			be.body.points.map((p: { tenor_years: number }) => p.tenor_years),
		).toEqual([2, 3, 5, 7, 10, 20]);
		const ten = be.body.points.find(
			(p: { tenor_years: number }) => p.tenor_years === 10,
		);
		expect(ten.breakeven).toBeCloseTo(ten.nominal - ten.real, 12);
	});

	test("no date, and the latest nominal day lacks this family: steps back", async () => {
		const { status, body } = await get("/v1/curves/real", {
			latestCurve: async () => ({ date: "2026-09-28", zero: [ZERO_ROW] }),
		});
		expect(status).toBe(200);
		expect(body.date).toBe(DAY);
	});
});

describe("history", () => {
	test("zero: oldest first, then by tenor", async () => {
		const { status, body } = await get(
			`/v1/curves/zero/history?from=${FRIDAY_BEFORE}&to=${DAY}`,
		);
		expect(status).toBe(200);
		expect(
			body.points.map((p: { date: string; tenor_years: number }) => [
				p.date,
				p.tenor_years,
			]),
		).toEqual([
			[FRIDAY_BEFORE, 2],
			[FRIDAY_BEFORE, 10],
			[DAY, 2],
		]);
	});

	for (const slug of ["money-market", "real"]) {
		test(`${slug}: oldest first`, async () => {
			const { status, body } = await get(
				`/v1/curves/${slug}/history?from=${FRIDAY_BEFORE}&to=${DAY}`,
			);
			expect(status).toBe(200);
			expect(body.days.map((d: { date: string }) => d.date)).toEqual([
				FRIDAY_BEFORE,
				DAY,
			]);
		});
	}

	test("ranges are refused before any read: reversed, pre-coverage, too long", async () => {
		const reads: string[] = [];
		const spy = {
			curveSeries: async () => {
				reads.push("curveSeries");
				return { rows: [], truncated: false };
			},
		};
		for (const query of [
			`from=${DAY}&to=${FRIDAY_BEFORE}`,
			"from=2007-01-01&to=2007-06-01",
			"from=2024-01-01&to=2026-01-01",
		]) {
			const { status } = await get(`/v1/curves/zero/history?${query}`, spy);
			expect(status).toBe(400);
		}
		expect(reads).toEqual([]);
	});

	test("a year of the zero curve is allowed; five of money market", async () => {
		expect(
			(await get("/v1/curves/zero/history?from=2025-09-26&to=2026-09-25")).status,
		).toBe(200);
		expect(
			(await get("/v1/curves/money-market/history?from=2021-09-26&to=2026-09-25"))
				.status,
		).toBe(200);
	});

	test("an upstream truncation is never served as a complete series", async () => {
		const { status } = await get(
			`/v1/curves/zero/history?from=${FRIDAY_BEFORE}&to=${DAY}`,
			{
				curveSeries: async () => ({ rows: [ZERO_ROW], truncated: true }),
			},
		);
		expect(status).not.toBe(200);
	});
});
