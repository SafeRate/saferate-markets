import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The REAL migrations in an in-memory SQLite, behind just enough of D1
 * (prepare, bind, first, run, all, batch) for the stores to run their own SQL.
 */
const MIGRATIONS = join(import.meta.dir, "../migrations");

export const sqliteD1 = () => {
	const sqlite = new Database(":memory:");
	for (const file of readdirSync(MIGRATIONS).sort())
		sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
	const statement = (sql: string, args: unknown[] = []) => ({
		bind: (...bound: unknown[]) => statement(sql, bound),
		first: async () => sqlite.query(sql).get(...(args as never[])) ?? null,
		all: async () => ({ results: sqlite.query(sql).all(...(args as never[])) }),
		run: async () => {
			const r = sqlite.query(sql).run(...(args as never[]));
			return { meta: { changes: r.changes } };
		},
	});
	const db = {
		prepare: (sql: string) => statement(sql),
		batch: async (statements: { run: () => Promise<unknown> }[]) => {
			const out = [];
			for (const s of statements) out.push(await s.run());
			return out;
		},
	} as unknown as D1Database;
	/** A user, verified unless told otherwise. */
	const addUser = (email: string, verified = true) => {
		const id = crypto.randomUUID();
		sqlite
			.query(
				"insert into user (id, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, 0, 0)",
			)
			.run(id, email, verified ? 1 : 0);
		return id;
	};
	return { sqlite, db, addUser };
};
