import { beforeAll, describe, expect, test } from "bun:test";
import { sqliteD1 } from "../../../packages/persistence/tests/sqliteD1";
import { requireOrganization } from "../app/lib/session.server";
import { action as keysAction } from "../app/routes/dashboard.keys";
import { action, loader } from "../app/routes/support";
import { getAuth, getServerSession } from "../app/services/auth.server";

/**
 * /support end to end, against the real migrations and the real Better Auth:
 * sign in by magic link, impersonate, act as the customer, stop. The parts
 * (the plugin, the route, the guard) only matter joined.
 */

const ORIGIN = "https://saferate.markets";
let world: ReturnType<typeof sqliteD1>;
let sent: { to: string; text: string }[];

const env = () =>
	({
		DB: world.db,
		MARKETS_ENV: "production",
		BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
		EMAIL: {
			send: async (m: { to: string; text: string }) => {
				sent.push(m);
			},
		},
	}) as never;

/** A browser's cookies: Set-Cookie lines applied, a cleared one removed. */
type TJar = Map<string, string>;
const apply = (jar: TJar, headers: Headers) => {
	for (const line of headers.getSetCookie()) {
		const [pair] = line.split(";");
		const at = pair.indexOf("=");
		const name = pair.slice(0, at);
		const value = pair.slice(at + 1);
		if (value === "" || /max-age=0/i.test(line)) jar.delete(name);
		else jar.set(name, value);
	}
	return jar;
};
const cookieHeader = (jar: TJar) =>
	[...jar].map(([k, v]) => `${k}=${v}`).join("; ");

const request = (path: string, jar: TJar, form?: Record<string, string>) =>
	new Request(`${ORIGIN}${path}`, {
		method: form ? "POST" : "GET",
		headers: { cookie: cookieHeader(jar), origin: ORIGIN },
		body: form ? new URLSearchParams(form) : undefined,
	});

/** Sign in as a real browser would: request a magic link, follow it. */
const signIn = async (email: string): Promise<TJar> => {
	const auth = getAuth({ env: env(), request: new Request(`${ORIGIN}/`) });
	await auth.api.signInMagicLink({
		body: { email, callbackURL: "/dashboard" },
		headers: new Headers({ origin: ORIGIN }),
	});
	const link = sent
		.filter((m) => m.to === email)
		.at(-1)
		?.text.match(/https:\/\/\S+verify\S+/)?.[0];
	if (!link) throw new Error(`no magic link for ${email}`);
	const response = await auth.handler(new Request(link));
	return apply(new Map(), response.headers);
};

const args = (req: Request) =>
	({
		request: req,
		context: { cloudflare: { env: env() } },
		params: {},
	}) as never;

/** A route's thrown redirect or error, as the Response it is. */
const thrown = async (run: () => Promise<unknown>) => {
	try {
		await run();
	} catch (error) {
		if (error instanceof Response) return error;
		if (
			error &&
			typeof error === "object" &&
			"type" in error &&
			error.type === "DataWithResponseInit"
		)
			return error as unknown as { init: { status: number } };
		throw error;
	}
	throw new Error("expected a throw");
};

const whoIs = async (jar: TJar) => {
	const session = await getServerSession({
		env: env(),
		request: request("/dashboard", jar),
	});
	return {
		email: session?.user.email,
		impersonatedBy:
			(session?.session as { impersonatedBy?: string | null } | undefined)
				?.impersonatedBy ?? null,
	};
};

let admin: TJar;
let customer: TJar;

// One database for the file: getAuth caches its Better Auth per host, so a
// fresh database per test would never reach it.
beforeAll(async () => {
	world = sqliteD1();
	sent = [];
	admin = await signIn("dylan@saferate.com");
	// Migration 0009 sets the role on an existing row; this user is new.
	await world.db
		.prepare("update user set role = 'admin' where email = ?")
		.bind("dylan@saferate.com")
		.run();
	customer = await signIn("reader@example.com");
});

describe("/support", () => {
	test("is a 404 to anyone but an admin", async () => {
		const res = await thrown(() => loader(args(request("/support", customer))));
		expect("init" in res ? res.init.status : res.status).toBe(404);
		const act = await thrown(() =>
			action(
				args(
					request("/support", customer, {
						intent: "impersonate",
						userId: "anyone",
					}),
				),
			),
		);
		expect("init" in act ? act.init.status : act.status).toBe(404);
	});

	test("lists every account to an admin", async () => {
		const data = (await loader(args(request("/support", admin)))) as {
			accounts: { email: string; isAdmin: boolean; isInternal: boolean }[];
		};
		expect(data.accounts.map((a) => a.email).sort()).toEqual([
			"dylan@saferate.com",
			"reader@example.com",
		]);
		expect(data.accounts.find((a) => a.isAdmin)?.email).toBe(
			"dylan@saferate.com",
		);
	});

	test("an admin becomes the customer, is kept out of keys, and comes back", async () => {
		const readerId = (await world.db
			.prepare("select id from user where email = ?")
			.bind("reader@example.com")
			.first()) as { id: string };
		const adminId = (await world.db
			.prepare("select id from user where email = ?")
			.bind("dylan@saferate.com")
			.first()) as { id: string };

		const go = (await thrown(() =>
			action(
				args(
					request("/support", admin, {
						intent: "impersonate",
						userId: readerId.id,
					}),
				),
			),
		)) as Response;
		expect(go.status).toBe(302);
		expect(go.headers.get("Location")).toBe("/dashboard");
		const as = apply(new Map(admin), go.headers);
		expect(await whoIs(as)).toEqual({
			email: "reader@example.com",
			impersonatedBy: adminId.id,
		});

		// The dashboard knows, and an API key cannot be made on their behalf.
		const org = await requireOrganization(request("/dashboard", as), env());
		expect(org.impersonatedBy).toBe(adminId.id);
		const refused = await thrown(() =>
			keysAction(
				args(request("/dashboard/keys", as, { intent: "create", nameApiKey: "x" })),
			),
		);
		expect("init" in refused ? refused.init.status : refused.status).toBe(403);

		// The customer's own sign-in is untouched and still has keys.
		expect(await whoIs(customer)).toEqual({
			email: "reader@example.com",
			impersonatedBy: null,
		});

		const back = (await thrown(() =>
			action(args(request("/support", as, { intent: "stop-impersonating" }))),
		)) as Response;
		expect(back.headers.get("Location")).toBe("/support");
		expect(await whoIs(apply(as, back.headers))).toEqual({
			email: "dylan@saferate.com",
			impersonatedBy: null,
		});
	});

	test("an admin cannot be impersonated", async () => {
		const adminId = (await world.db
			.prepare("select id from user where email = ?")
			.bind("dylan@saferate.com")
			.first()) as { id: string };
		await expect(
			action(
				args(
					request("/support", admin, {
						intent: "impersonate",
						userId: adminId.id,
					}),
				),
			),
		).rejects.toMatchObject({ statusCode: 403 });
	});
});
