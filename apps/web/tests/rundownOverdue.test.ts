import { beforeEach, describe, expect, test } from "bun:test";
import { putAlertPreferences } from "@markets/persistence";
import { sqliteD1 } from "../../../packages/persistence/tests/sqliteD1";
import {
	C_RUNDOWN_OVERDUE_PATH,
	findOverdueRundown,
} from "../app/services/alerts.server";

/**
 * A missed rundown, through the real migrations. Tuesday 2026-10-20 is a
 * business day; Monday 2026-10-12 is Columbus Day; Saturday 2026-10-17 is a
 * weekend. The cut-off is 18:00 UTC.
 */

const AT = (iso: string) => new Date(iso);
let world: ReturnType<typeof sqliteD1>;
let subscriber: string;

beforeEach(async () => {
	world = sqliteD1();
	subscriber = world.addUser("reader@example.com");
	await putAlertPreferences({
		db: world.db,
		idUser: subscriber,
		preferences: {
			auctionAnnouncements: false,
			auctionResults: false,
			paused: false,
			rundown: true,
			terms: null,
		},
	});
});

const sendRundown = (at: number) =>
	world.db
		.prepare(
			"insert into alertSends (kind, eventKey, idUser, status, createdAt, updatedAt) values ('rundown', '2026-10-19', ?, 'sent', ?, ?)",
		)
		.bind(subscriber, at, at)
		.run();

describe("findOverdueRundown", () => {
	test("a business day past the cut-off with nothing sent is overdue", async () => {
		const overdue = await findOverdueRundown({
			db: world.db,
			now: AT("2026-10-20T18:05:00Z"),
		});
		expect(overdue).toContain("2026-10-20");
		expect(overdue).toContain("1 subscriber");
	});

	test("before the cut-off, nothing is due yet", async () => {
		expect(
			await findOverdueRundown({ db: world.db, now: AT("2026-10-20T17:55:00Z") }),
		).toBeNull();
	});

	test("a rundown sent today clears it", async () => {
		await sendRundown(Date.parse("2026-10-20T12:30:00Z"));
		expect(
			await findOverdueRundown({ db: world.db, now: AT("2026-10-20T19:00:00Z") }),
		).toBeNull();
	});

	test("yesterday's send does not count for today", async () => {
		await sendRundown(Date.parse("2026-10-19T12:30:00Z"));
		expect(
			await findOverdueRundown({ db: world.db, now: AT("2026-10-20T19:00:00Z") }),
		).not.toBeNull();
	});

	test("weekends and federal holidays expect no edition", async () => {
		expect(
			await findOverdueRundown({ db: world.db, now: AT("2026-10-17T20:00:00Z") }),
		).toBeNull();
		expect(
			await findOverdueRundown({ db: world.db, now: AT("2026-10-12T20:00:00Z") }),
		).toBeNull();
	});

	test("one row a day: an existing row for today silences it", async () => {
		const at = Date.parse("2026-10-20T18:05:00Z");
		await world.db
			.prepare(
				"insert into siteErrors (idSiteError, code, path, message, createdAt) values ('x', 'web-cron', ?, 'overdue', ?)",
			)
			.bind(C_RUNDOWN_OVERDUE_PATH, at)
			.run();
		expect(
			await findOverdueRundown({ db: world.db, now: AT("2026-10-20T18:10:00Z") }),
		).toBeNull();
	});

	test("no subscribers, no missed rundown", async () => {
		await putAlertPreferences({
			db: world.db,
			idUser: subscriber,
			preferences: {
				auctionAnnouncements: false,
				auctionResults: false,
				paused: false,
				rundown: false,
				terms: null,
			},
		});
		expect(
			await findOverdueRundown({ db: world.db, now: AT("2026-10-20T19:00:00Z") }),
		).toBeNull();
	});
});
