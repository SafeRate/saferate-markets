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
		zero_rate: 4,
	}));

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
			parYieldSeries: async ({ from, to }: { from: string; to: string }) =>
				curveDates
					.filter((d) => d >= from && d <= to)
					.flatMap((d) => parRows(d, d === "2026-10-02" ? 5.2 : 5.25)),
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
	curveDates = ["2026-09-30", "2026-10-01"];
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
		expect(rundowns[0].text).toContain("/daily-rundown/treasury/2026-10-02");
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
