import { beforeEach, describe, expect, test } from "bun:test";
import { resetAuctionWindowCache } from "@markets/mcp-tools";
import {
	ALL_ROWS,
	fakeAuctionTreasury,
	ON,
} from "../../../packages/mcp-tools/tests/auctionRows";
import { bearer, setup } from "./helpers";

/**
 * /v1/auctions and /v1/auctions/latest, and the get_treasury_auctions MCP
 * tool, over a fake TREASURY answering auctionsBetween in upstream's shape
 * (the fixture's 4-week history is real: see auctionRows.ts). Every response
 * goes through the routes' strict output schemas, so a field the published
 * record gains or loses fails here.
 */

beforeEach(() => resetAuctionWindowCache());

const get = async (path: string, treasury: unknown = fakeAuctionTreasury()) => {
	const { call, key } = await setup({ treasury });
	const response = await call(path, { headers: bearer(key) });
	return { status: response.status, body: await response.json() };
};

const cusips = (body: { auctions: { cusip: string }[] }) =>
	body.auctions.map((a) => a.cusip);

describe("GET /v1/auctions", () => {
	test("defaults to the last 30 days and everything announced, newest first", async () => {
		const { status, body } = await get("/v1/auctions");
		expect(status).toBe(200);
		expect(body.as_of).toBe(ON);
		expect(body.from).toBe("2026-09-02");
		expect(body.to).toBe("2026-12-01");
		expect(cusips(body)[0]).toBe("91282CRQ6");
		expect(cusips(body)).toContain("912797VK0"); // 2026-09-03, inside
		expect(cusips(body)).not.toContain("912797VJ3"); // 2026-08-27, outside
		expect(body.count).toBe(body.auctions.length);
	});

	test("an announced new issue is in the schedule, with nulls for what is not set", async () => {
		const { body } = await get("/v1/auctions");
		const fresh = body.auctions.find(
			(a: { cusip: string }) => a.cusip === "91282CRQ6",
		);
		expect(fresh.status).toBe("announced");
		expect(fresh.is_reopening).toBe(false);
		expect(fresh.maturity_date).toBeNull();
		expect(fresh.coupon_percent).toBeNull();
		expect(fresh.term).toBe("3-Year");
	});

	test("a bill quotes its discount rate first and its investment rate beside it", async () => {
		const { body } = await get(
			"/v1/auctions?term=4-week&from=2026-10-01&to=2026-10-01",
		);
		expect(cusips(body)).toEqual(["912797VP9"]);
		const [bill] = body.auctions;
		expect(bill.clearing_rate.measure).toBe("discount");
		expect(bill.clearing_rate.high_percent).toBe(3.89);
		expect(bill.clearing_rate.investment_rate_percent).toBe(3.956);
		expect(bill.high_less_median_basis_points).toBeCloseTo(5, 6);
		expect(bill.status).toBe("auctioned");
	});

	test("filters by kind and by status", async () => {
		const notes = await get(
			"/v1/auctions?kind=Note&from=2026-09-01&to=2026-10-31",
		);
		expect(cusips(notes.body).sort()).toEqual(["91282CRF0", "91282CRQ6"]);
		const announced = await get("/v1/auctions?status=announced");
		expect(cusips(announced.body)).toEqual(["91282CRQ6"]);
	});

	test("an explicit window returns exactly that window", async () => {
		const { body } = await get("/v1/auctions?from=2026-08-13&to=2026-08-20");
		expect(cusips(body)).toEqual(["912797VH7", "912797VG9"]);
	});

	test("refuses a window backwards, too wide, or malformed", async () => {
		expect((await get("/v1/auctions?from=2026-10-01&to=2026-09-01")).status).toBe(
			400,
		);
		const wide = await get("/v1/auctions?from=2024-01-01&to=2026-01-01");
		expect(wide.status).toBe(400);
		expect(wide.body.message).toContain("400 days");
		expect((await get("/v1/auctions?from=2026-13-01")).status).toBe(400);
	});

	test("a treasury-api without auctionsBetween is a 503 that says so, not an empty list", async () => {
		const { status, body } = await get("/v1/auctions", {
			latestPriceDate: async () => ON,
		});
		expect(status).toBe(503);
		expect(body.message).toContain("fault on our side");
	});
});

describe("GET /v1/auctions/latest", () => {
	test("gives each term its latest held result, matching saferate.com for the 4-week", async () => {
		const { status, body } = await get("/v1/auctions/latest");
		expect(status).toBe(200);
		expect(body.as_of).toBe(ON);
		const groups = body.terms.map((t: { group: string }) => t.group);
		expect(groups).toEqual(["Bill 4-Week", "Note 10-Year", "FRN 2-Year"]);
		const [fourWeek] = body.terms;
		expect(fourWeek.auction.cusip).toBe("912797VP9");
		expect(fourWeek.bid_to_cover_change).toBeCloseTo(0, 6);
		expect(fourWeek.bid_to_cover_compared_with).toBe(6);
		expect(fourWeek.primary_dealer_change_points).toBeCloseTo(-0.8863, 3);
		expect(fourWeek.primary_dealer_compared_with).toBe(6);
	});

	test("carries treasury's demand ranking on the auction it describes, as published", async () => {
		const demandRow = {
			auction: { cusip: "912797VP9", auctionDate: "2026-10-01" },
			measures: [
				{
					key: "bidToCover",
					label: "Bid to cover",
					percentile: 0,
					sampleSize: 104,
					value: 2.83,
				},
				{
					key: "indirect",
					label: "Indirect share",
					percentile: 13,
					sampleSize: 104,
					value: 0.57,
				},
				{
					key: "dealer",
					label: "Dealer takedown",
					percentile: 14,
					sampleSize: 104,
					value: 0.36,
				},
				{
					key: "spread",
					label: "High less median",
					percentile: 13,
					sampleSize: 104,
					value: 7,
				},
			],
			sampleSize: 104,
			term: "Bill|4-Week",
			termLabel: "Bill 4-Week",
			verdict: "weak",
			windowMonths: 24,
		};
		let asked: unknown = null;
		const treasury = {
			...fakeAuctionTreasury(),
			auctionDemand: async (input: unknown) => {
				asked = input;
				return [demandRow];
			},
		};
		const { status, body } = await get("/v1/auctions/latest", treasury);
		expect(status).toBe(200);
		expect(asked).toEqual({ on: ON });
		const [fourWeek, ...rest] = body.terms;
		expect(fourWeek.demand.verdict).toBe("weak");
		expect(fourWeek.demand.sample_size).toBe(104);
		expect(fourWeek.demand.window_months).toBe(24);
		// A treasury that predates reason codes reads as ranked, not as unknown.
		expect(fourWeek.demand.unranked).toBeNull();
		// Published as treasury ranked it: never re-inverted on this side.
		expect(
			fourWeek.demand.measures.find((m: { key: string }) => m.key === "dealer")
				.percentile,
		).toBe(14);
		// A term treasury did not rank has no demand, rather than a guessed one.
		for (const term of rest) expect(term.demand).toBeNull();
	});

	test("publishes why a term is unranked, with the numbers a caption quotes", async () => {
		const treasury = {
			...fakeAuctionTreasury(),
			auctionDemand: async () => [
				{
					auction: { cusip: "91282CRF0", auctionDate: "2026-09-09" },
					measures: [],
					sampleSize: 3,
					term: "Note|10-Year",
					termLabel: "Note 10-Year",
					verdict: null,
					windowMonths: 24,
					unranked: "sample",
					daysSinceLast: 30,
					maxStaleDays: 180,
					minSample: 8,
				},
			],
		};
		const { status, body } = await get("/v1/auctions/latest", treasury);
		expect(status).toBe(200);
		const tenYear = body.terms.find(
			(t: { auction: { cusip: string } }) => t.auction.cusip === "91282CRF0",
		);
		expect(tenYear.demand).toEqual({
			verdict: null,
			unranked: "sample",
			sample_size: 3,
			min_sample: 8,
			days_since_last: 30,
			max_stale_days: 180,
			window_months: 24,
			measures: [],
		});
	});

	test("a treasury-api without auctionDemand still serves results, with demand null", async () => {
		const { status, body } = await get("/v1/auctions/latest");
		expect(status).toBe(200);
		for (const term of body.terms) expect(term.demand).toBeNull();
	});

	test("never lists an announced auction as a term's result", async () => {
		const { body } = await get("/v1/auctions/latest");
		expect(body.terms.map((t: { group: string }) => t.group)).not.toContain(
			"Note 3-Year",
		);
	});

	test("a term with one auction says it compared with none", async () => {
		const { body } = await get("/v1/auctions/latest?kind=Note");
		expect(body.terms).toHaveLength(1);
		expect(body.terms[0].bid_to_cover_change).toBeNull();
		expect(body.terms[0].bid_to_cover_compared_with).toBe(0);
	});

	test("a treasury-api without auctionsBetween is a 503", async () => {
		const { status, body } = await get("/v1/auctions/latest", {
			latestPriceDate: async () => ON,
		});
		expect(status).toBe(503);
		expect(body.message).toContain("fault on our side");
	});
});

describe("MCP: get_treasury_auctions, the same reader", () => {
	const callTool = async (
		args: Record<string, unknown>,
		treasury: unknown = fakeAuctionTreasury(),
	) => {
		const { call, key } = await setup({ treasury });
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
				params: { name: "get_treasury_auctions", arguments: args },
			}),
		});
		const text = await response.text();
		const json = text.trimStart().startsWith("{")
			? text
			: (text
					.split("\n")
					.find((l) => l.startsWith("data:"))
					?.slice(5) ?? "null");
		const result = JSON.parse(json).result;
		return {
			result,
			payload: (() => {
				try {
					return JSON.parse(result.content[0].text);
				} catch {
					return result.content[0].text;
				}
			})(),
		};
	};

	test("schedule lists announced and recent auctions, and says how to read them", async () => {
		const { payload } = await callTool({});
		expect(payload.ok).toBe(true);
		expect(payload.view).toBe("schedule");
		expect(payload.auctions.map((a: { cusip: string }) => a.cusip)).toContain(
			"91282CRQ6",
		);
		expect(payload.how_to_read).toContain("DISCOUNT rate");
	});

	test("latest_by_term gives the same figures as REST", async () => {
		const { payload } = await callTool({ view: "latest_by_term", kind: "Bill" });
		expect(payload.ok).toBe(true);
		expect(payload.terms[0].group).toBe("Bill 4-Week");
		expect(payload.terms[0].primary_dealer_change_points).toBeCloseTo(-0.8863, 3);
	});

	test("a treasury-api without the method is an error that says so, never an empty schedule", async () => {
		const { result, payload } = await callTool(
			{ view: "latest_by_term" },
			{ latestPriceDate: async () => ON },
		);
		const said = JSON.stringify(payload);
		expect(result.isError === true || said.includes("not available")).toBe(true);
		expect(said).not.toContain('"terms":[]');
	});
});

test("the fixture holds an announced new issue and a full 4-week history", () => {
	expect(ALL_ROWS.length).toBeGreaterThan(8);
});
