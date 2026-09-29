import { z } from "zod";

/**
 * D1 operations for liability streams and saved Builder plans. Scoped by
 * idOrganization in the SQL itself, like portfolios.ts.
 */

type TScope = { db: D1Database; idOrganization: string };
const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ZLiabilityStream = z.object({
	idLiabilityStream: z.string(),
	nameLiabilityStream: z.string(),
	createdAt: z.number(),
	updatedAt: z.number(),
	countCashflows: z.number().optional(),
	totalAmount: z.number().nullable().optional(),
	firstDue: z.string().nullable().optional(),
	lastDue: z.string().nullable().optional(),
});
export type TLiabilityStream = z.infer<typeof ZLiabilityStream>;

export const ZLiabilityCashflow = z.object({
	idLiabilityCashflow: z.string(),
	dueDate: zIsoDate,
	amount: z.number(),
	label: z.string().nullable(),
});
export type TLiabilityCashflow = z.infer<typeof ZLiabilityCashflow>;

export const ZNewLiabilityCashflow = z.object({
	dueDate: zIsoDate,
	amount: z.number().positive(),
	label: z.string().max(120).nullable(),
});

export async function listLiabilityStreams(input: TScope) {
	const result = await input.db
		.prepare(
			/* sql */ `
			select s.idLiabilityStream, s.nameLiabilityStream, s.createdAt, s.updatedAt,
			       count(c.idLiabilityCashflow) as countCashflows, sum(c.amount) as totalAmount,
			       min(c.dueDate) as firstDue, max(c.dueDate) as lastDue
			from liabilityStreams s
			left join liabilityCashflows c on c.idLiabilityStream = s.idLiabilityStream
			where s.idOrganization = ?
			group by s.idLiabilityStream
			order by s.createdAt
		`,
		)
		.bind(input.idOrganization)
		.all();
	return z.array(ZLiabilityStream).parse(result.results ?? []);
}

export async function getLiabilityStream(
	input: TScope & { idLiabilityStream: string },
) {
	const stream = await input.db
		.prepare(
			/* sql */ `
			select idLiabilityStream, nameLiabilityStream, createdAt, updatedAt
			from liabilityStreams where idLiabilityStream = ? and idOrganization = ?
		`,
		)
		.bind(input.idLiabilityStream, input.idOrganization)
		.first();
	if (stream === null) return null;
	const rows = await input.db
		.prepare(
			/* sql */ `
			select idLiabilityCashflow, dueDate, amount, label
			from liabilityCashflows where idLiabilityStream = ? order by dueDate
		`,
		)
		.bind(input.idLiabilityStream)
		.all();
	return {
		...ZLiabilityStream.parse(stream),
		cashflows: z.array(ZLiabilityCashflow).parse(rows.results ?? []),
	};
}

/**
 * Create or replace a stream's cashflows in one batch: a schedule is edited as
 * a whole, so the stored one is always exactly what was last saved.
 */
export async function saveLiabilityStream(
	input: TScope & {
		idLiabilityStream: string | null;
		nameLiabilityStream: string;
		cashflows: z.infer<typeof ZNewLiabilityCashflow>[];
	},
) {
	const name = z.string().trim().min(1).max(80).parse(input.nameLiabilityStream);
	const rows = z
		.array(ZNewLiabilityCashflow)
		.min(1)
		.max(2000)
		.parse(input.cashflows);
	const now = Date.now();
	let id = input.idLiabilityStream;
	const statements: D1PreparedStatement[] = [];
	if (id === null) {
		id = crypto.randomUUID();
		statements.push(
			input.db
				.prepare(
					"insert into liabilityStreams (idLiabilityStream, idOrganization, nameLiabilityStream, createdAt, updatedAt) values (?, ?, ?, ?, ?)",
				)
				.bind(id, input.idOrganization, name, now, now),
		);
	} else {
		const existing = await getLiabilityStream({
			...input,
			idLiabilityStream: id,
		});
		if (existing === null) return null;
		statements.push(
			input.db
				.prepare(
					"update liabilityStreams set nameLiabilityStream = ?, updatedAt = ? where idLiabilityStream = ? and idOrganization = ?",
				)
				.bind(name, now, id, input.idOrganization),
			input.db
				.prepare("delete from liabilityCashflows where idLiabilityStream = ?")
				.bind(id),
		);
	}
	const insert = input.db.prepare(
		"insert into liabilityCashflows (idLiabilityCashflow, idLiabilityStream, dueDate, amount, label) values (?, ?, ?, ?, ?)",
	);
	for (const row of rows)
		statements.push(
			insert.bind(crypto.randomUUID(), id, row.dueDate, row.amount, row.label),
		);
	await input.db.batch(statements);
	return id;
}

export async function deleteLiabilityStream(
	input: TScope & { idLiabilityStream: string },
) {
	const existing = await getLiabilityStream(input);
	if (existing === null) return false;
	await input.db.batch([
		input.db
			.prepare("delete from liabilityCashflows where idLiabilityStream = ?")
			.bind(input.idLiabilityStream),
		input.db
			.prepare(
				"update builderPlans set idLiabilityStream = null where idLiabilityStream = ?",
			)
			.bind(input.idLiabilityStream),
		input.db
			.prepare(
				"delete from liabilityStreams where idLiabilityStream = ? and idOrganization = ?",
			)
			.bind(input.idLiabilityStream, input.idOrganization),
	]);
	return true;
}

/* ─── Saved plans ────────────────────────────────────────────────────────── */

export const ZPlanPositionStored = z.object({
	cusip: z.string(),
	faceAmount: z.number(),
	planPrice: z.number(),
	dirtyPrice: z.number(),
	cost: z.number(),
});

export const ZBuilderPlan = z.object({
	idPlan: z.string(),
	namePlan: z.string(),
	method: z.string(),
	idLiabilityStream: z.string().nullable(),
	asOf: z.string(),
	settleDate: z.string(),
	inputsJson: z.string(),
	positionsJson: z.string(),
	cost: z.number(),
	createdAt: z.number(),
});
export type TBuilderPlan = z.infer<typeof ZBuilderPlan>;

export async function saveBuilderPlan(
	input: TScope & {
		idUser: string;
		namePlan: string;
		method: string;
		idLiabilityStream: string | null;
		asOf: string;
		settleDate: string;
		inputs: Record<string, unknown>;
		positions: z.infer<typeof ZPlanPositionStored>[];
	},
) {
	const positions = z
		.array(ZPlanPositionStored)
		.min(1)
		.max(1000)
		.parse(input.positions);
	const idPlan = crypto.randomUUID();
	await input.db
		.prepare(
			/* sql */ `
			insert into builderPlans
				(idPlan, idOrganization, namePlan, method, idLiabilityStream, asOf, settleDate,
				 inputsJson, positionsJson, cost, idUserCreatedBy, createdAt)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		)
		.bind(
			idPlan,
			input.idOrganization,
			z.string().trim().min(1).max(120).parse(input.namePlan),
			input.method,
			input.idLiabilityStream,
			input.asOf,
			input.settleDate,
			JSON.stringify(input.inputs),
			JSON.stringify(positions),
			positions.reduce((s, p) => s + p.cost, 0),
			input.idUser,
			Date.now(),
		)
		.run();
	return idPlan;
}

export async function listBuilderPlans(input: TScope) {
	const result = await input.db
		.prepare(
			/* sql */ `
			select idPlan, namePlan, method, idLiabilityStream, asOf, settleDate, inputsJson, positionsJson, cost, createdAt
			from builderPlans where idOrganization = ? order by createdAt desc
		`,
		)
		.bind(input.idOrganization)
		.all();
	return z.array(ZBuilderPlan).parse(result.results ?? []);
}

export async function getBuilderPlan(input: TScope & { idPlan: string }) {
	const row = await input.db
		.prepare(
			/* sql */ `
			select idPlan, namePlan, method, idLiabilityStream, asOf, settleDate, inputsJson, positionsJson, cost, createdAt
			from builderPlans where idPlan = ? and idOrganization = ?
		`,
		)
		.bind(input.idPlan, input.idOrganization)
		.first();
	if (row === null) return null;
	const plan = ZBuilderPlan.parse(row);
	return {
		...plan,
		inputs: JSON.parse(plan.inputsJson) as Record<string, unknown>,
		positions: z.array(ZPlanPositionStored).parse(JSON.parse(plan.positionsJson)),
	};
}

export async function deleteBuilderPlan(input: TScope & { idPlan: string }) {
	const result = await input.db
		.prepare("delete from builderPlans where idPlan = ? and idOrganization = ?")
		.bind(input.idPlan, input.idOrganization)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}
