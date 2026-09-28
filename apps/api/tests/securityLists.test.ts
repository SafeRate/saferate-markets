import { describe, expect, test } from "bun:test";
import billPrices from "./fixtures/securities/bill-prices.json";
import frnPrices from "./fixtures/securities/frn-prices.json";
import notePrices from "./fixtures/securities/nominal-prices.json";
import runStatus from "./fixtures/securities/run-status-2026-09-25.json";
import tipsPrices from "./fixtures/securities/tips-prices.json";
import { bearer, setup } from "./helpers";

/**
 * /v1/securities and /v1/on-the-run on PRODUCTION rows for 2026-09-25: the
 * price rows of the four CUSIP fixtures (a note, a TIPS, an FRN and a bill),
 * and the day's full run record (154 rows, 14 queues, read through
 * list_treasury_securities on api.saferate.markets 2026-09-28 and mapped back
 * to upstream's columns).
 */

const DAY = "2026-09-25";
const onDay = <T extends { date: string }>(rows: T[]) =>
	rows.filter((r) => r.date === DAY);
const priceDay = [
	...onDay(notePrices),
	...onDay(tipsPrices),
	...onDay(frnPrices),
	...onDay(billPrices),
];

const treasury = (overrides: Record<string, unknown> = {}) => ({
	latestPriceDate: async () => DAY,
	pricesOn: async ({ date }: { date: string }) => (date === DAY ? priceDay : []),
	runStatusOn: async ({ date, basis }: { date: string; basis: string }) =>
		date === DAY ? runStatus.map((row) => ({ ...row, basis })) : [],
	...overrides,
});

const get = async (path: string, overrides?: Record<string, unknown>) => {
	const { call, key } = await setup({ treasury: treasury(overrides) });
	const response = await call(path, { headers: bearer(key) });
	return { status: response.status, body: await response.json() };
};

describe("/v1/securities", () => {
	test("every priced security, shortest maturity first, with its family", async () => {
		const { status, body } = await get("/v1/securities");
		expect(status).toBe(200);
		expect(body.date).toBe(DAY);
		expect(body.count).toBe(4);
		const maturities = body.securities.map(
			(s: { maturity_date: string }) => s.maturity_date,
		);
		expect(maturities).toEqual([...maturities].sort());
		expect(
			new Set(body.securities.map((s: { family: string }) => s.family)),
		).toEqual(new Set(["bill", "note", "tips", "frn"]));
	});

	test("family filters, and the count follows the filter", async () => {
		const { body } = await get("/v1/securities?family=tips");
		expect(body.count).toBe(1);
		expect(body.securities[0].cusip).toBe("91282CNS6");
	});

	test("a day with nothing priced is a 404", async () => {
		const { status } = await get("/v1/securities?date=2026-09-27");
		expect(status).toBe(404);
	});

	test("does not collide with the CUSIP route", async () => {
		const { status, body } = await get("/v1/securities");
		expect(status).toBe(200);
		expect(body).not.toHaveProperty("terms");
	});
});

describe("/v1/on-the-run", () => {
	test("fourteen queues, kind then term, each led by rank 0", async () => {
		const { status, body } = await get("/v1/on-the-run");
		expect(status).toBe(200);
		expect(body.basis).toBe("issue");
		expect(body.queues).toHaveLength(14);
		expect(body.queues.map((q: { kind: string }) => q.kind).slice(0, 4)).toEqual([
			"Bill",
			"Bill",
			"Bill",
			"Note",
		]);
		const notes = body.queues
			.filter((q: { kind: string }) => q.kind === "Note")
			.map((q: { original_security_term: string }) => q.original_security_term);
		expect(notes).toEqual(["2-Year", "3-Year", "5-Year", "7-Year", "10-Year"]);
		for (const queue of body.queues) {
			const ranks = queue.members.map((m: { run_rank: number }) => m.run_rank);
			expect(ranks[0]).toBe(0);
			expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
		}
	});

	test("members carry terms where priced, and null (not a guess) where not", async () => {
		const { body } = await get("/v1/on-the-run");
		const members = body.queues.flatMap(
			(q: { members: unknown[] }) => q.members,
		) as { cusip: string; maturity_date: string | null }[];
		const note = members.find((m) => m.cusip === "91282CMM0");
		expect(note?.maturity_date).toBe("2035-02-15");
		expect(members.some((m) => m.maturity_date === null)).toBe(true);
	});

	test("basis=auction is passed through", async () => {
		const { body } = await get("/v1/on-the-run?basis=auction");
		expect(body.basis).toBe("auction");
	});

	test("no date, and the newest price day has no run record yet: steps back", async () => {
		const { body } = await get("/v1/on-the-run", {
			latestPriceDate: async () => "2026-09-28",
		});
		expect(body.date).toBe(DAY);
	});

	test("an explicit day with no record is a 404", async () => {
		const { status } = await get("/v1/on-the-run?date=2026-09-27");
		expect(status).toBe(404);
	});
});
