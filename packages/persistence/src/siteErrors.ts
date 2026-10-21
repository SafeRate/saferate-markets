import { z } from "zod";

/**
 * The error sink: one `siteErrors` row per failure (migration 0010), from both
 * Workers and the visitor's browser. The saferate-ai daily report reads these
 * rows into Markets' agenda; they outlive Workers Logs' 7-day retention.
 *
 * ONE copy of this INSERT, here, shared by apps/web and apps/api. saferate-ai's
 * consumer app learned why: its column list changed once, and every extra copy
 * of an INSERT is a place the schema drifts silently.
 *
 * Best-effort and non-blocking BY CONTRACT. It takes `ctx.waitUntil` so no
 * caller awaits the write, and it swallows its own failure to the console. A
 * sink that can break the request it is describing is worse than no sink, and
 * every call site is on the hot path.
 */

export const ZCodeSiteError = z.enum([
	"web-render",
	"web-server",
	"web-cron",
	"web-client",
	"api-server",
]);
export type TCodeSiteError = z.infer<typeof ZCodeSiteError>;

const C_MAX_MESSAGE = 1000;
const C_MAX_STACK = 4000;
const C_MAX_PATH = 200;

/**
 * Requests that already produced a row, so the status fallback in
 * apps/web/workers/app.ts does not re-record what handleError captured with a
 * stack. Both run in one isolate for one Request object, and a WeakSet keeps no
 * request alive past its own lifetime. Without it, one failing loader writes
 * two rows and every count the report prints doubles.
 */
const recordedRequests = new WeakSet<Request>();

export const wasSiteErrorRecorded = (request: Request) =>
	recordedRequests.has(request);

/**
 * The path only: never the query string, which can carry an address, an email
 * or an API key, none of which belong in an error table.
 */
const pathOf = (
	request: Request | null,
	override: string | null | undefined,
) => {
	// `null` is a deliberate "no path" (a browser report that named no page);
	// only an ABSENT override falls back to the request. Treating null as absent
	// filed every page-less browser report under the beacon endpoint's own path.
	if (override === null) return null;
	if (override !== undefined) return override.slice(0, C_MAX_PATH);
	if (!request) return null;
	try {
		return new URL(request.url).pathname.slice(0, C_MAX_PATH);
	} catch {
		return null;
	}
};

export const recordSiteError = (_input: TInputRecordSiteError) => {
	const input = ZInputRecordSiteError.parse(_input);
	// Mark before the early return: "this request was handled" must not depend
	// on whether the binding happened to be present.
	if (input.request) recordedRequests.add(input.request);
	if (!input.db) return;
	const db = input.db;

	input.ctx.waitUntil(
		(async () => {
			try {
				await db
					.prepare(
						/* sql */ "insert into siteErrors (idSiteError, code, path, message, stack, cfRay, createdAt) values (?, ?, ?, ?, ?, ?, ?)",
					)
					.bind(
						crypto.randomUUID(),
						input.code,
						pathOf(input.request, input.path),
						input.message.slice(0, C_MAX_MESSAGE),
						input.stack ? input.stack.slice(0, C_MAX_STACK) : null,
						input.request?.headers.get("cf-ray") ?? null,
						Date.now(),
					)
					.run();
			} catch (error) {
				console.error("[siteErrors] insert failed:", error);
			}
		})(),
	);
};

/**
 * An unknown thrown value as a message/stack pair.
 *
 * `String(err)` renders a plain object as "[object Object]", which the consumer
 * app's sink recorded within minutes of going live and which says nothing. So a
 * non-Error is serialised, prefixed with its constructor name, and falls back to
 * String() for what JSON cannot hold (circular references, BigInt, symbols).
 */
export const describeThrown = (error: unknown) => {
	if (error instanceof Error) {
		return { message: error.message, stack: error.stack ?? null };
	}
	let message = String(error);
	if (typeof error === "object" && error !== null) {
		try {
			message = `${error.constructor?.name ?? "object"}: ${JSON.stringify(error)}`;
		} catch {
			// keep String(error)
		}
	}
	return { message, stack: null };
};

const ZInputRecordSiteError = z.object({
	code: ZCodeSiteError,
	/** Only `waitUntil` is used, so Hono's executionCtx fits as well as a Worker's. */
	ctx: z.custom<{ waitUntil: (promise: Promise<unknown>) => void }>(
		(v) => v !== null && v !== undefined,
	),
	/** Absent in a dev or test environment without the binding: nothing is written. */
	db: z.custom<D1Database>().optional(),
	message: z.string(),
	/**
	 * Overrides the request's path, for a browser report naming its own page.
	 * Omitted: the request's path. `null`: no path at all.
	 */
	path: z.string().nullable().optional(),
	/** Null for the cron, which has no request. */
	request: z.custom<Request>().nullable(),
	stack: z.string().nullable().default(null),
});
type TInputRecordSiteError = z.input<typeof ZInputRecordSiteError>;
