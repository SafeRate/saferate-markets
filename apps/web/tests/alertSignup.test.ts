import { beforeEach, describe, expect, test } from "bun:test";
import { confirmAlertSignup } from "@markets/persistence";
import { sqliteD1 } from "../../../packages/persistence/tests/sqliteD1";
import {
	handleAlertSignup,
	hashToken,
} from "../app/services/alertSignup.server";

/**
 * POST /api/alerts/subscribe as saferate.com calls it: the status contract
 * agreed with treasury-integration, against the real migrations.
 */

const SECRET = "shared-secret";
let world: ReturnType<typeof sqliteD1>;
let sent: { to: string; text: string }[];
let turnstilePasses: boolean;

const env = (over: Record<string, unknown> = {}) =>
	({
		DB: world.db,
		MARKETS_ENV: "production",
		ALERTS_SUBSCRIBE_SECRET: SECRET,
		TURNSTILE_SECRET_KEY: "turnstile-secret",
		EMAIL: {
			send: async (m: { to: string; text: string }) => {
				sent.push(m);
			},
		},
		...over,
	}) as never;

const fetcher = (async () =>
	Response.json({ success: turnstilePasses })) as unknown as typeof fetch;

const post = (
	body: unknown,
	headers: Record<string, string> = {},
	envOver: Record<string, unknown> = {},
) =>
	handleAlertSignup(
		env(envOver),
		new Request("https://saferate.markets/api/alerts/subscribe", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${SECRET}`,
				"Content-Type": "application/json",
				"X-Subscriber-IP": "203.0.113.7",
				...headers,
			},
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
		fetcher,
	);

const valid = {
	email: "Reader@Example.com",
	daily: true,
	auctions: true,
	ref: "saferate.com/treasury/auctions",
	turnstile: "token",
};

beforeEach(() => {
	world = sqliteD1();
	sent = [];
	turnstilePasses = true;
});

describe("the sign-up endpoint", () => {
	test("accepts, records the choices and mails one confirmation", async () => {
		const result = await post(valid);
		expect(result).toEqual({
			status: 202,
			body: { status: "confirmation_sent" },
		});
		expect(sent.map((m) => m.to)).toEqual(["reader@example.com"]);
		const token = sent[0].text.match(/alerts\/confirm\?t=([\w-]+)/)?.[1] ?? "";
		const signup = await confirmAlertSignup({
			db: world.db,
			idAlertSignup: await hashToken(token),
		});
		expect(signup).toEqual({
			email: "reader@example.com",
			rundown: true,
			auctions: true,
			source: "saferate.com/treasury/auctions",
		});
		// A second click works the same; an unknown link does not.
		expect(
			await confirmAlertSignup({
				db: world.db,
				idAlertSignup: await hashToken(token),
			}),
		).toEqual(signup);
		expect(
			await confirmAlertSignup({
				db: world.db,
				idAlertSignup: await hashToken("not-a-token"),
			}),
		).toBeNull();
	});

	test("a wrong or missing secret is 401, and so is none configured", async () => {
		expect((await post(valid, { Authorization: "Bearer nope" })).status).toBe(
			401,
		);
		expect(
			(await post(valid, {}, { ALERTS_SUBSCRIBE_SECRET: undefined })).status,
		).toBe(401);
		expect(sent).toEqual([]);
	});

	test("a bad address is invalid_email, bad JSON invalid_request", async () => {
		expect((await post({ ...valid, email: "not-an-address" })).body.status).toBe(
			"invalid_email",
		);
		expect((await post("{")).body.status).toBe("invalid_request");
		expect(
			(await post({ ...valid, daily: false, auctions: false })).body.status,
		).toBe("invalid_request");
	});

	test("a failed or missing Turnstile token is invalid_turnstile", async () => {
		turnstilePasses = false;
		expect((await post(valid)).body.status).toBe("invalid_turnstile");
		turnstilePasses = true;
		const { turnstile: _, ...without } = valid;
		expect((await post(without)).body.status).toBe("invalid_turnstile");
		expect(sent).toEqual([]);
	});

	test("no Turnstile key configured fails closed", async () => {
		const result = await post(valid, {}, { TURNSTILE_SECRET_KEY: undefined });
		expect(result.status).toBe(503);
		expect(sent).toEqual([]);
	});

	test("production refuses Turnstile's always-pass test secret", async () => {
		const testKey = {
			TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
		};
		expect((await post(valid, {}, testKey)).status).toBe(503);
		expect(
			(await post(valid, {}, { ...testKey, MARKETS_ENV: "staging" })).status,
		).toBe(202);
	});

	test("a repeat for the same address within a day is 202 and sends nothing", async () => {
		await post(valid);
		const again = await post(valid, { "X-Subscriber-IP": "198.51.100.1" });
		expect(again.body.status).toBe("confirmation_sent");
		expect(sent).toHaveLength(1);
	});

	test("five sign-ups an hour from one visitor, then 429", async () => {
		for (let i = 0; i < 5; i++)
			expect((await post({ ...valid, email: `r${i}@example.com` })).status).toBe(
				202,
			);
		const sixth = await post({ ...valid, email: "r5@example.com" });
		expect(sixth).toEqual({
			status: 429,
			body: { status: "rate_limited", retry_after_seconds: 3600 },
		});
		expect(sent).toHaveLength(5);
	});

	test("a send that fails is 503, never confirmation_sent", async () => {
		const result = await post(
			valid,
			{},
			{
				EMAIL: {
					send: async () => {
						throw new Error("quota");
					},
				},
			},
		);
		expect(result).toEqual({ status: 503, body: { status: "unavailable" } });
		// The retry is a real attempt, not a silent repeat.
		expect((await post(valid)).body.status).toBe("confirmation_sent");
		expect(sent).toHaveLength(1);
	});
});
