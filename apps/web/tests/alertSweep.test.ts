import { beforeEach, describe, expect, test } from "bun:test";
import { putAlertPreferences } from "@markets/persistence";
import {
	ALL_ROWS,
	auctionRow,
	TEN_YEAR,
} from "../../../packages/mcp-tools/tests/auctionRows";
import { sqliteD1 } from "../../../packages/persistence/tests/sqliteD1";
import { sweepAlerts, verifyUnsubscribe } from "../app/services/alerts.server";

/**
 * The sweep end to end: treasury's payloads (auction rows as auctionsBetween
 * sends them, demand rows shaped like the producer's, par yields as
 * parYieldSeries sends them) through the real migrations to the messages the
 * mail binding is handed. The parts are tested elsewhere; this tests the join.
 */

const SECRET = "test-secret";
const T0 = Date.UTC(2026, 9, 2, 20, 0);
const MIN = 60_000;

/** A 10-year auctioned "today", with results. */
const NEW_TEN_YEAR = auctionRow({
	...TEN_YEAR,
	cusip: "91282CRZ9",
	auction_date: "2026-10-02",
	issue_date: "2026-10-15",
});

const parRows = (date: string, ten: number) =>
	[1, 2, 3, 5, 7, 10, 20, 30].map((tenor_years) => ({
		date,
		tenor_years,
		par_yield: tenor_years === 10 ? ten : 4 + tenor_years / 100,
		zero_rate: tenor_years === 10 ? 5.111 : 4,
	}));

/** realCurve's row, as treasury sends it: a 10-year real yield of 2.345%. */
const realRow = (date: string) => ({
	converged: 1,
	date,
	max_price_error_cents: 1,
	rate_02y: 1.9,
	rate_03y: 2,
	rate_05y: 2.1,
	rate_07y: 2.2,
	rate_10y: 2.345,
	rate_20y: 2.5,
	rate_30y: 2.6,
	rmse_basis_points: 2,
	tips_count: 46,
});

/** curvesOn's money market row: 3-month 4.20% today, 4.25% the day before. */
const moneyMarketRow = (date: string) => ({
	bill_count: 31,
	converged: 1,
	convention: "bond equivalent",
	date,
	implied_overnight: 4.3,
	max_residual_basis_points: 1,
	rate_01m: 4.3,
	rate_01w: 4.31,
	rate_02m: 4.28,
	rate_03m: date === "2026-10-02" ? 4.2 : 4.25,
	rate_04m: 4.18,
	rate_06m: 4.1,
	rate_09m: 4.0,
	rate_12m: 3.9,
	rmse_basis_points: 1,
});

let world: ReturnType<typeof sqliteD1>;
let rows: Record<string, unknown>[];
let curveDates: string[];
let sent: {
	to: string;
	subject: string;
	text: string;
	headers?: Record<string, string>;
}[];

const env = () =>
	({
		DB: world.db,
		MARKETS_ENV: "production",
		BETTER_AUTH_SECRET: SECRET,
		EMAIL: {
			send: async (m: (typeof sent)[number]) => {
				sent.push(m);
			},
		},
		TREASURY: {
			auctionsBetween: async ({ from, to }: { from: string; to: string }) =>
				rows.filter(
					(r) =>
						(r.auction_date as string) >= from && (r.auction_date as string) <= to,
				),
			// The producer's shape: the embedded auction is camelCase.
			auctionDemand: async () => [
				{
					auction: { cusip: "91282CRZ9", auctionDate: "2026-10-02" },
					measures: [],
					sampleSize: 24,
					term: "Note|10-Year",
					termLabel: "Note 10-Year",
					verdict: "strong",
					windowMonths: 24,
					unranked: null,
					daysSinceLast: 0,
					maxStaleDays: 180,
					minSample: 8,
				},
			],
			realCurve: async ({ date }: { date: string }) => realRow(date),
			curvesOn: async (date: string) => ({
				zero: [],
				moneyMarket: moneyMarketRow(date),
				nss: null,
				dieboldLi: null,
			}),
			parYieldSeries: async ({ from, to }: { from: string; to: string }) =>
				curveDates
					.filter((d) => d >= from && d <= to)
					.flatMap((d) =>
						parRows(
							d,
							d === "2026-10-02"
								? 5.2
								: d === "2026-09-25"
									? 5.1
									: d === "2026-09-02"
										? 4.9
										: 5.25,
						),
					),
		},
	}) as never;

const tick = (at: number) => sweepAlerts(env(), new Date(at));

let everyone: string;
let tenYearFan: string;
let resultsAll: string;
let unverified: string;

beforeEach(async () => {
	world = sqliteD1();
	rows = [...ALL_ROWS];
	// A month ago (09-02) and a week ago (09-25) are fitted closes too.
	curveDates = ["2026-09-02", "2026-09-25", "2026-09-30", "2026-10-01"];
	sent = [];
	everyone = world.addUser("everyone@example.com");
	tenYearFan = world.addUser("ten@example.com");
	resultsAll = world.addUser("all@example.com");
	unverified = world.addUser("unverified@example.com", false);
	await putAlertPreferences({
		db: world.db,
		idUser: tenYearFan,
		preferences: {
			rundown: false,
			auctionResults: true,
			auctionAnnouncements: false,
			terms: ["Note 10-Year"],
			paused: false,
		},
	});
	await putAlertPreferences({
		db: world.db,
		idUser: resultsAll,
		preferences: {
			rundown: true,
			auctionResults: true,
			auctionAnnouncements: false,
			terms: null,
			paused: false,
		},
	});
	void unverified;
});

const to = () => sent.map((m) => m.to).sort();

describe("the alert sweep", () => {
	test("the first sweep records what exists and sends none of it", async () => {
		await tick(T0);
		expect(sent).toEqual([]);
	});

	test("a new result goes once, to those who want its term", async () => {
		await tick(T0);
		rows.push(NEW_TEN_YEAR);
		await tick(T0 + 5 * MIN);
		const results = sent.filter((m) => m.subject.includes("auction:"));
		expect(results.map((m) => m.to).sort()).toEqual([
			"all@example.com",
			"ten@example.com",
		]);
		// Demand joined from the producer's row onto the right auction.
		expect(results[0].subject).toContain("demand strong");
		sent = [];
		await tick(T0 + 10 * MIN);
		expect(sent).toEqual([]);
	});

	test("a term filter keeps other terms out", async () => {
		await tick(T0);
		rows.push(
			auctionRow({
				cusip: "912797ZZ1",
				auction_date: "2026-10-02",
				bid_to_cover_ratio: 2.9,
			}),
		);
		await tick(T0 + 5 * MIN);
		expect(to()).toEqual(["all@example.com"]);
	});

	test("the rundown goes to every verified account that has not turned it off", async () => {
		await tick(T0);
		curveDates.push("2026-10-02");
		await tick(T0 + 5 * MIN);
		const rundowns = sent.filter((m) => m.subject.startsWith("Treasury rundown"));
		expect(rundowns.map((m) => m.to).sort()).toEqual([
			"all@example.com",
			"everyone@example.com",
		]);
		// Friday's close is Monday morning's rundown: dated, and linked, by the
		// morning it goes out, with its sections naming the close.
		expect(rundowns[0].subject).toMatch(/^Treasury rundown, Mon, Oct 5:/);
		expect(rundowns[0].text).toContain("/daily-rundown/treasury/2026-10-05");
		expect(rundowns[0].text).toContain("THE CURVE AT THE CLOSE, FRI, OCT 2");
		expect(rundowns[0].text).toContain("closed Friday at 5.20%");
		// Zero and real beside par at 10 years, and the money market with its
		// change against the previous fitted day.
		// Par; its change on the day, week (09-25, 5.10%) and month (09-02,
		// 4.90%); then zero and real.
		expect(rundowns[0].text).toMatch(
			/10y\s+5\.200%\s+−5 bp\s+\+10 bp\s+\+30 bp\s+5\.111%\s+2\.345%/,
		);
		expect(rundowns[0].text).toMatch(/3M\s+4\.200%\s+−5 bp\s+−5 bp\s+−5 bp/);
	});

	test("every alert carries a one-click unsubscribe that verifies", async () => {
		await tick(T0);
		curveDates.push("2026-10-02");
		await tick(T0 + 5 * MIN);
		const mail = sent.find((m) => m.to === "everyone@example.com");
		expect(mail?.headers?.["List-Unsubscribe-Post"]).toBe(
			"List-Unsubscribe=One-Click",
		);
		const link = new URL(
			(mail?.headers?.["List-Unsubscribe"] ?? "").slice(1, -1),
		);
		expect(link.pathname).toBe("/alerts/unsubscribe");
		expect(
			await verifyUnsubscribe(
				SECRET,
				link.searchParams.get("u") ?? "",
				"rundown",
				link.searchParams.get("t") ?? "",
			),
		).toBe(true);
		expect(link.searchParams.get("u")).toBe(everyone);
	});

	test("someone who subscribes later is not sent a stale event", async () => {
		await tick(T0);
		rows.push(NEW_TEN_YEAR);
		await tick(T0 + 5 * MIN);
		const late = world.addUser("late@example.com");
		await putAlertPreferences({
			db: world.db,
			idUser: late,
			preferences: {
				rundown: false,
				auctionResults: true,
				auctionAnnouncements: false,
				terms: null,
				paused: false,
			},
		});
		sent = [];
		await tick(T0 + 7 * 60 * MIN);
		expect(sent).toEqual([]);
	});

	test("a paused account gets nothing", async () => {
		await putAlertPreferences({
			db: world.db,
			idUser: resultsAll,
			preferences: {
				rundown: true,
				auctionResults: true,
				auctionAnnouncements: true,
				terms: null,
				paused: true,
			},
		});
		await tick(T0);
		rows.push(NEW_TEN_YEAR);
		curveDates.push("2026-10-02");
		await tick(T0 + 5 * MIN);
		expect(to()).not.toContain("all@example.com");
	});
});
