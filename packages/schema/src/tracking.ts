import { z } from "zod";

/**
 * Third-party analytics: which tools exist, and where they may run. Ported from
 * saferate-oklocate packages/schema/src/legal.ts (its "four gates" design); the
 * legal copy was not ported, only the mechanism.
 *
 * Whether a tool RUNS is not decided here: there is no isActive flag. It runs
 * when its id is configured in the Worker's vars (apps/web lib/analytics.ts,
 * resolveTrackingTools) and the visitor has not opted out. A hand-set boolean is
 * the thing that gets flipped in one place and not the other.
 */

/**
 * Never public, so no third-party tag loads there. The keys page shows a new
 * API key in full exactly once, and a session recorder captures rendered text,
 * not just inputs; sign-in puts an email and a one-time link on screen.
 */
export const PATHS_NOT_PUBLIC = [
	"/dashboard",
	"/sign-in",
	"/sign-out",
	"/api/auth",
] as const;

const normalisePath = (pathname: string | null | undefined) => {
	if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
	const withoutQuery = pathname.split(/[?#]/)[0];
	return withoutQuery.toLowerCase().replace(/\/+$/, "") || "/";
};

const matchesPrefix = (path: string, prefixes: readonly string[]) =>
	prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

/**
 * Whether a path is a public marketing page. FAILS CLOSED: an empty, relative or
 * unparseable path is non-public, because guessing wrong one way costs a missed
 * pageview and the other way a recorded credential. Case and a trailing slash
 * are normalised, so /Dashboard/ is not a way round it.
 */
export const isPathPublic = (pathname: string | null | undefined) => {
	const path = normalisePath(pathname);
	if (path === null) return false;
	return !matchesPrefix(path, PATHS_NOT_PUBLIC);
};

export const ZTrackingTool = z.object({
	id: z.enum(["googleAnalytics", "microsoftClarity"]),
	name: z.string().min(1),
	vendor: z.string().min(1),
	kind: z.enum(["analytics", "session_replay"]),
	purpose: z.string().min(1),
	/** public_pages: only where isPathPublic is true. */
	scope: z.enum(["public_pages"]),
});
export type TTrackingTool = z.infer<typeof ZTrackingTool>;

export const TRACKING_TOOLS: readonly TTrackingTool[] = [
	ZTrackingTool.parse({
		id: "googleAnalytics",
		name: "Google Analytics",
		vendor: "Google LLC",
		kind: "analytics",
		purpose: "Which pages people visit and how they arrived.",
		scope: "public_pages",
	}),
	ZTrackingTool.parse({
		id: "microsoftClarity",
		name: "Microsoft Clarity",
		vendor: "Microsoft Corporation",
		kind: "session_replay",
		purpose:
			"Aggregate heatmaps and session replays, to see where a page confuses people.",
		scope: "public_pages",
	}),
];

/** The tools allowed on a path, from those configured. */
export const trackingToolsFor = (
	active: readonly TTrackingTool[],
	pathname: string | null | undefined,
) => active.filter((t) => t.scope === "public_pages" && isPathPublic(pathname));
