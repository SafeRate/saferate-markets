/**
 * Report uncaught browser errors as `web-client` rows in `siteErrors`.
 *
 * Without this the site could not see a single exception thrown in a visitor's
 * browser: Clarity counts JavaScript errors but stores no content, and the
 * server sink only sees what reaches a Worker. Ported from saferate-oklocate,
 * which ported it from saferate-ai's
 * consumer app (`app/services/analytics/clientErrors.client.ts`), where the same
 * gap was closed on 2026-09-10; the rules below are its, and each one is there
 * because its absence produced a bad row.
 *
 * What is deliberately NOT sent:
 *   - No input values. Nothing here reads a field.
 *   - The page path WITHOUT its query string or hash, truncated.
 *   - Message and stack truncated here, and again server-side.
 */

const C_ENDPOINT = "/api/client-error";
const C_MAX_PER_PAGE = 5;
const C_MAX_MESSAGE = 500;
const C_MAX_STACK = 2000;

/**
 * Errors that are NOT ours, dropped BEFORE the cap — five slots per page means
 * every slot an extension takes is a real exception that never gets sent.
 * Match only on something the third party owns, and only once it has been seen
 * and traced; a guess belongs in the table where it can be reviewed.
 */
const C_NOT_OURS: { needles: string[]; why: string }[] = [
	{ needles: ["MethodName:", "ParamCount:"], why: "Office.js extension" },
	{ needles: ["chrome-extension://"], why: "browser extension bundle" },
	{ needles: ["moz-extension://"], why: "browser extension bundle" },
	{ needles: ["contentDocument.location"], why: "cross-origin frame probe" },
	{ needles: ["window.ethereum"], why: "crypto-wallet extension" },
	{
		needles: ["WKWebView API client did not respond"],
		why: "iOS in-app browser host script",
	},
];

const isNotOurs = (message: string, stack: string | null) => {
	const haystack = `${message}\n${stack ?? ""}`;
	return C_NOT_OURS.some((rule) =>
		rule.needles.every((needle) => haystack.includes(needle)),
	);
};

let isInstalled = false;
let sentCount = 0;
const seen = new Set<string>();

const safePage = () => {
	try {
		const { pathname } = window.location;
		return pathname.length > 120 ? `${pathname.slice(0, 120)}…` : pathname;
	} catch {
		return null;
	}
};

const report = (input: { message: string; stack: string | null }) => {
	if (sentCount >= C_MAX_PER_PAGE) return;
	const message = input.message.slice(0, C_MAX_MESSAGE);
	const stack = input.stack ? input.stack.slice(0, C_MAX_STACK) : null;
	if (isNotOurs(message, stack)) return;

	// Message plus first stack frame: one error from two call sites is two bugs,
	// the same error twice from one site is one.
	const signature = `${message}|${(stack ?? "").split("\n")[1] ?? ""}`;
	if (seen.has(signature)) return;
	seen.add(signature);
	sentCount += 1;

	try {
		void fetch(C_ENDPOINT, {
			body: JSON.stringify({ message, page: safePage(), stack }),
			headers: { "Content-Type": "application/json" },
			// An error thrown during navigation is exactly when the interesting
			// ones happen; keepalive lets the report outlive the page.
			keepalive: true,
			method: "POST",
		}).catch(() => {
			// A failed error report must never produce another error.
		});
	} catch {
		// Same.
	}
};

const errorLike = (value: unknown) => {
	if (typeof value !== "object" || value === null) return null;
	const { message, name, stack } = value as {
		message?: unknown;
		name?: unknown;
		stack?: unknown;
	};
	if (typeof message !== "string") return null;
	return {
		message: message || (typeof name === "string" && name ? name : "Error"),
		stack: typeof stack === "string" && stack ? stack : null,
	};
};

/**
 * An unhandled rejection's reason. Error-shaped values first: an Error from
 * another realm serialises as "{}" because its fields are non-enumerable.
 */
export const describeRejection = (reason: unknown) => {
	const like = errorLike(reason);
	if (like) {
		return { message: `Unhandled rejection: ${like.message}`, stack: like.stack };
	}
	let described = String(reason);
	if (typeof reason === "object" && reason !== null) {
		try {
			described = `${reason.constructor?.name ?? "object"}: ${JSON.stringify(reason)}`;
		} catch {
			// keep String(reason)
		}
	}
	return { message: `Unhandled rejection: ${described}`, stack: null };
};

/** A failure the app CAUGHT but still wants on record. */
export const reportHandledError = (input: {
	message: string;
	stack?: string | null;
}) => {
	report({ message: input.message, stack: input.stack ?? null });
};

/**
 * hydrateRoot's onRecoverableError: a hydration mismatch, with the component
 * stack that says WHICH node differed and the browser locale, the usual cause
 * of a number formatted differently on server and client.
 */
export const reportRecoverableError = (
	error: unknown,
	errorInfo: { componentStack?: string },
) => {
	const lang = typeof navigator === "undefined" ? "?" : navigator.language;
	const errorStack = error instanceof Error ? (error.stack ?? "") : "";
	report({
		message: error instanceof Error ? error.message : String(error),
		stack: [`lang=${lang}`, (errorInfo.componentStack ?? "").trim(), errorStack]
			.filter(Boolean)
			.join("\n"),
	});
};

/**
 * Installed from entry.client BEFORE hydrateRoot, so hydration errors have a
 * listener. Idempotent.
 */
export const startClientErrorReporting = () => {
	if (isInstalled || typeof window === "undefined") return;
	isInstalled = true;

	// `error` also fires for a failed <img>/<script>, as a plain Event with no
	// error attached. Those are resource 404s, not exceptions. Capture phase,
	// because resource errors do not bubble.
	window.addEventListener(
		"error",
		(event) => {
			try {
				if (!(event instanceof ErrorEvent)) return;
				const like = errorLike(event.error);
				const message = like
					? like.message
					: String(event.message || "unknown error");
				report({ message, stack: like?.stack ?? null });
			} catch {
				// never let the handler throw
			}
		},
		true,
	);

	window.addEventListener("unhandledrejection", (event) => {
		try {
			const described = describeRejection((event as PromiseRejectionEvent).reason);
			report(described);
		} catch {
			// never let the handler throw
		}
	});
};
