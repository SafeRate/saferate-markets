import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteD1 } from "../../../packages/persistence/tests/sqliteD1";
import { action } from "../app/routes/alerts.confirm";
import { hashToken } from "../app/services/alertSignup.server";
import { getAuth } from "../app/services/auth.server";

/**
 * Confirming an alert sign-up signs the person in with a magic-link token the
 * route mints itself, so it must match what Better Auth's own verify reads.
 * Better Auth 1.7.7 changed that (identifier `magic-link:<token>`, value typed
 * `magic-link`), and a token in the old shape redirected to INVALID_TOKEN with
 * no session. Runs the real migrations, route and Better Auth verify.
 */

const ORIGIN = "http://localhost:3020";
let world: ReturnType<typeof sqliteD1>;

const env = () =>
	({
		BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-better-auth",
		DB: world.db,
		MARKETS_ENV: "development",
	}) as never;

const signUp = async (email: string) => {
	const token = crypto.randomUUID();
	const now = Date.now();
	world.sqlite
		.query(
			"insert into alertSignups (idAlertSignup, email, rundown, auctions, source, ipAddress, createdAt, expiresAt) values (?, ?, 1, 0, 'test', null, ?, ?)",
		)
		.run(await hashToken(token), email, now, now + 60_000);
	return token;
};

const confirm = async (token: string) =>
	(await action({
		context: { cloudflare: { env: env() } },
		params: {},
		request: new Request(`${ORIGIN}/alerts/confirm?t=${token}`, {
			method: "POST",
		}),
	} as never)) as Response;

beforeEach(() => {
	world = sqliteD1();
});

describe("confirming an alert sign-up", () => {
	test("the minted token signs the person in and lands on /alerts/confirmed", async () => {
		const confirmed = await confirm(await signUp("alerts@example.com"));
		const verifyUrl = confirmed.headers.get("location") ?? "";
		expect(verifyUrl).toStartWith("/api/auth/magic-link/verify?");

		const verified = await getAuth({ env: env() }).handler(
			new Request(`${ORIGIN}${verifyUrl}`),
		);
		expect(verified.status).toBe(302);
		const landed = new URL(verified.headers.get("location") ?? "", ORIGIN);
		expect(landed.pathname).toBe("/alerts/confirmed");
		expect(landed.searchParams.get("error")).toBeNull();
		expect(verified.headers.get("set-cookie") ?? "").toContain("session_token=");
	});

	test("the token works once", async () => {
		const confirmed = await confirm(await signUp("twice@example.com"));
		const url = `${ORIGIN}${confirmed.headers.get("location") ?? ""}`;
		const auth = getAuth({ env: env() });
		await auth.handler(new Request(url));
		const again = await auth.handler(new Request(url));
		expect(again.headers.get("set-cookie") ?? "").not.toContain("session_token=");
	});
});
