import { z } from "zod";

/**
 * The customer journey, first-party (migration 0011): `visitors` and `events`.
 *
 * ONE copy of these INSERTs, shared by apps/web and apps/api, for the reason the
 * error sink has one (siteErrors.ts): every extra copy is a place the schema drifts.
 *
 * Best-effort and non-blocking BY CONTRACT, like the sink. With a `ctx` the write
 * rides `waitUntil`; without one (a Better Auth hook, which has none) it is awaited
 * but still never throws. Analytics must never fail the request it describes.
 *
 * THE CATALOG IS THE SCHEMA. Every event name is declared below with the props it
 * may carry, and a write whose props do not parse is dropped with a log line rather
 * than stored. That is what keeps `propsJson` queryable years from now: no free
 * text, no personal data, a known shape per name. Adding an event means adding it
 * here, which is also where its privacy class is decided.
 */

const ZShort = z.string().min(1).max(120);

/**
 * BEHAVIOURAL events record what a person looked at or tried, and are written only
 * when analytics is permitted (no opt-out cookie, no GPC). MILESTONE events mirror a
 * record the account already owns in this database — a key, a portfolio, a
 * subscription — and are always written, with no visitor id when not permitted.
 */
export const C_EVENTS = {
	alert_preferences_changed: {
		kind: "milestone",
		props: z.object({
			auctionAnnouncements: z.boolean(),
			auctionResults: z.boolean(),
			paused: z.boolean(),
			rundown: z.boolean(),
			termCount: z.number().int().nullable(),
		}),
	},
	alert_signup: {
		kind: "milestone",
		props: z.object({
			auctions: z.boolean(),
			rundown: z.boolean(),
			source: ZShort.nullable(),
		}),
	},
	alert_signup_confirmed: { kind: "milestone", props: z.object({}) },
	alert_unsubscribed: { kind: "milestone", props: z.object({ scope: ZShort }) },
	api_key_created: { kind: "milestone", props: z.object({}) },
	api_key_first_used: {
		kind: "milestone",
		props: z.object({ operation: ZShort, surface: ZShort }),
	},
	api_key_revoked: { kind: "milestone", props: z.object({}) },
	api_key_rotated: { kind: "milestone", props: z.object({}) },
	backtest_run: {
		kind: "behavioural",
		props: z.object({
			frequency: ZShort,
			strategies: z.number().int(),
			strategy: ZShort,
			years: z.number().nullable(),
		}),
	},
	checkout_returned: {
		kind: "behavioural",
		props: z.object({ outcome: z.enum(["done", "cancelled"]) }),
	},
	checkout_started: { kind: "behavioural", props: z.object({ plan: ZShort }) },
	liability_stream_created: { kind: "milestone", props: z.object({}) },
	login: { kind: "milestone", props: z.object({}) },
	magic_link_requested: {
		kind: "behavioural",
		props: z.object({ status: ZShort }),
	},
	organization_created: {
		kind: "milestone",
		props: z.object({ trialEndsAt: z.number().int().nullable() }),
	},
	page_view: {
		kind: "behavioural",
		props: z.object({
			referrerHost: ZShort.nullable(),
			status: z.number().int(),
			utmCampaign: ZShort.nullable(),
			utmMedium: ZShort.nullable(),
			utmSource: ZShort.nullable(),
		}),
	},
	plan_built: {
		kind: "behavioural",
		props: z.object({
			method: ZShort,
			status: z.enum(["planned", "failed", "empty"]),
		}),
	},
	plan_orders_exported: { kind: "behavioural", props: z.object({}) },
	plan_saved: { kind: "milestone", props: z.object({ method: ZShort }) },
	portfolio_created: { kind: "milestone", props: z.object({}) },
	portfolio_deleted: { kind: "milestone", props: z.object({}) },
	sign_up: { kind: "milestone", props: z.object({}) },
	subscription_changed: {
		kind: "milestone",
		props: z.object({
			cancelsAt: z.number().int().nullable(),
			plan: ZShort.nullable(),
			status: ZShort,
		}),
	},
	transaction_added: { kind: "milestone", props: z.object({}) },
	transactions_imported: {
		kind: "milestone",
		props: z.object({ rows: z.number().int() }),
	},
} as const;

export type TEventName = keyof typeof C_EVENTS;
export const ZEventName = z.enum(
	Object.keys(C_EVENTS) as [TEventName, ...TEventName[]],
);
export type TEventProps<N extends TEventName> = z.input<
	(typeof C_EVENTS)[N]["props"]
>;
export const isBehaviouralEvent = (name: TEventName) =>
	C_EVENTS[name].kind === "behavioural";

export const ZEventSource = z.enum(["web", "api", "webhook", "email", "cron"]);

const C_MAX_PATH = 200;

/**
 * A path as a route PATTERN, the way usage records store `/v1/securities/:cusip`.
 *
 * ⚠️ /privacy promises "Looking a security up, in the dashboard or the API, is not
 * recorded": which securities a customer looks at is commercially revealing. A
 * literal `/dashboard/securities/91282CRZ9` page view would break that promise, so
 * the CUSIP segment is replaced before anything is stored, and so is every UUID
 * (portfolio, plan, liability stream) so paths aggregate. Query strings were never
 * kept. Applied to every event and to a visitor's landing path.
 */
export const normalizeEventPath = (path: string) =>
	(path.split(/[?#]/)[0] ?? "")
		.replace(/\/securities\/[^/]+/g, "/securities/:cusip")
		.replace(
			/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi,
			"/:id",
		)
		.slice(0, C_MAX_PATH);

type TWaiter = { waitUntil: (promise: Promise<unknown>) => void };

/** Run a write without ever throwing into the caller, in the background if we can. */
const runQuietly = async (
	ctx: TWaiter | undefined,
	label: string,
	work: () => Promise<unknown>,
) => {
	const guarded = work().catch((error) =>
		console.error(`[events] ${label} failed:`, error),
	);
	if (ctx) ctx.waitUntil(guarded);
	else await guarded;
};

/**
 * One event. Props are parsed against the catalog first; a mismatch is a bug in the
 * caller, so it is logged loudly and NOT written — a malformed row would poison every
 * query that reads that event's props.
 */
export const recordEvent = async <N extends TEventName>(
	_input: TInputRecordEvent & { name: N; props: TEventProps<N> },
) => {
	const input = ZInputRecordEvent.parse(_input);
	if (!input.db) return;
	const db = input.db;
	const props = C_EVENTS[input.name].props.safeParse(input.props);
	if (!props.success) {
		console.error(
			`[events] ${input.name} props rejected:`,
			props.error.issues.slice(0, 3),
		);
		return;
	}
	const path = input.path ? normalizeEventPath(input.path) : null;
	await runQuietly(input.ctx, input.name, () =>
		db
			.prepare(
				/* sql */ "insert into events (idEvent, name, occurredAt, idVisitor, idUser, idOrganization, path, source, propsJson) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(
				crypto.randomUUID(),
				input.name,
				input.occurredAt ?? Date.now(),
				input.idVisitor ?? null,
				input.idUser ?? null,
				input.idOrganization ?? null,
				path,
				input.source,
				Object.keys(props.data).length ? JSON.stringify(props.data) : null,
			)
			.run(),
	);
};

/** A new visitor's first touch. `insert or ignore`: a visitor's first touch never changes. */
export const recordVisitor = async (_input: TInputRecordVisitor) => {
	const input = ZInputRecordVisitor.parse(_input);
	if (!input.db) return;
	const db = input.db;
	const t = input.touch;
	await runQuietly(input.ctx, "visitor", () =>
		db
			.prepare(
				/* sql */ `insert or ignore into visitors (idVisitor, firstSeenAt, landingPath, referrerHost, utmSource, utmMedium, utmCampaign, utmTerm, utmContent, clickIdKind, country)
				values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.idVisitor,
				Date.now(),
				t.landingPath === null ? null : normalizeEventPath(t.landingPath),
				t.referrerHost,
				t.utmSource,
				t.utmMedium,
				t.utmCampaign,
				t.utmTerm,
				t.utmContent,
				t.clickIdKind,
				t.country,
			)
			.run(),
	);
};

/**
 * Join a browser to the account it signed into: the one link that turns anonymous
 * visits into a customer's history. Set once — a visitor already linked to a user
 * keeps that user, so a shared machine cannot rewrite someone else's past.
 */
export const linkVisitorToUser = async (_input: TInputLinkVisitorToUser) => {
	const input = ZInputLinkVisitorToUser.parse(_input);
	if (!input.db) return;
	const db = input.db;
	await runQuietly(input.ctx, "visitor link", () =>
		db
			.prepare(
				/* sql */ "update visitors set idUser = ?, linkedAt = ? where idVisitor = ? and idUser is null",
			)
			.bind(input.idUser, Date.now(), input.idVisitor)
			.run(),
	);
};

export const ZTouch = z.object({
	clickIdKind: z.enum(["gclid", "fbclid", "msclkid", "li_fat_id"]).nullable(),
	country: z.string().length(2).nullable(),
	landingPath: z.string().max(C_MAX_PATH).nullable(),
	referrerHost: z.string().max(255).nullable(),
	utmCampaign: z.string().max(120).nullable(),
	utmContent: z.string().max(120).nullable(),
	utmMedium: z.string().max(120).nullable(),
	utmSource: z.string().max(120).nullable(),
	utmTerm: z.string().max(120).nullable(),
});
export type TTouch = z.infer<typeof ZTouch>;

const ZWaiter = z.custom<TWaiter>(
	(v) => typeof v === "object" && v !== null && "waitUntil" in v,
);
const ZDb = z.custom<D1Database>().optional();

const ZInputRecordEvent = z.object({
	ctx: ZWaiter.optional(),
	db: ZDb,
	idOrganization: z.string().nullable().optional(),
	idUser: z.string().nullable().optional(),
	idVisitor: z.string().nullable().optional(),
	name: ZEventName,
	occurredAt: z.number().int().optional(),
	path: z.string().nullable().optional(),
	props: z.record(
		z.string(),
		z.union([z.string(), z.number(), z.boolean(), z.null()]),
	),
	source: ZEventSource,
});
type TInputRecordEvent = Omit<
	z.input<typeof ZInputRecordEvent>,
	"name" | "props"
>;

const ZInputRecordVisitor = z.object({
	ctx: ZWaiter.optional(),
	db: ZDb,
	idVisitor: z.string().uuid(),
	touch: ZTouch,
});
type TInputRecordVisitor = z.input<typeof ZInputRecordVisitor>;

const ZInputLinkVisitorToUser = z.object({
	ctx: ZWaiter.optional(),
	db: ZDb,
	idUser: z.string().min(1),
	idVisitor: z.string().uuid(),
});
type TInputLinkVisitorToUser = z.input<typeof ZInputLinkVisitorToUser>;
