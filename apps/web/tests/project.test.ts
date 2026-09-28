import { describe, expect, test } from "bun:test";
import { project } from "../app/services/auth.server";

/**
 * The webhook projection into organizationSubscriptions: the only writer of the
 * record that decides access and rate limit. A Team subscriber recorded as
 * Individual would be limited to 60/min; a guessed plan is a guessed price.
 */

type TStatement = { sql: string; args: unknown[] };

const fakeDb = () => {
	const writes: TStatement[] = [];
	const statement = (sql: string, args: unknown[] = []): unknown => ({
		sql,
		args,
		bind: (...bound: unknown[]) => statement(sql, bound),
		run: async () => {
			writes.push({ sql, args });
			return { meta: { changes: 1 } };
		},
	});
	return { writes, db: { prepare: (sql: string) => statement(sql) } as never };
};

const sub = (status: string) =>
	({ id: "sub_1", status, cancel_at: null }) as never;

describe("project", () => {
	test("a Team subscription is recorded as team", async () => {
		const { db, writes } = fakeDb();
		await project(db, {
			idOrganization: "org-1",
			planName: "team",
			stripeSubscription: sub("active"),
		});
		expect(writes).toHaveLength(1);
		expect(writes[0].sql).toContain("insert into organizationSubscriptions");
		expect(writes[0].args[2]).toBe("team");
	});

	test("an Individual subscription keeps the id `public`", async () => {
		const { db, writes } = fakeDb();
		await project(db, {
			idOrganization: "org-1",
			planName: "public",
			stripeSubscription: sub("active"),
		});
		expect(writes[0].args[2]).toBe("public");
	});

	test("an unknown plan name writes nothing rather than guessing", async () => {
		const { db, writes } = fakeDb();
		await project(db, {
			idOrganization: "org-1",
			planName: "platinum",
			stripeSubscription: sub("active"),
		});
		expect(writes).toHaveLength(0);
	});

	// A cancellation must revoke whatever the plan was called, or a customer
	// keeps access after they stop paying.
	test("a terminal status ends the subscription even with an unknown plan name", async () => {
		const { db, writes } = fakeDb();
		await project(db, {
			idOrganization: "org-1",
			planName: "platinum",
			stripeSubscription: sub("canceled"),
		});
		expect(writes).toHaveLength(1);
		expect(writes[0].sql).toContain("update organizationSubscriptions");
	});
});
