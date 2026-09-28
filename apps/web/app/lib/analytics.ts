import {
	isPathPublic,
	TRACKING_TOOLS,
	type TTrackingTool,
	trackingToolsFor,
} from "@markets/schema";

// Ported from saferate-oklocate apps/web/app/lib/analytics.ts (2026-09-28),
// including the gtag `arguments` trap it measured.

/**
 * Resolving which analytics tools actually run, and loading them.
 *
 * ONE rule holds this together: a tool runs only if `resolveTrackingTools`
 * returns it. The privacy policy renders from the same call, so the script and
 * the disclosure cannot disagree — there is no boolean anywhere saying "we use
 * Google Analytics" that could be true while the tag is absent, or false while
 * it is present.
 *
 * Four gates, all of which must pass:
 *
 *   1. A measurement id is configured for this environment. Absent means off,
 *      which is why staging and dev carry empty vars rather than real ones — a
 *      staging visit must never land in the production property.
 *   2. The visitor has not opted out. Read server-side from a cookie so the
 *      script is never sent, rather than loaded and then told to be quiet.
 *   3. The visitor is not signalling Global Privacy Control.
 *   4. The path is public. See the note on client navigation below.
 *
 * NEVER paste a vendor's snippet into root.tsx or a layout instead. The raw
 * snippet Google and Microsoft hand you bypasses all four gates.
 */

export type TResolvedTrackingTool = {
	tool: TTrackingTool;
	/** Measurement id (GA) or project id (Clarity). Never empty. */
	idMeasurement: string;
};

/**
 * Where each tool's id comes from, named explicitly rather than by indexing the
 * env with a string from the catalog.
 *
 * Explicit because it is typed: `wrangler types` knows these vars, so a typo is
 * a compile error. It also keeps Cloudflare binding names out of
 * packages/schema, which should describe the policy and not the deployment.
 * Adding a tool without a resolver here means it simply never loads, which is
 * the right failure direction.
 */
const ID_RESOLVERS: Record<string, (env: TAnalyticsEnv) => string | undefined> =
	{
		googleAnalytics: (env) => env.GA_MEASUREMENT_ID,
		microsoftClarity: (env) => env.CLARITY_PROJECT_ID,
	};

/**
 * Read as loose strings rather than `Env`, for the reason `getIsIndexable`
 * takes the same shape: `wrangler types` narrows a var declared as "" to the
 * literal `""`, so typing against Env would make every comparison unsatisfiable
 * the moment a real id is filled in.
 */
export type TAnalyticsEnv = {
	GA_MEASUREMENT_ID?: string;
	CLARITY_PROJECT_ID?: string;
};

/** Tools with an id configured for this environment. Order follows the catalog. */
export const resolveTrackingTools = (
	env: TAnalyticsEnv,
): TResolvedTrackingTool[] => {
	const resolved: TResolvedTrackingTool[] = [];
	for (const tool of TRACKING_TOOLS) {
		const idMeasurement = ID_RESOLVERS[tool.id]?.(env)?.trim();
		if (idMeasurement) resolved.push({ tool, idMeasurement });
	}
	return resolved;
};

/**
 * Which resolved tools may load on a path. Delegates the path rule to
 * `trackingToolsFor` so this file does not keep a second copy of it.
 */
export const trackingToolsForPath = (
	resolved: TResolvedTrackingTool[],
	pathname: string | null | undefined,
) => {
	const allowed = new Set(
		trackingToolsFor(
			resolved.map((r) => r.tool),
			pathname,
		).map((t) => t.id),
	);
	return resolved.filter((r) => allowed.has(r.tool.id));
};

/* ────────────────────────────────────────────────────────────────────────────
 * Loading, client side only
 *
 * Nothing is injected during SSR, and that is deliberate rather than a
 * limitation. A script tag in the server-rendered HTML would still be in the
 * document after a client-side navigation from a marketing page into
 * /dashboard, because React Router does not re-run the root loader on every
 * navigation. The tag would then be recording the one page it must never see.
 *
 * So the decision is re-made on every location change, in the browser, against
 * the current pathname. Entering a non-public page calls each vendor's
 * documented off switch; returning to a public one re-enables.
 * ──────────────────────────────────────────────────────────────────────────── */

type TWindowAnalytics = {
	dataLayer?: unknown[];
	gtag?: (...args: unknown[]) => void;
	clarity?: ((...args: unknown[]) => void) & { q?: unknown[] };
} & Record<string, unknown>;

/**
 * The one cast in this file.
 *
 * Both vendors communicate through globals, and GA's off switch is a key built
 * from the measurement id (`ga-disable-G-XXXX`), so an index signature is
 * unavoidable. Narrowing it to a single accessor keeps that looseness in one
 * place instead of at four call sites.
 */
const analyticsWindow = () => window as unknown as TWindowAnalytics;

const loaded = new Set<string>();

/**
 * No public page on this site carries visitor input in its URL (the only such
 * URL, the magic-link callback, is under /api/auth and never public). OKLocate
 * redacts ?address= here; there is nothing to redact, so the plain location is
 * sent. Revisit if a public page ever takes input in its query string.
 */
const sanitizedHref = () => window.location.href;

const injectScript = (src: string, id: string) => {
	const script = document.createElement("script");
	script.async = true;
	script.src = src;
	script.dataset.marketsAnalytics = id;
	document.head.appendChild(script);
};

/**
 * Google Analytics 4.
 *
 * The three config flags are not cosmetic. Left at their defaults, GA feeds
 * Google's advertising products, and THAT is what turns a service-provider
 * arrangement into "sharing" under California law. Turning them off here means
 * the code enforces what the privacy policy claims, rather than depending on
 * someone not changing a checkbox in the Google Analytics console.
 */
const startGoogleAnalytics = (idMeasurement: string) => {
	const w = analyticsWindow();
	w[`ga-disable-${idMeasurement}`] = false;
	if (loaded.has(idMeasurement)) return;
	loaded.add(idMeasurement);

	w.dataLayer = w.dataLayer || [];

	/**
	 * A `function` pushing `arguments`, NOT an arrow pushing a rest array.
	 *
	 * This is not style, and getting it wrong is silent. gtag.js decides whether
	 * a dataLayer entry is a COMMAND by checking it is an Arguments object; a
	 * plain Array is ignored as a command and treated as data. Written as an
	 * arrow with `...args` the tag loaded, initialised, threw nothing, and sent
	 * Google exactly zero events — the console said "Data collection isn't
	 * active" and the page looked perfect. Measured 2026-09-02: dataLayer held
	 * [object Array] entries and there were 0 requests to /g/collect.
	 *
	 * The vendor snippet's `arguments` is the load-bearing part of it.
	 */
	function gtag(..._args: unknown[]) {
		// biome-ignore lint/complexity/noArguments: a rest array is silently ignored by gtag.js
		w.dataLayer?.push(arguments);
	}
	w.gtag = gtag;
	gtag("js", new Date());
	gtag("config", idMeasurement, {
		/*
		 * Advertising features OFF in code, not by a console checkbox. Left on,
		 * the data feeds Google's ad products, which is what turns a
		 * service-provider arrangement into "sharing" under the CPRA.
		 */
		allow_google_signals: false,
		allow_ad_personalization_signals: false,
		// anonymize_ip is deliberately absent: a Universal Analytics parameter
		// GA4 ignores, and passing it would imply a control we do not have.
		page_location: sanitizedHref(),
	});
	injectScript(
		`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(idMeasurement)}`,
		idMeasurement,
	);
};

const stopGoogleAnalytics = (idMeasurement: string) => {
	analyticsWindow()[`ga-disable-${idMeasurement}`] = true;
};

/**
 * Microsoft Clarity.
 *
 * The queue shim is Clarity's own documented bootstrap: calls made before the
 * tag arrives are buffered on `clarity.q`. Written out rather than pasted as
 * the minified snippet so that what it does is reviewable.
 */
const startMicrosoftClarity = (idProject: string) => {
	const w = analyticsWindow();
	if (loaded.has(idProject)) {
		w.clarity?.("start");
		return;
	}
	loaded.add(idProject);

	const queued = ((...args: unknown[]) => {
		queued.q = queued.q || [];
		queued.q.push(args);
	}) as NonNullable<TWindowAnalytics["clarity"]>;
	w.clarity = w.clarity || queued;
	injectScript(
		`https://www.clarity.ms/tag/${encodeURIComponent(idProject)}`,
		idProject,
	);
};

const stopMicrosoftClarity = () => {
	analyticsWindow().clarity?.("stop");
};

/** Start a resolved tool. Unknown ids do nothing, which is the safe direction. */
export const startTrackingTool = ({
	tool,
	idMeasurement,
}: TResolvedTrackingTool) => {
	if (tool.id === "googleAnalytics") startGoogleAnalytics(idMeasurement);
	if (tool.id === "microsoftClarity") startMicrosoftClarity(idMeasurement);
};

export const stopTrackingTool = ({
	tool,
	idMeasurement,
}: TResolvedTrackingTool) => {
	if (tool.id === "googleAnalytics") stopGoogleAnalytics(idMeasurement);
	if (tool.id === "microsoftClarity") stopMicrosoftClarity();
};

/** Re-exported so a caller never reaches for its own path check. */
export { isPathPublic };
