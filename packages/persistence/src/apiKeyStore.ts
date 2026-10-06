import { z } from "zod";
import { generateApiKey, sha256Hex } from "./apiKeys";
import { TRIAL } from "@markets/schema";
import { ENTITLED_STATUSES_SQL } from "./subscriptions";

/**
 * D1 operations for API keys. Ported from saferate-oklocate.
 *
 * Lives in a package rather than either app because BOTH Workers need it, for
 * opposite reasons: apps/web mints, rotates and revokes keys from the dashboard,
 * apps/api only ever resolves one. A second copy in one Worker is how the
 * hashing convention silently forks.
 */

const ZDb = z.custom<D1Database>((v) => v !== null && v !== undefined);

const ZInputCreateApiKey = z.object({
	db: ZDb,
	idOrganization: z.string().min(1),
	idUser: z.string().min(1),
	nameApiKey: z.string().min(1).max(80),
});

/** Returns the plaintext key. The CALLER shows it once and never stores it. */
export async function createApiKey(_input: z.infer<typeof ZInputCreateApiKey>) {
	const input = ZInputCreateApiKey.parse(_input);
	const generated = await generateApiKey();
	const idApiKey = crypto.randomUUID();

	await input.db
		.prepare(
			/* sql */ `
			insert into apiKeys
				(idApiKey, idOrganization, nameApiKey, prefixApiKey, hashApiKey,
				 idUserCreatedBy, createdAt)
			values (?, ?, ?, ?, ?, ?, ?)
		`,
		)
		.bind(
			idApiKey,
			input.idOrganization,
			input.nameApiKey,
			generated.prefixApiKey,
			generated.hashApiKey,
			input.idUser,
			Date.now(),
		)
		.run();

	return { idApiKey, key: generated.key, prefixApiKey: generated.prefixApiKey };
}

export const ZApiKeyListed = z.object({
	idApiKey: z.string(),
	nameApiKey: z.string(),
	prefixApiKey: z.string(),
	lastUsedAt: z.number().nullable(),
	revokedAt: z.number().nullable(),
	expiresAt: z.number().nullable(),
	idApiKeyRotatedFrom: z.string().nullable(),
	createdAt: z.number(),
});
export type TApiKeyListed = z.infer<typeof ZApiKeyListed>;

const ZInputListApiKeys = z.object({
	db: ZDb,
	idOrganization: z.string().min(1),
});

/** hashApiKey is deliberately NOT selected. It has no business leaving D1. */
export async function listApiKeys(_input: z.infer<typeof ZInputListApiKeys>) {
	const input = ZInputListApiKeys.parse(_input);
	const result = await input.db
		.prepare(
			/* sql */ `
			select idApiKey, nameApiKey, prefixApiKey, lastUsedAt, revokedAt,
			       expiresAt, idApiKeyRotatedFrom, createdAt
			from apiKeys
			where idOrganization = ?
			order by revokedAt is not null, createdAt desc
		`,
		)
		.bind(input.idOrganization)
		.all();
	return z.array(ZApiKeyListed).parse(result.results ?? []);
}

const ZInputRevokeApiKey = z.object({
	db: ZDb,
	idOrganization: z.string().min(1),
	idApiKey: z.string().min(1),
});

/**
 * Revoke, never delete: usage rows reference the key, and a deleted key turns a
 * usage line into an orphan nobody can explain.
 *
 * Scoped by idOrganization as well as id, so a crafted POST cannot revoke
 * another customer's key by guessing a uuid. `revokedAt is null` makes it
 * idempotent.
 */
export async function revokeApiKey(_input: z.infer<typeof ZInputRevokeApiKey>) {
	const input = ZInputRevokeApiKey.parse(_input);
	const result = await input.db
		.prepare(
			/* sql */ `
			update apiKeys set revokedAt = ?
			where idApiKey = ? and idOrganization = ? and revokedAt is null
		`,
		)
		.bind(Date.now(), input.idApiKey, input.idOrganization)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

export const ZApiKeyAuthenticated = z.object({
	idApiKey: z.string(),
	idOrganization: z.string(),
	lastUsedAt: z.number().nullable(),
	/** 0/1 from SQL. A live subscription, or a trial still running (TRIAL). */
	isEntitled: z.union([z.literal(0), z.literal(1)]).transform(Boolean),
	/** The live subscription's plan id, else the trial's, else null. Decides the rate limit. */
	idPlan: z.string().nullable(),
});
export type TApiKeyAuthenticated = z.infer<typeof ZApiKeyAuthenticated>;

const ZInputAuthenticateApiKey = z.object({
	db: ZDb,
	key: z.string().min(1),
	now: z.number().optional(),
});

/**
 * Resolve a plaintext key to its organization, or null.
 *
 * Both liveness conditions are in the WHERE clause, not checked afterwards: a
 * dead key must not even resolve, and a caller who forgets a post-check must not
 * be able to authenticate with one. revokedAt is checked independently of
 * expiresAt so that revoking a key mid-rotation still kills it at once.
 *
 * ENTITLEMENT rides in the same query, as `isEntitled`, so the hot path is still
 * one read. A running trial (organizations.trialEndsAt, TRIAL in @markets/schema)
 * entitles too, on the trial's plan; a subscription's plan wins when both exist. It is a LEFT join and a flag rather than an inner join, so the
 * middleware can tell "not a key" (401) from "a real key whose organization has
 * no live subscription" (402, with where to subscribe). Telling those apart is
 * not an oracle: only someone holding the key learns anything.
 */
export async function authenticateApiKey(
	_input: z.infer<typeof ZInputAuthenticateApiKey>,
) {
	const input = ZInputAuthenticateApiKey.parse(_input);
	const hash = await sha256Hex(input.key);
	const row = await input.db
		.prepare(
			/* sql */ `
			select k.idApiKey, k.idOrganization, k.lastUsedAt,
			       case when s.idOrganization is not null
			              or o.trialEndsAt > ?2 then 1 else 0 end
			         as isEntitled,
			       coalesce(s.idPlan,
			                case when o.trialEndsAt > ?2 then '${TRIAL.idPlan}' end)
			         as idPlan
			from apiKeys k
			left join organizationSubscriptions s
			       on s.idOrganization = k.idOrganization
			      and s.endedAt is null
			      and s.statusSubscription in (${ENTITLED_STATUSES_SQL})
			left join organizations o on o.idOrganization = k.idOrganization
			where k.hashApiKey = ?1 and k.revokedAt is null
			  and (k.expiresAt is null or k.expiresAt > ?2)
			limit 1
		`,
		)
		.bind(hash, input.now ?? Date.now())
		.first();
	return row === null ? null : ZApiKeyAuthenticated.parse(row);
}

const ZInputTouchApiKey = z.object({
	db: ZDb,
	idApiKey: z.string().min(1),
	lastUsedAt: z.number().nullable(),
});

const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * lastUsedAt at most once an hour per key. It only answers "is this key still in
 * use?", and a D1 write on every request is the most expensive thing to do per
 * call for the least value.
 */
export async function touchApiKeyIfStale(
	_input: z.infer<typeof ZInputTouchApiKey>,
) {
	const input = ZInputTouchApiKey.parse(_input);
	const now = Date.now();
	if (input.lastUsedAt !== null && now - input.lastUsedAt < TOUCH_INTERVAL_MS) {
		return false;
	}
	await input.db
		.prepare(/* sql */ "update apiKeys set lastUsedAt = ? where idApiKey = ?")
		.bind(now, input.idApiKey)
		.run();
	return true;
}

/**
 * How long a rotated key keeps working: seven days. Long enough to rotate on a
 * Friday and deploy on Monday; short enough that a key rotated because it LEAKED
 * is not usable for a fortnight. A leaked key should be revoked, which still
 * works inside the grace period and takes effect at once.
 */
export const API_KEY_ROTATION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const ZInputRotateApiKey = z.object({
	db: ZDb,
	idOrganization: z.string().min(1),
	idApiKey: z.string().min(1),
	idUser: z.string().min(1),
	graceMs: z.number().int().nonnegative().default(API_KEY_ROTATION_GRACE_MS),
});

/**
 * Issue a replacement and put the old key on a deadline.
 *
 * Rotation is NOT create-plus-revoke. A customer cannot swap a key atomically:
 * they deploy the new one across their own systems first, and killing the old
 * one at rotation is an outage we caused.
 *
 * The replacement inherits the NAME. Both writes go in ONE batch: a new key
 * without the old one expiring leaves two permanent keys, and an expiry with no
 * new key strands the customer. D1 has no interactive transactions; batch is the
 * only atomicity available.
 *
 * Returns null when the key is not this organization's or is already dead.
 */
export async function rotateApiKey(_input: z.input<typeof ZInputRotateApiKey>) {
	const input = ZInputRotateApiKey.parse(_input);
	const now = Date.now();

	const existing = await input.db
		.prepare(
			/* sql */ `
			select idApiKey, nameApiKey
			from apiKeys
			where idApiKey = ? and idOrganization = ?
			  and revokedAt is null and (expiresAt is null or expiresAt > ?)
			limit 1
		`,
		)
		.bind(input.idApiKey, input.idOrganization, now)
		.first();
	if (!existing) return null;

	const generated = await generateApiKey();
	const idApiKeyNew = crypto.randomUUID();
	const expiresAt = now + input.graceMs;

	await input.db.batch([
		input.db
			.prepare(
				/* sql */ `
				insert into apiKeys
					(idApiKey, idOrganization, nameApiKey, prefixApiKey, hashApiKey,
					 idUserCreatedBy, createdAt, idApiKeyRotatedFrom)
				values (?, ?, ?, ?, ?, ?, ?, ?)
			`,
			)
			.bind(
				idApiKeyNew,
				input.idOrganization,
				String(existing.nameApiKey),
				generated.prefixApiKey,
				generated.hashApiKey,
				input.idUser,
				now,
				input.idApiKey,
			),
		input.db
			.prepare(
				/* sql */ `
				update apiKeys set expiresAt = ?
				where idApiKey = ? and idOrganization = ? and revokedAt is null
			`,
			)
			.bind(expiresAt, input.idApiKey, input.idOrganization),
	]);

	return {
		idApiKey: idApiKeyNew,
		key: generated.key,
		prefixApiKey: generated.prefixApiKey,
		expiresAt,
	};
}

const ZInputCountActiveApiKeys = z.object({
	db: ZDb,
	idOrganization: z.string().min(1),
});

/**
 * How many keys would authenticate right now, by the SAME predicate as
 * authenticateApiKey. OKLocate's dashboard once counted `revokedAt is null`
 * alone and reported keys past their rotation deadline as active.
 */
export async function countActiveApiKeys(
	_input: z.infer<typeof ZInputCountActiveApiKeys>,
) {
	const input = ZInputCountActiveApiKeys.parse(_input);
	const row = await input.db
		.prepare(
			/* sql */ `
			select count(*) as n from apiKeys
			where idOrganization = ? and revokedAt is null
			  and (expiresAt is null or expiresAt > ?)
		`,
		)
		.bind(input.idOrganization, Date.now())
		.first();
	return Number(row?.n ?? 0);
}
