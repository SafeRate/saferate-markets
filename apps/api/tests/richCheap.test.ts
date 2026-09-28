import { describe, expect, test } from "bun:test";
import billAnalytics from "./fixtures/securities/bill-analytics.json";
import billPrices from "./fixtures/securities/bill-prices.json";
import noteAnalytics from "./fixtures/securities/nominal-analytics.json";
import notePrices from "./fixtures/securities/nominal-prices.json";
import tipsPrices from "./fixtures/securities/tips-prices.json";
import tipsAnalytics from "./fixtures/securities/tips-tips-analytics.json";
import { readRichCheap } from "@markets/mcp-tools";
import { bearer, setup } from "./helpers";

/**
 * /v1/rich-cheap, on REAL production rows (the 2026-09-25 rows of the CUSIP
 * fixtures: 10-year note 91282CMM0, bill 912797UJ4, TIPS 91282CNS6). A day
 * needs several securities, so the note row is cloned under other CUSIPs with
 * only the CUSIP, maturity, residual and z changed: every other field, and so
 * the parse through the client's schemas, is the production row's.
 */

const DAY = "2026-09-25";

const note = noteAnalytics.find((row) => row.date === DAY);
const notePrice = notePrices.find((row) => row.date === DAY);
const bill = billAnalytics.find((row) => row.date === DAY);
const billPrice = billPrices.find((row) => row.date === DAY);
const tipsPrice = tipsPrices.find((row) => row.date === DAY);
if (!note || !notePrice || !bill || !billPrice || !tipsPrice)
	throw new Error("fixtures lack a 2026-09-25 row");

type TVariant = {
	cusip: string;
	z: number | null;
	bp: number | null;
	maturity: string;
	type?: string;
};

const VARIANTS: TVariant[] = [
	// The real row: +3.74bp (cheap to the curve), z +1.81 (cheaper than usual).
	{
		cusip: note.cusip,
		z: note.residual_z_score,
		bp: note.residual_basis_points,
		maturity: notePrice.maturity_date,
	},
	// Rich to the curve AND richer than usual, by more: ranks first.
	{ cusip: "91282CAAA", z: -2.6, bp: -1.2, maturity: "2029-05-15" },
	// Rich to the curve but CHEAPER than usual: the two can disagree.
	{ cusip: "91282CBBB", z: 0.4, bp: -0.8, maturity: "2031-11-15" },
	// A bond, cheap and cheapening.
	{
		cusip: "912810ZZZ",
		z: 2.1,
		bp: 2.2,
		maturity: "2054-08-15",
		type: "MARKET BASED BOND",
	},
	// A new issue: no z yet. Must be counted, never ranked as ordinary.
	{ cusip: "91282CNEW", z: null, bp: 0.3, maturity: "2036-08-15" },
];

const nominalDay = [
	...VARIANTS.map((v) => ({
		...note,
		cusip: v.cusip,
		residual_basis_points: v.bp,
		residual_z_score: v.z,
	})),
	bill, // bills have a nominal-table row with a null z, as upstream
];

const priceDay = [
	...VARIANTS.map((v) => ({
		...notePrice,
		cusip: v.cusip,
		maturity_date: v.maturity,
		security_type: v.type ?? notePrice.security_type,
	})),
	billPrice,
	tipsPrice,
];

const tipsDay = tipsAnalytics
	.map((row, i) => ({
		...row,
		date: DAY,
		cusip: tipsPrice.cusip,
		residual_z_score: i === 0 ? -1.5 : row.residual_z_score,
	}))
	.slice(0, 1);

const treasury = (overrides: Record<string, unknown> = {}) => ({
	latestPriceDate: async () => DAY,
	analyticsOn: async (date: string) => (date === DAY ? nominalDay : []),
	tipsAnalyticsOn: async ({ date }: { date: string }) =>
		date === DAY ? tipsDay : [],
	pricesOn: async ({ date }: { date: string }) => (date === DAY ? priceDay : []),
	...overrides,
});

const get = async (path: string, overrides?: Record<string, unknown>) => {
	const { call, key } = await setup({ treasury: treasury(overrides) });
	const response = await call(path, { headers: bearer(key) });
	return { status: response.status, body: await response.json() };
};

describe("the ranking", () => {
	test("is by |z|, largest first, with ranks", async () => {
		const { status, body } = await get(`/v1/rich-cheap?date=${DAY}`);
		expect(status).toBe(200);
		expect(body.ranked_by).toBe("abs_z_score");
		expect(body.securities.map((s: { cusip: string }) => s.cusip)).toEqual([
			"91282CAAA",
			"912810ZZZ",
			"91282CMM0",
			"91282CBBB",
		]);
		expect(body.securities.map((s: { rank: number }) => s.rank)).toEqual([
			1, 2, 3, 4,
		]);
	});

	test("an unscored security is counted, not ranked, and bills are not in it", async () => {
		const { body } = await get(`/v1/rich-cheap?date=${DAY}`);
		const cusips = body.securities.map((s: { cusip: string }) => s.cusip);
		expect(cusips).not.toContain("91282CNEW");
		expect(cusips).not.toContain(bill.cusip);
		expect(body.unscored_count).toBe(1);
		expect(body.matched_count).toBe(4);
	});

	test("carries the terms from the day's prices", async () => {
		const { body } = await get(`/v1/rich-cheap?date=${DAY}`);
		const real = body.securities.find(
			(s: { cusip: string }) => s.cusip === "91282CMM0",
		);
		expect(real.family).toBe("note");
		expect(real.maturity_date).toBe("2035-02-15");
		expect(real.coupon_percent).toBeCloseTo(4.625, 10);
		expect(real.price).toBe(96.53125);
		expect(real.years_to_maturity).toBeCloseTo(8.39, 2);
		const bond = body.securities.find(
			(s: { cusip: string }) => s.cusip === "912810ZZZ",
		);
		expect(bond.family).toBe("bond");
	});

	test("limit cuts the list but not the count", async () => {
		const { body } = await get(`/v1/rich-cheap?date=${DAY}&limit=2`);
		expect(body.securities).toHaveLength(2);
		expect(body.matched_count).toBe(4);
	});
});

describe("the conventions a client could misread", () => {
	// Measured on the real row: -24.7 cents and +3.74bp are the SAME fact.
	test("the real row: price residual negative, yield residual positive, both cheap", async () => {
		const { body } = await get(`/v1/rich-cheap?date=${DAY}`);
		const real = body.securities.find(
			(s: { cusip: string }) => s.cusip === "91282CMM0",
		);
		expect(real.price_residual_cents).toBeLessThan(0);
		expect(real.residual_basis_points).toBeGreaterThan(0);
		expect(real.vs_curve).toBe("cheap");
		expect(real.vs_history).toBe("cheaper");
	});

	test("vs_curve and vs_history can disagree", async () => {
		const { body } = await get(`/v1/rich-cheap?date=${DAY}`);
		const row = body.securities.find(
			(s: { cusip: string }) => s.cusip === "91282CBBB",
		);
		expect(row.vs_curve).toBe("rich");
		expect(row.vs_history).toBe("cheaper");
	});
});

describe("filters", () => {
	test("direction=richer keeps negative z only", async () => {
		const { body } = await get(`/v1/rich-cheap?date=${DAY}&direction=richer`);
		expect(body.securities.map((s: { cusip: string }) => s.cusip)).toEqual([
			"91282CAAA",
		]);
	});

	test("direction=cheaper keeps positive z only", async () => {
		const { body } = await get(`/v1/rich-cheap?date=${DAY}&direction=cheaper`);
		for (const s of body.securities) expect(s.z_score).toBeGreaterThan(0);
		expect(body.securities).toHaveLength(3);
	});

	test("family=bond", async () => {
		const { body } = await get(`/v1/rich-cheap?date=${DAY}&family=bond`);
		expect(body.securities.map((s: { cusip: string }) => s.cusip)).toEqual([
			"912810ZZZ",
		]);
	});

	test("years to maturity bound both ways", async () => {
		const { body } = await get(
			`/v1/rich-cheap?date=${DAY}&min_years=4&max_years=10`,
		);
		expect(body.securities.map((s: { cusip: string }) => s.cusip).sort()).toEqual(
			["91282CBBB", "91282CMM0"],
		);
	});
});

describe("the one-year floor", () => {
	// Measured 2026-09-25: inside a year the curve is extrapolated and the
	// shortest notes filled the top of the list on 2-3 cent price errors.
	const shortDay = () => ({
		analyticsOn: async (date: string) =>
			date === DAY
				? [...nominalDay, { ...note, cusip: "91282CSHT", residual_z_score: 5.3 }]
				: [],
		pricesOn: async ({ date }: { date: string }) =>
			date === DAY
				? [
						...priceDay,
						{ ...notePrice, cusip: "91282CSHT", maturity_date: "2026-11-15" },
					]
				: [],
	});

	test("by default, nothing inside a year is ranked, and the floor is stated", async () => {
		const { body } = await get(`/v1/rich-cheap?date=${DAY}`, shortDay());
		expect(body.min_years).toBe(1);
		expect(body.securities.map((s: { cusip: string }) => s.cusip)).not.toContain(
			"91282CSHT",
		);
	});

	test("min_years=0 asks for them", async () => {
		const { body } = await get(
			`/v1/rich-cheap?date=${DAY}&min_years=0`,
			shortDay(),
		);
		expect(body.min_years).toBe(0);
		expect(body.securities[0].cusip).toBe("91282CSHT");
	});
});

describe("the reader's TIPS basis (not yet published: upstream scores no TIPS)", () => {
	test("reads linkers from their own table", async () => {
		const day = await readRichCheap(
			{ TREASURY: treasury() },
			{ basis: "tips", date: DAY },
		);
		expect(day?.rows).toHaveLength(1);
		expect(day?.rows[0].family).toBe("tips");
		expect(day?.rows[0].yieldPercent).toBeCloseTo(
			tipsAnalytics[0].real_yield,
			10,
		);
	});
});

describe("dates, and absence", () => {
	test("no date: the latest price date", async () => {
		const { body } = await get("/v1/rich-cheap");
		expect(body.date).toBe(DAY);
	});

	test("no date, and the latest price day not yet analysed: steps back", async () => {
		const { status, body } = await get("/v1/rich-cheap", {
			latestPriceDate: async () => "2026-09-28",
		});
		expect(status).toBe(200);
		expect(body.date).toBe(DAY);
	});

	test("an explicit date with nothing is a 404, never an empty 200", async () => {
		const { status, body } = await get("/v1/rich-cheap?date=2026-09-26");
		expect(status).toBe(404);
		expect(body.error).toBe("no_data");
	});

	test("a deployment without analyticsOn is a 503 that says so", async () => {
		const { status, body } = await get(`/v1/rich-cheap?date=${DAY}`, {
			analyticsOn: undefined,
		});
		expect(status).toBe(503);
		expect(body.message).toContain("fault on our side");
	});
});

describe("MCP: get_treasury_rich_cheap, the same reader", () => {
	const callTool = async (args: Record<string, unknown>) => {
		const { call, key } = await setup({ treasury: treasury() });
		const response = await call("/mcp", {
			method: "POST",
			headers: {
				...bearer(key),
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "get_treasury_rich_cheap", arguments: args },
			}),
		});
		const text = await response.text();
		const json = text.trimStart().startsWith("{")
			? text
			: (text
					.split("\n")
					.find((l) => l.startsWith("data:"))
					?.slice(5) ?? "null");
		return JSON.parse(JSON.parse(json).result.content[0].text);
	};

	test("ranks as REST does, and explains the signs", async () => {
		const payload = await callTool({ date: DAY });
		expect(payload.ok).toBe(true);
		expect(payload.securities[0].cusip).toBe("91282CAAA");
		expect(payload.unscored_count).toBe(1);
		expect(payload.how_to_read).toContain("POSITIVE = CHEAP");
	});

	test("a day with nothing is no_data, not an empty ranking", async () => {
		const payload = await callTool({ date: "2026-09-26" });
		expect(payload.ok).toBe(false);
		expect(payload.error).toBe("no_data");
	});
});
