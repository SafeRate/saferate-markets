/**
 * Email alert preferences, the send ledger and pending sign-ups (migration
 * 0008). A user with no preferences row has the defaults: the daily rundown
 * on, auction alerts off, every term.
 */

export type TAlertKind = "rundown" | "auctionResult" | "auctionAnnouncement";

export type TAlertPreferences = {
	rundown: boolean;
	auctionResults: boolean;
	auctionAnnouncements: boolean;
	/** Term groups ("Note 10-Year"); null means every term. */
	terms: string[] | null;
	paused: boolean;
};

export const DEFAULT_ALERT_PREFERENCES: TAlertPreferences = {
	rundown: true,
	auctionResults: false,
	auctionAnnouncements: false,
	terms: null,
	paused: false,
};

type TPreferenceRow = {
	rundown: number;
	auctionResults: number;
	auctionAnnouncements: number;
	terms: string | null;
	paused: number;
};

const parseTerms = (raw: string | null): string[] | null => {
	if (raw === null) return null;
	try {
		const value = JSON.parse(raw);
		return Array.isArray(value) && value.every((v) => typeof v === "string")
			? value
			: null;
	} catch {
		return null;
	}
};

const fromRow = (row: TPreferenceRow): TAlertPreferences => ({
	rundown: row.rundown === 1,
	auctionResults: row.auctionResults === 1,
	auctionAnnouncements: row.auctionAnnouncements === 1,
	terms: parseTerms(row.terms),
	paused: row.paused === 1,
});

export async function getAlertPreferences(input: {
	db: D1Database;
	idUser: string;
}): Promise<TAlertPreferences> {
	const row = await input.db
		.prepare(
			"select rundown, auctionResults, auctionAnnouncements, terms, paused from alertPreferences where idUser = ?",
		)
		.bind(input.idUser)
		.first<TPreferenceRow>();
	return row ? fromRow(row) : { ...DEFAULT_ALERT_PREFERENCES };
}

export async function putAlertPreferences(input: {
	db: D1Database;
	idUser: string;
	preferences: TAlertPreferences;
	source?: string | null;
}) {
	const p = input.preferences;
	const now = Date.now();
	await input.db
		.prepare(
			`insert into alertPreferences
			   (idUser, rundown, auctionResults, auctionAnnouncements, terms, paused, source, createdAt, updatedAt)
			 values (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 on conflict (idUser) do update set
			   rundown = excluded.rundown,
			   auctionResults = excluded.auctionResults,
			   auctionAnnouncements = excluded.auctionAnnouncements,
			   terms = excluded.terms,
			   paused = excluded.paused,
			   source = coalesce(alertPreferences.source, excluded.source),
			   updatedAt = excluded.updatedAt`,
		)
		.bind(
			input.idUser,
			p.rundown ? 1 : 0,
			p.auctionResults ? 1 : 0,
			p.auctionAnnouncements ? 1 : 0,
			p.terms === null ? null : JSON.stringify(p.terms),
			p.paused ? 1 : 0,
			input.source ?? null,
			now,
			now,
		)
		.run();
}

export type TAlertRecipient = {
	idUser: string;
	email: string;
	preferences: TAlertPreferences;
};

/**
 * Everyone who should receive `kind`: verified email, not paused, the kind
 * switched on (the rundown counts as on for a user with no row). Term filters
 * are returned, not applied: the caller knows the auction's term.
 */
export async function listAlertRecipients(input: {
	db: D1Database;
	kind: TAlertKind;
}): Promise<TAlertRecipient[]> {
	const column = {
		rundown: "rundown",
		auctionResult: "auctionResults",
		auctionAnnouncement: "auctionAnnouncements",
	}[input.kind];
	const fallback = DEFAULT_ALERT_PREFERENCES[column as keyof TAlertPreferences]
		? 1
		: 0;
	const { results } = await input.db
		.prepare(
			`select u.id as idUser, u.email as email,
			        coalesce(p.rundown, 1) as rundown,
			        coalesce(p.auctionResults, 0) as auctionResults,
			        coalesce(p.auctionAnnouncements, 0) as auctionAnnouncements,
			        p.terms as terms,
			        coalesce(p.paused, 0) as paused
			   from user u
			   left join alertPreferences p on p.idUser = u.id
			  where u.emailVerified = 1
			    and coalesce(p.paused, 0) = 0
			    and coalesce(p.${column}, ${fallback}) = 1`,
		)
		.all<TPreferenceRow & { idUser: string; email: string }>();
	return results.map((r) => ({
		idUser: r.idUser,
		email: r.email,
		preferences: fromRow(r),
	}));
}

/**
 * Claim one send. True when this caller owns it and should send; false when
 * it was already claimed (sent, failed or in flight) by anyone.
 */
export async function claimAlertSend(input: {
	db: D1Database;
	kind: TAlertKind;
	eventKey: string;
	idUser: string;
}): Promise<boolean> {
	const now = Date.now();
	const result = await input.db
		.prepare(
			`insert into alertSends (kind, eventKey, idUser, status, createdAt, updatedAt)
			 values (?, ?, ?, 'claimed', ?, ?)
			 on conflict (kind, eventKey, idUser) do nothing`,
		)
		.bind(input.kind, input.eventKey, input.idUser, now, now)
		.run();
	return (result.meta.changes ?? 0) === 1;
}

export async function finishAlertSend(input: {
	db: D1Database;
	kind: TAlertKind;
	eventKey: string;
	idUser: string;
	status: "sent" | "failed" | "withheld";
	reason?: string | null;
}) {
	await input.db
		.prepare(
			"update alertSends set status = ?, reason = ?, updatedAt = ? where kind = ? and eventKey = ? and idUser = ?",
		)
		.bind(
			input.status,
			input.reason?.slice(0, 500) ?? null,
			Date.now(),
			input.kind,
			input.eventKey,
			input.idUser,
		)
		.run();
}

/** Users already claimed for an event, sent or not: never asked again. */
export async function claimedAlertUsers(input: {
	db: D1Database;
	kind: TAlertKind;
	eventKey: string;
}): Promise<Set<string>> {
	const { results } = await input.db
		.prepare("select idUser from alertSends where kind = ? and eventKey = ?")
		.bind(input.kind, input.eventKey)
		.all<{ idUser: string }>();
	return new Set(results.map((r) => r.idUser));
}

/**
 * Record the events the sweep can see now and return each one's firstSeenAt.
 * The first time a kind is seen at all, everything present is recorded at 0,
 * the baseline: it existed before alerts did and is never sent.
 */
export async function observeAlertEvents(input: {
	db: D1Database;
	kind: TAlertKind;
	eventKeys: string[];
	now: number;
}): Promise<Map<string, number>> {
	if (input.eventKeys.length === 0) return new Map();
	const any = await input.db
		.prepare("select 1 as one from alertEvents where kind = ? limit 1")
		.bind(input.kind)
		.first<{ one: number }>();
	const seenAt = any === null ? 0 : input.now;
	await input.db.batch(
		input.eventKeys.map((key) =>
			input.db
				.prepare(
					`insert into alertEvents (kind, eventKey, firstSeenAt) values (?, ?, ?)
					 on conflict (kind, eventKey) do nothing`,
				)
				.bind(input.kind, key, seenAt),
		),
	);
	const placeholders = input.eventKeys.map(() => "?").join(", ");
	const { results } = await input.db
		.prepare(
			`select eventKey, firstSeenAt from alertEvents where kind = ? and eventKey in (${placeholders})`,
		)
		.bind(input.kind, ...input.eventKeys)
		.all<{ eventKey: string; firstSeenAt: number }>();
	return new Map(results.map((r) => [r.eventKey, r.firstSeenAt]));
}

// ── Sign-ups from outside Markets (double opt-in) ────────────────────────────

export type TAlertSignup = {
	email: string;
	rundown: boolean;
	auctions: boolean;
	source: string | null;
};

export async function countAlertSignups(input: {
	db: D1Database;
	by: "ipAddress" | "email";
	value: string;
	sinceMs: number;
}): Promise<number> {
	const row = await input.db
		.prepare(
			`select count(*) as n from alertSignups where ${input.by === "email" ? "email" : "ipAddress"} = ? and createdAt >= ?`,
		)
		.bind(input.value, input.sinceMs)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export async function createAlertSignup(input: {
	db: D1Database;
	idAlertSignup: string;
	signup: TAlertSignup;
	ipAddress: string | null;
	ttlMs: number;
}) {
	const now = Date.now();
	await input.db
		.prepare(
			`insert into alertSignups (idAlertSignup, email, rundown, auctions, source, ipAddress, createdAt, expiresAt)
			 values (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.idAlertSignup,
			input.signup.email,
			input.signup.rundown ? 1 : 0,
			input.signup.auctions ? 1 : 0,
			input.signup.source,
			input.ipAddress,
			now,
			now + input.ttlMs,
		)
		.run();
}

/** Mark a sign-up confirmed and return it; null if unknown, expired or used. */
export async function confirmAlertSignup(input: {
	db: D1Database;
	idAlertSignup: string;
}): Promise<TAlertSignup | null> {
	const now = Date.now();
	const row = await input.db
		.prepare(
			`update alertSignups set confirmedAt = ?
			  where idAlertSignup = ? and confirmedAt is null and expiresAt > ?
			  returning email, rundown, auctions, source`,
		)
		.bind(now, input.idAlertSignup, now)
		.first<{
			email: string;
			rundown: number;
			auctions: number;
			source: string | null;
		}>();
	return row
		? {
				email: row.email,
				rundown: row.rundown === 1,
				auctions: row.auctions === 1,
				source: row.source,
			}
		: null;
}

/** A confirmed sign-up by id, for applying its choices once signed in. */
export async function getConfirmedAlertSignup(input: {
	db: D1Database;
	idAlertSignup: string;
}): Promise<TAlertSignup | null> {
	const row = await input.db
		.prepare(
			`select email, rundown, auctions, source from alertSignups
			  where idAlertSignup = ? and confirmedAt is not null`,
		)
		.bind(input.idAlertSignup)
		.first<{
			email: string;
			rundown: number;
			auctions: number;
			source: string | null;
		}>();
	return row
		? {
				email: row.email,
				rundown: row.rundown === 1,
				auctions: row.auctions === 1,
				source: row.source,
			}
		: null;
}

/** Forget a sign-up whose confirmation could not be sent, so a retry sends one. */
export async function deleteAlertSignup(input: {
	db: D1Database;
	idAlertSignup: string;
}) {
	await input.db
		.prepare("delete from alertSignups where idAlertSignup = ?")
		.bind(input.idAlertSignup)
		.run();
}
