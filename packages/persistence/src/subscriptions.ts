import { z } from "zod";

/**
 * The entitlement record: organizationSubscriptions (migration 0002).
 *
 * Written ONLY by the Stripe webhook callbacks in apps/web auth.server.ts, as a
 * projection of what Stripe reports. Read by authenticateApiKey on every API
 * request and by the dashboard. One writer, one direction.
 */

const ZDb = z.custom<D1Database>((v) => v !== null && v !== undefined);

/**
 * The Stripe statuses that grant API access.
 *
 * past_due is IN, as OKLocate decided: Stripe is still retrying the card, and
 * cutting a paying customer off at the first failed charge is a support
 * incident, not a safeguard. Stripe moves it to unpaid or canceled if the retries
 * fail, and either of those revokes.
 */
export const ENTITLED_STATUSES = ["active", "trialing", "past_due"] as const;

/** SQL for the same list, so the query and the constant cannot disagree. */
export const ENTITLED_STATUSES_SQL = ENTITLED_STATUSES.map(
	(s) => `'${s}'`,
).join(", ");

export const ZOrganizationSubscription = z.object({
	idPlan: z.string(),
	idStripeSubscription: z.string().nullable(),
	statusSubscription: z.string(),
	startedAt: z.number(),
	endedAt: z.number().nullable(),
	cancelsAt: z.number().nullable(),
});
export type TOrganizationSubscription = z.infer<
	typeof ZOrganizationSubscription
>;

export const isEntitled = (row: TOrganizationSubscription | null) =>
	row !== null &&
	row.endedAt === null &&
	(ENTITLED_STATUSES as readonly string[]).includes(row.statusSubscription);

export async function getOrganizationSubscription(input: {
	db: D1Database;
	idOrganization: string;
}) {
	const row = await ZDb.parse(input.db)
		.prepare(
			/* sql */ `
			select idPlan, idStripeSubscription, statusSubscription, startedAt,
			       endedAt, cancelsAt
			from organizationSubscriptions
			where idOrganization = ?
		`,
		)
		.bind(input.idOrganization)
		.first();
	return row === null ? null : ZOrganizationSubscription.parse(row);
}

const ZInputSetSubscription = z.object({
	db: ZDb,
	idOrganization: z.string().min(1),
	idPlan: z.string().min(1),
	idStripeSubscription: z.string().nullable(),
	statusSubscription: z.string().min(1),
	/** Epoch ms from Stripe's cancel_at, or null. Null CLEARS a previous one. */
	cancelsAt: z.number().nullable(),
});

/**
 * Upsert the live state. Keyed on the organization (one subscription each), so a
 * redelivered webhook is harmless.
 *
 * A live status clears endedAt: resubscribing after a cancellation must restore
 * access, not leave a stale end date that the entitlement join would honour.
 */
export async function setOrganizationSubscription(
	_input: z.infer<typeof ZInputSetSubscription>,
) {
	const input = ZInputSetSubscription.parse(_input);
	const now = Date.now();
	await input.db
		.prepare(
			/* sql */ `
			insert into organizationSubscriptions
				(idOrganizationSubscription, idOrganization, idPlan,
				 idStripeSubscription, statusSubscription, startedAt, cancelsAt,
				 updatedAt)
			values (?, ?, ?, ?, ?, ?, ?, ?)
			on conflict (idOrganization) do update set
				idPlan = excluded.idPlan,
				idStripeSubscription = excluded.idStripeSubscription,
				statusSubscription = excluded.statusSubscription,
				cancelsAt = excluded.cancelsAt,
				endedAt = null,
				updatedAt = excluded.updatedAt
		`,
		)
		.bind(
			crypto.randomUUID(),
			input.idOrganization,
			input.idPlan,
			input.idStripeSubscription,
			input.statusSubscription,
			now,
			input.cancelsAt,
			now,
		)
		.run();
}

const ZInputEndSubscription = z.object({
	db: ZDb,
	idOrganization: z.string().min(1),
	statusSubscription: z.string().min(1),
});

/** The subscription is gone. This is the one write that revokes access. */
export async function endOrganizationSubscription(
	_input: z.infer<typeof ZInputEndSubscription>,
) {
	const input = ZInputEndSubscription.parse(_input);
	const now = Date.now();
	await input.db
		.prepare(
			/* sql */ `
			update organizationSubscriptions
			set statusSubscription = ?, endedAt = coalesce(endedAt, ?), updatedAt = ?
			where idOrganization = ?
		`,
		)
		.bind(input.statusSubscription, now, now, input.idOrganization)
		.run();
}
