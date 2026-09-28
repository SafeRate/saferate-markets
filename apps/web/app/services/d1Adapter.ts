import { createAdapterFactory } from "better-auth/adapters";
import { z } from "zod";

/**
 * Copied verbatim into saferate-markets from saferate-oklocate @ d1bf49d on
 * 2026-09-28 (that session confirmed it has zero workspace dependencies).
 *
 * Raw-D1 adapter for Better Auth.
 *
 * Ported from saferate-ai/apps/consumer/app/services/d1Adapter.ts, which has run
 * this against better-auth 1.7.1 in production. Kept close to verbatim on
 * purpose: the consumeOne and incrementOne notes below record an outage that is
 * not rediscoverable by reading the code, and a reimplementation would very
 * likely reintroduce it.
 *
 * Why hand-rolled: better-auth ships adapters for drizzle, kysely, prisma, mongo
 * and memory, none of which speak D1's prepare/bind API. createAdapterFactory is
 * the documented seam for exactly this.
 *
 * On the `as never` casts at each return: createAdapterFactory declares its
 * methods generically (`create<T>(): Promise<T>`), while any concrete
 * implementation can only ever produce `Record<string, unknown>` — it cannot know
 * the caller's T. That is a variance mismatch in the return position only, never a
 * behavioural one, and better-auth's own bundled adapters have the same shape.
 *
 * The casts are deliberately at the returns rather than on the adapter function or
 * the object literal. Casting either of those removes the contextual type that
 * gives every destructured parameter its type, turning one error into thirty-plus
 * implicit-any errors. The consumer app instead carries the single error as a
 * permanent typecheck baseline; casting the returns keeps this repo at zero, which
 * matters because a genuinely new error is invisible inside a non-zero count.
 *
 * If this file is edited, diff it against the consumer copy first — a fix in one
 * repo needs porting to the other by hand. That is the accepted cost of the
 * vendored-stack decision.
 */

const ZInputCreateD1Adapter = z.object({
	db: z.custom<D1Database>(),
});

type TInputCreateD1Adapter = z.infer<typeof ZInputCreateD1Adapter>;

function createD1Adapter(_input: TInputCreateD1Adapter) {
	const input = ZInputCreateD1Adapter.parse(_input);
	const { db } = input;

	return createAdapterFactory({
		config: {
			adapterId: "d1-raw",
			supportsBooleans: false,
			supportsDates: false,
			supportsJSON: false,
		},
		adapter({
			getModelName,
			getFieldName,
			transformInput,
			transformOutput,
			transformWhereClause,
		}) {
			const buildWhereClause = (
				where: {
					field: string;
					operator: string;
					value: unknown;
					connector: string;
				}[],
			) => {
				if (where.length === 0) return { sql: "", params: [] };

				const conditions: string[] = [];
				const params: unknown[] = [];

				for (const [i, w] of where.entries()) {
					const connector = i === 0 ? "" : ` ${w.connector} `;

					if (w.value === null) {
						if (w.operator === "eq") {
							conditions.push(`${connector}"${w.field}" is null`);
						} else if (w.operator === "ne") {
							conditions.push(`${connector}"${w.field}" is not null`);
						}
						continue;
					}

					switch (w.operator) {
						case "eq":
							conditions.push(`${connector}"${w.field}" = ?`);
							params.push(w.value);
							break;
						case "ne":
							conditions.push(`${connector}"${w.field}" != ?`);
							params.push(w.value);
							break;
						case "lt":
							conditions.push(`${connector}"${w.field}" < ?`);
							params.push(w.value);
							break;
						case "lte":
							conditions.push(`${connector}"${w.field}" <= ?`);
							params.push(w.value);
							break;
						case "gt":
							conditions.push(`${connector}"${w.field}" > ?`);
							params.push(w.value);
							break;
						case "gte":
							conditions.push(`${connector}"${w.field}" >= ?`);
							params.push(w.value);
							break;
						case "in": {
							const arr = w.value as unknown[];
							const placeholders = arr.map(() => "?").join(", ");
							conditions.push(`${connector}"${w.field}" in (${placeholders})`);
							params.push(...arr);
							break;
						}
						case "not_in": {
							const arr = w.value as unknown[];
							const placeholders = arr.map(() => "?").join(", ");
							conditions.push(`${connector}"${w.field}" not in (${placeholders})`);
							params.push(...arr);
							break;
						}
						case "contains":
							conditions.push(`${connector}"${w.field}" like ?`);
							params.push(`%${w.value}%`);
							break;
						case "starts_with":
							conditions.push(`${connector}"${w.field}" like ?`);
							params.push(`${w.value}%`);
							break;
						case "ends_with":
							conditions.push(`${connector}"${w.field}" like ?`);
							params.push(`%${w.value}`);
							break;
						default:
							conditions.push(`${connector}"${w.field}" = ?`);
							params.push(w.value);
					}
				}

				return {
					sql: conditions.length > 0 ? ` where ${conditions.join("")}` : "",
					params,
				};
			};

			return {
				async create({ data, model, select }) {
					const tableName = getModelName(model);
					const transformed = await transformInput(data, model, "create");
					const keys = Object.keys(transformed);
					const values = Object.values(transformed);
					const columns = keys.map((k) => `"${k}"`).join(", ");
					const placeholders = keys.map(() => "?").join(", ");

					const stmt = db
						.prepare(
							/*sql*/ `insert into "${tableName}" (${columns}) values (${placeholders}) returning *`,
						)
						.bind(...values);

					const result = await stmt.first();
					if (!result) throw new Error(`Failed to create record in ${tableName}`);

					return (await transformOutput(
						result as Record<string, unknown>,
						model,
						select,
					)) as never;
				},

				async findOne({ model, where, select }) {
					const tableName = getModelName(model);
					const transformedWhere = transformWhereClause({
						model,
						where,
						action: "findOne",
					});
					const { sql: whereSql, params } = buildWhereClause(transformedWhere || []);

					const selectFields = select?.length
						? select.map((s) => `"${getFieldName({ model, field: s })}"`).join(", ")
						: "*";

					const stmt = db
						.prepare(
							/*sql*/ `select ${selectFields} from "${tableName}"${whereSql} limit 1`,
						)
						.bind(...params);

					const result = await stmt.first();
					if (!result) return null;

					return (await transformOutput(
						result as Record<string, unknown>,
						model,
						select,
					)) as never;
				},

				async findMany({ model, where, limit, select, sortBy, offset }) {
					const tableName = getModelName(model);
					const transformedWhere = transformWhereClause({
						model,
						where,
						action: "findMany",
					});
					const { sql: whereSql, params } = buildWhereClause(transformedWhere || []);

					const selectFields = select?.length
						? select.map((s) => `"${getFieldName({ model, field: s })}"`).join(", ")
						: "*";

					let query = /*sql*/ `select ${selectFields} from "${tableName}"${whereSql}`;

					if (sortBy) {
						const sortField = getFieldName({ model, field: sortBy.field });
						query += ` order by "${sortField}" ${sortBy.direction}`;
					}

					if (limit) query += ` limit ${limit}`;
					if (offset) query += ` offset ${offset}`;

					const stmt = db.prepare(query).bind(...params);
					const result = await stmt.all();

					const rows: Record<string, unknown>[] = [];
					for (const row of result.results || []) {
						rows.push(
							(await transformOutput(
								row as Record<string, unknown>,
								model,
								select,
							)) as Record<string, unknown>,
						);
					}
					return rows as never;
				},

				async update({ model, where, update: updateData }) {
					const tableName = getModelName(model);
					const transformedWhere = transformWhereClause({
						model,
						where,
						action: "update",
					});
					const transformed = await transformInput(
						updateData as Record<string, unknown>,
						model,
						"update",
					);
					const { sql: whereSql, params: whereParams } = buildWhereClause(
						transformedWhere || [],
					);

					const keys = Object.keys(transformed);
					const values = Object.values(transformed);
					const setClause = keys.map((k) => `"${k}" = ?`).join(", ");

					const stmt = db
						.prepare(
							/*sql*/ `update "${tableName}" set ${setClause}${whereSql} returning *`,
						)
						.bind(...values, ...whereParams);

					const result = await stmt.first();
					if (!result) return null;

					return (await transformOutput(
						result as Record<string, unknown>,
						model,
					)) as never;
				},

				async updateMany({ model, where, update: updateData }) {
					const tableName = getModelName(model);
					const transformedWhere = transformWhereClause({
						model,
						where,
						action: "updateMany",
					});
					const transformed = await transformInput(
						updateData as Record<string, unknown>,
						model,
						"update",
					);
					const { sql: whereSql, params: whereParams } = buildWhereClause(
						transformedWhere || [],
					);

					const keys = Object.keys(transformed);
					const values = Object.values(transformed);
					const setClause = keys.map((k) => `"${k}" = ?`).join(", ");

					const stmt = db
						.prepare(/*sql*/ `update "${tableName}" set ${setClause}${whereSql}`)
						.bind(...values, ...whereParams);

					const result = await stmt.run();
					return result.meta?.changes ?? 0;
				},

				// Atomically claim one row and return it, or null if nothing
				// matched. Better Auth reaches for this at every single-use
				// credential site — magic-link tokens, email verification,
				// password reset — and as of 1.6.x a custom adapter that omits
				// it no longer gets the old `transaction(findMany +
				// deleteMany)` fallback: the framework throws
				//   Adapter "d1-raw" must implement consumeOne for atomic
				//   single-use credential consumption
				// and every magic-link click answers an empty 500. That is
				// exactly what took consumer sign-in down on 2026-08-20, and
				// the shape of the outage is worth remembering: a BOGUS token
				// still redirected cleanly with INVALID_TOKEN, because the
				// throw only happens once a row is actually there to consume.
				// So "sign-in is broken" looked like "the link is bad".
				//
				// D1 has no interactive transactions, so atomicity has to come
				// from the statement rather than from a BEGIN: `delete ...
				// returning *` picks the row and removes it in one shot, so of
				// two concurrent clicks exactly one is handed the token and the
				// other gets null. `delete ... limit 1` is not portable —
				// SQLite only accepts it when built with
				// SQLITE_ENABLE_UPDATE_DELETE_LIMIT — hence the sub-select,
				// which is also what keeps this from deleting the other rows
				// that match a non-unique predicate.
				async consumeOne({ model, where }) {
					const tableName = getModelName(model);
					const transformedWhere = transformWhereClause({
						action: "consumeOne",
						model,
						where,
					});
					const { sql: whereSql, params } = buildWhereClause(transformedWhere || []);
					const idField = getFieldName({ field: "id", model });

					const result = await db
						.prepare(
							/*sql*/ `delete from "${tableName}" where "${idField}" = (select "${idField}" from "${tableName}"${whereSql} limit 1) returning *`,
						)
						.bind(...params)
						.first();

					if (!result) return null;

					return (await transformOutput(
						result as Record<string, unknown>,
						model,
					)) as never;
				},

				// The other primitive better-auth 1.7 made mandatory, on the
				// same terms as consumeOne above: omit it and the framework
				// throws `Adapter "d1-raw" must implement incrementOne for
				// atomic guarded counter updates` rather than falling back.
				// Nothing we configure today reaches it — rate limiting keeps
				// its counters in memory unless `rateLimit.storage` is set to
				// "database" — so this is here to keep the next enabled
				// feature (database-backed rate limits, OTP attempt counts)
				// from taking sign-in down the way 2026-08-20 did.
				//
				// `where` is both selector and guard: return the updated row,
				// or null when it matched nothing. One statement again, so the
				// read-modify-write cannot interleave — `set` lands in the same
				// UPDATE as the deltas, and the id sub-select holds it to a
				// single row even when the guard is not unique. Bind order
				// follows the placeholders left to right: deltas, then set
				// values, then the guard's own params.
				async incrementOne({ model, where, increment, set }) {
					const tableName = getModelName(model);
					const transformedWhere = transformWhereClause({
						action: "incrementOne",
						model,
						where,
					});
					const { sql: whereSql, params: whereParams } = buildWhereClause(
						transformedWhere || [],
					);
					const idField = getFieldName({ field: "id", model });

					const assignments: string[] = [];
					const values: unknown[] = [];
					for (const [field, delta] of Object.entries(increment)) {
						assignments.push(`"${field}" = "${field}" + ?`);
						values.push(delta);
					}
					for (const [field, value] of Object.entries(set ?? {})) {
						assignments.push(`"${field}" = ?`);
						values.push(value);
					}
					if (assignments.length === 0) return null;

					const result = await db
						.prepare(
							/*sql*/ `update "${tableName}" set ${assignments.join(", ")} where "${idField}" = (select "${idField}" from "${tableName}"${whereSql} limit 1) returning *`,
						)
						.bind(...values, ...whereParams)
						.first();

					if (!result) return null;

					return (await transformOutput(
						result as Record<string, unknown>,
						model,
					)) as never;
				},

				async delete({ model, where }) {
					const tableName = getModelName(model);
					const transformedWhere = transformWhereClause({
						model,
						where,
						action: "delete",
					});
					const { sql: whereSql, params } = buildWhereClause(transformedWhere || []);

					await db
						.prepare(/*sql*/ `delete from "${tableName}"${whereSql}`)
						.bind(...params)
						.run();
				},

				async deleteMany({ model, where }) {
					const tableName = getModelName(model);
					const transformedWhere = transformWhereClause({
						model,
						where,
						action: "deleteMany",
					});
					const { sql: whereSql, params } = buildWhereClause(transformedWhere || []);

					const result = await db
						.prepare(/*sql*/ `delete from "${tableName}"${whereSql}`)
						.bind(...params)
						.run();

					return result.meta?.changes ?? 0;
				},

				async count({ model, where }) {
					const tableName = getModelName(model);
					const transformedWhere = transformWhereClause({
						model,
						where,
						action: "count",
					});
					const { sql: whereSql, params } = buildWhereClause(transformedWhere || []);

					const result = await db
						.prepare(
							/*sql*/ `select count(*) as count from "${tableName}"${whereSql}`,
						)
						.bind(...params)
						.first();

					return (result?.count as number) ?? 0;
				},
			};
		},
	});
}

export default createD1Adapter;
