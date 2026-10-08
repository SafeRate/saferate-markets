/**
 * The public pages that have a markdown twin at `<path>.txt`.
 *
 * ONE LIST, read by three things that must agree: the twin route (which page a
 * `.txt` path renders), the worker (which HTML responses advertise their twin
 * with `Link: rel="alternate"`), and the Cloudflare rule that redirects
 * `Accept: text/markdown` to `<path>.txt` (its path list is this one; see
 * CLAUDE.md "Markdown twins"). A page left out of the rule but listed here is
 * only unadvertised; a page in the rule but missing here would send an agent
 * from a working page to a 404, which is why the rule is built from this list.
 *
 * The dashboard is not here: it is behind sign-in, and a twin would either
 * 404 or hand a signed-in page's content to anything that asked for markdown.
 */
export const PUBLIC_TWIN_PATHS = [
	"/",
	"/data",
	"/indices",
	"/capabilities",
	"/about",
	"/pricing",
	"/docs",
	"/docs/indices",
	"/terms",
	"/privacy",
	"/strategies",
	"/strategies/ladder-5y",
	"/strategies/t-bill-reinvestment",
	"/methodology/treasury-curve",
	"/curve/2s10s",
	"/curve/5s30s",
] as const;

export type TPublicTwinPath = (typeof PUBLIC_TWIN_PATHS)[number];

/** The `.txt` path of a page; the home page's is `/index.txt`. */
export const twinPathOf = (path: TPublicTwinPath) =>
	path === "/" ? "/index.txt" : `${path}.txt`;

/**
 * The page a `.txt` path is the twin of, or null. Accepts `/.txt` as the home
 * page too, which is what the Cloudflare rule produces for `/`
 * (`concat(path, ".txt")`), so one rule covers every page.
 */
export const pageOfTwinPath = (twinPath: string): TPublicTwinPath | null => {
	if (twinPath === "/.txt" || twinPath === "/index.txt") return "/";
	if (!twinPath.endsWith(".txt")) return null;
	const page = twinPath.slice(0, -".txt".length);
	return (PUBLIC_TWIN_PATHS as readonly string[]).includes(page)
		? (page as TPublicTwinPath)
		: null;
};
