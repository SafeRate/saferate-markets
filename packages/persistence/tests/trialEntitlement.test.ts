import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { authenticateApiKey, createApiKey } from "../src/apiKeyStore";

/**
 * authenticateApiKey against the REAL migrations in SQLite, through just
 * enough of D1 (prepare, bind, first, run). The API's own tests fake the
 * query's result, so this is where its SQL, the trial join included, runs.
 */

const MIGRATIONS = join(import.meta.dir, "../migrations");
const NOW = Date.UTC(2026, 9, 6, 15);
const DAY = 86_400_000;

const d1 = (sqlite: Database) =>
	({
		prepare: (sql: string) => {
			const make = (args: unknown[]) => ({
				bind: (...bound: unknown[]) => make(bound),
				first: async () => sqlite.query(sql).get(...(args as never[])) ?? null,
				run: async () => {
					const r = sqlite.query(sql).run(...(args as never[]));
					return { meta: { changes: r.changes } };
				},
			});
			return make([]);
		},
	}) as unknown as D1Database;

let sqlite: Database;
let db: D1Database;

beforeEach(() => {
	sqlite = new Database(":memory:");
	for (const file of readdirSync(MIGRATIONS).sort())
		sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
	db = d1(sqlite);
});

/** An organization with one key; returns the plaintext key. */
const organizationWithKey = async (input: {
	trialEndsAt: number | null;
	subscription?: { idPlan: string; status: string };
}) => {
	const id = crypto.randomUUID();
	sqlite
		.query(
			"insert into user (id, email, createdAt, updatedAt) values (?, ?, 0, 0)",
		)
		.run(id, `${id}@example.com`);
	sqlite
		.query(
			"insert into organizations (idOrganization, nameOrganization, slug, trialEndsAt, createdAt, updatedAt) values (?, 'x', ?, ?, 0, 0)",
		)
		.run(id, id, input.trialEndsAt);
	if (input.subscription)
		sqlite
			.query(
				"insert into organizationSubscriptions (idOrganizationSubscription, idOrganization, idPlan, statusSubscription, startedAt, updatedAt) values (?, ?, ?, ?, 0, 0)",
			)
			.run(
				crypto.randomUUID(),
				id,
				input.subscription.idPlan,
				input.subscription.status,
			);
	const { key } = await createApiKey({
		db,
		idOrganization: id,
		idUser: id,
		nameApiKey: "test",
	});
	return key;
};

const auth = async (key: string) => authenticateApiKey({ db, key, now: NOW });

test("a running trial is entitled, on Team", async () => {
	const key = await organizationWithKey({ trialEndsAt: NOW + DAY });
	expect(await auth(key)).toMatchObject({ isEntitled: true, idPlan: "team" });
});

test("an ended trial is not entitled, and the key still resolves (402, not 401)", async () => {
	const key = await organizationWithKey({ trialEndsAt: NOW - 1 });
	expect(await auth(key)).toMatchObject({ isEntitled: false, idPlan: null });
});

test("no trial and no subscription is not entitled", async () => {
	const key = await organizationWithKey({ trialEndsAt: null });
	expect(await auth(key)).toMatchObject({ isEntitled: false, idPlan: null });
});

test("a subscription's plan wins over a running trial", async () => {
	const key = await organizationWithKey({
		trialEndsAt: NOW + DAY,
		subscription: { idPlan: "public", status: "active" },
	});
	expect(await auth(key)).toMatchObject({ isEntitled: true, idPlan: "public" });
});

test("a subscription alone still entitles, as before", async () => {
	const key = await organizationWithKey({
		trialEndsAt: null,
		subscription: { idPlan: "team", status: "active" },
	});
	expect(await auth(key)).toMatchObject({ isEntitled: true, idPlan: "team" });
});

test("a canceled subscription during a trial falls back to the trial", async () => {
	const key = await organizationWithKey({
		trialEndsAt: NOW + DAY,
		subscription: { idPlan: "public", status: "canceled" },
	});
	expect(await auth(key)).toMatchObject({ isEntitled: true, idPlan: "team" });
});

test("migration 0007 gives existing accounts the launch trial, and not the demo", () => {
	const fresh = new Database(":memory:");
	const files = readdirSync(MIGRATIONS).sort();
	for (const file of files.filter((f) => f < "0007"))
		fresh.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
	fresh.exec(
		"insert into organizations (idOrganization, nameOrganization, slug, createdAt, updatedAt) values ('org-a', 'a', 'a', 0, 0)",
	);
	for (const file of files.filter((f) => f >= "0007"))
		fresh.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
	const rows = fresh
		.query("select idOrganization, trialEndsAt from organizations order by 1")
		.all();
	expect(rows).toContainEqual({
		idOrganization: "org-a",
		trialEndsAt: 1_793_923_200_000,
	});
	expect(rows).toContainEqual({ idOrganization: "demo", trialEndsAt: null });
});
