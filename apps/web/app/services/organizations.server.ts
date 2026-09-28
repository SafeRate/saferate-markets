import { z } from "zod";

/**
 * An organization is the billing and API-key boundary. Ported from
 * saferate-oklocate. Every user gets exactly one (single seat, enforced by
 * unique indexes in migration 0001), so there is never a key with no owner.
 *
 * Created lazily on first dashboard visit rather than in a Better Auth hook.
 * A hook that fails takes sign-in down with it; a lazy read that fails costs one
 * page. It is also idempotent by construction, which matters because two tabs
 * hitting the dashboard at once is normal.
 */

const ZInputEnsureOrganization = z.object({
	db: z.custom<D1Database>((v) => v !== null && v !== undefined),
	idUser: z.string().min(1),
	email: z.string().min(3),
});

type TInputEnsureOrganization = z.infer<typeof ZInputEnsureOrganization>;

/** Slug from the email domain, which is the useful default for a B2B account. */
const slugFromEmail = (email: string) => {
	const domain = email.split("@")[1] ?? "account";
	const base = domain
		.split(".")[0]
		.replace(/[^a-z0-9]/gi, "")
		.toLowerCase();
	return base.length >= 2 ? base : "account";
};

export async function ensureOrganization(_input: TInputEnsureOrganization) {
	const input = ZInputEnsureOrganization.parse(_input);
	const { db, idUser, email } = input;

	const findExisting = () =>
		db
			.prepare(
				/* sql */ `
				select o.idOrganization, o.nameOrganization, o.slug,
				       o.idStripeCustomer
				from organizations o
				join organizationMembers m on m.idOrganization = o.idOrganization
				where m.idUser = ?
				limit 1
			`,
			)
			.bind(idUser)
			.first();

	const existing = await findExisting();
	if (existing) return existing;

	const now = Date.now();
	const idOrganization = crypto.randomUUID();
	const base = slugFromEmail(email);
	// Suffix the slug so two customers on the same email domain do not collide on
	// the unique index. Not user-facing yet, so readability loses to never failing.
	const slug = `${base}-${idOrganization.slice(0, 8)}`;

	// One batch: an org with no member row is an orphan nothing can reach, and
	// D1 has no interactive transactions to roll that back with.
	// Two tabs on a first visit race here. OKLocate's version let both win and
	// made two organizations; the unique index on organizationMembers.idUser
	// (migration 0001) now makes the second batch fail instead, and the loser
	// returns the winner's row rather than a 500.
	try {
		await db.batch([
			db
				.prepare(
					/* sql */ `
					insert into organizations
						(idOrganization, nameOrganization, slug, createdAt, updatedAt)
					values (?, ?, ?, ?, ?)
				`,
				)
				.bind(idOrganization, base, slug, now, now),
			db
				.prepare(
					/* sql */ `
					insert into organizationMembers
						(idOrganizationMember, idOrganization, idUser, roleMember, createdAt)
					values (?, ?, ?, 'owner', ?)
				`,
				)
				.bind(crypto.randomUUID(), idOrganization, idUser, now),
		]);
	} catch (error) {
		const winner = await findExisting();
		if (winner) return winner;
		throw error;
	}

	return {
		idOrganization,
		nameOrganization: base,
		slug,
		idStripeCustomer: null,
	};
}

const ZInputIsOrganizationMember = z.object({
	db: z.custom<D1Database>((v) => v !== null && v !== undefined),
	idOrganization: z.string().min(1),
	idUser: z.string().min(1),
});

type TInputIsOrganizationMember = z.infer<typeof ZInputIsOrganizationMember>;

/**
 * Does this user belong to this organization?
 *
 * Exists for the Stripe plugin's authorizeReference hook. A subscription's
 * referenceId arrives in the REQUEST BODY, so without this check any signed-in
 * user could name another organization's reference and upgrade, cancel or open a
 * billing portal against an account they have nothing to do with. Better Auth
 * verifies that the caller is signed in; it cannot know what our reference ids
 * mean, so the ownership half is ours to enforce.
 *
 * Returns a boolean rather than throwing, because the caller's job is to answer
 * yes/no to the plugin and a thrown error there reads to the customer as a
 * broken checkout rather than a refused one.
 */
export async function isOrganizationMember(
	_input: TInputIsOrganizationMember,
): Promise<boolean> {
	const input = ZInputIsOrganizationMember.parse(_input);
	const row = await input.db
		.prepare(
			/* sql */ `
			select 1 as ok
			from organizationMembers
			where idOrganization = ? and idUser = ?
			limit 1
		`,
		)
		.bind(input.idOrganization, input.idUser)
		.first();
	return row !== null;
}
