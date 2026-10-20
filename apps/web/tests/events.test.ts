import { beforeEach, describe, expect, test } from "bun:test";
import {
	linkVisitorToUser,
	normalizeEventPath,
	recordEvent,
	recordVisitor,
} from "@markets/persistence";
import { sqliteD1 } from "../../../packages/persistence/tests/sqliteD1";
import {
	serializeVisitorCookie,
	touchFrom,
	trackEvent,
	visitorIdFrom,
} from "../app/lib/visitor.server";

/**
 * The first-party journey (migration 0011), through the real migrations. The rules
 * worth pinning are the privacy ones: they are promises /privacy makes.
 */

const VID = "0f8e2c1a-1234-4abc-9def-0123456789ab";
let world: ReturnType<typeof sqliteD1>;
beforeEach(() => {
	world = sqliteD1();
});

const rows = async (sql: string) =>
	((await world.db.prepare(sql).all()).results ?? []) as Record<
		string,
		unknown
	>[];

const request = (
	headers: Record<string, string> = {},
	url = "https://saferate.markets/pricing",
) => new Request(url, { headers });

const context = () => ({
	cloudflare: {
		ctx: { waitUntil: () => {} } as unknown as ExecutionContext,
		env: { DB: world.db } as unknown as Env,
	},
});

describe("normalizeEventPath", () => {
	test("a security page never records which security", () => {
		expect(normalizeEventPath("/dashboard/securities/91282CRZ9")).toBe(
			"/dashboard/securities/:cusip",
		);
	});
	test("ids collapse and query strings go", () => {
		expect(
			normalizeEventPath(`/dashboard/portfolios/${VID}/transactions?x=1`),
		).toBe("/dashboard/portfolios/:id/transactions");
	});
});

describe("recordEvent", () => {
	test("writes a catalogued event with its props", async () => {
		await recordEvent({
			db: world.db,
			idUser: "u1",
			name: "transactions_imported",
			path: "/dashboard/portfolios/x?file=secret",
			props: { rows: 42 },
			source: "web",
		});
		const [row] = await rows(
			"select name, idUser, path, propsJson, source from events",
		);
		expect(row).toEqual({
			idUser: "u1",
			name: "transactions_imported",
			path: "/dashboard/portfolios/x",
			propsJson: '{"rows":42}',
			source: "web",
		});
	});

	test("props that do not match the catalog are dropped, not stored", async () => {
		const original = console.error;
		console.error = () => {};
		try {
			await recordEvent({
				db: world.db,
				name: "transactions_imported",
				props: { rows: "lots" } as never,
				source: "web",
			});
		} finally {
			console.error = original;
		}
		expect(await rows("select * from events")).toHaveLength(0);
	});
});

describe("visitors", () => {
	const touch = {
		clickIdKind: null,
		country: "US",
		landingPath: "/dashboard/securities/91282CRZ9",
		referrerHost: "www.google.com",
		utmCampaign: null,
		utmContent: null,
		utmMedium: "organic",
		utmSource: "google",
		utmTerm: null,
	};

	test("the first touch is kept, and the landing path is a pattern", async () => {
		await recordVisitor({ db: world.db, idVisitor: VID, touch });
		await recordVisitor({
			db: world.db,
			idVisitor: VID,
			touch: { ...touch, utmSource: "later" },
		});
		const [row] = await rows(
			"select landingPath, utmSource, referrerHost from visitors",
		);
		expect(row).toEqual({
			landingPath: "/dashboard/securities/:cusip",
			referrerHost: "www.google.com",
			utmSource: "google",
		});
	});

	test("a visitor links to its first user only", async () => {
		await recordVisitor({ db: world.db, idVisitor: VID, touch });
		await linkVisitorToUser({ db: world.db, idUser: "first", idVisitor: VID });
		await linkVisitorToUser({ db: world.db, idUser: "second", idVisitor: VID });
		const [row] = await rows("select idUser from visitors");
		expect(row?.idUser).toBe("first");
	});
});

describe("the privacy gates", () => {
	const withVid = { Cookie: `markets_vid=${VID}` };

	test("the visitor id is read only when analytics is permitted", () => {
		expect(visitorIdFrom(request(withVid))).toBe(VID);
		expect(visitorIdFrom(request({ ...withVid, "Sec-GPC": "1" }))).toBeNull();
		expect(
			visitorIdFrom(
				request({ Cookie: `markets_vid=${VID}; markets_analytics=off` }),
			),
		).toBeNull();
		expect(
			visitorIdFrom(request({ Cookie: "markets_vid=not-a-uuid" })),
		).toBeNull();
	});

	test("a behavioural event is dropped under GPC; a milestone is kept without the visitor", async () => {
		const gpc = request({ ...withVid, "Sec-GPC": "1" });
		await trackEvent({
			context: context(),
			name: "plan_built",
			props: { method: "m", status: "planned" },
			request: gpc,
		});
		await trackEvent({
			context: context(),
			name: "api_key_created",
			props: {},
			request: gpc,
			who: { idUser: "u" },
		});
		expect(await rows("select name, idVisitor, idUser from events")).toEqual([
			{ idUser: "u", idVisitor: null, name: "api_key_created" },
		]);
	});

	test("nothing is recorded while support impersonates a customer", async () => {
		await trackEvent({
			context: context(),
			name: "api_key_created",
			props: {},
			request: request(withVid),
			who: { idUser: "u", impersonatedBy: "admin" },
		});
		expect(await rows("select * from events")).toHaveLength(0);
	});

	test("the touch keeps the referrer's host only, and only from another site", () => {
		const external = touchFrom(
			request(
				{ Referer: "https://www.google.com/search?q=treasury+api" },
				"https://saferate.markets/?utm_source=news&gclid=abc",
			),
		);
		expect(external.referrerHost).toBe("www.google.com");
		expect(external.utmSource).toBe("news");
		expect(external.clickIdKind).toBe("gclid");
		const internal = touchFrom(
			request({ Referer: "https://saferate.markets/pricing" }),
		);
		expect(internal.referrerHost).toBeNull();
	});

	test("the cookie is httpOnly, two years, Secure over https", () => {
		const cookie = serializeVisitorCookie({ idVisitor: VID, isSecure: true });
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain(`Max-Age=${60 * 60 * 24 * 365 * 2}`);
		expect(cookie).toContain("Secure");
	});
});
