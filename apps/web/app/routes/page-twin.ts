import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createStaticHandler,
	createStaticRouter,
	data,
	StaticRouterProvider,
} from "react-router";
import { htmlToMarkdown } from "@/lib/htmlToMarkdown";
import { PUBLIC_PAGE_MODULES } from "@/lib/publicPageModules.server";
import { pageOfTwinPath } from "@/lib/publicPages";
import type { Route } from "./+types/page-twin";

/**
 * The markdown twin of a public page, at `<path>.txt` (`/index.txt` and
 * `/.txt` for the home page): what an AI agent gets when it asks for
 * `Accept: text/markdown` (the Cloudflare rule redirects it here) or follows
 * the `Link: rel="alternate"` the HTML page sends.
 *
 * THE TWIN IS THE PAGE. It runs the page's own loader and renders the page's
 * own component, then converts the markup, so the two cannot drift: there is
 * no second copy of any sentence or figure to forget to update. (saferate.com
 * reuses its HTML loaders for the same reason; Markets goes one step further
 * because its public pages are few and simply built.)
 *
 * RENDERED IN A STATIC DATA ROUTER, not a bare MemoryRouter: the framework
 * wraps each route's default export so it reads its props through
 * useLoaderData, which throws outside a data router (found on the first
 * staging deploy, every twin a 500). A one-route static router whose loader
 * returns the data already loaded gives the wrapper what it reads, and <Link>
 * on the legal pages its context.
 *
 * Served as text/markdown with `Link: rel="canonical"` back to the HTML page,
 * as saferate.com's markdownResponse does, so a search engine consolidates on
 * the page rather than indexing the twin as a duplicate.
 */
export const loader = async (args: Route.LoaderArgs) => {
	const url = new URL(args.request.url);
	const path = pageOfTwinPath(url.pathname);
	if (path === null) throw data("Not found", { status: 404 });
	const page = PUBLIC_PAGE_MODULES[path];
	const loaderData = page.loader ? await page.loader(args as never) : undefined;
	if (loaderData instanceof Response) return loaderData;

	const handler = createStaticHandler([
		{ id: "page", path, Component: page.default, loader: () => loaderData },
	]);
	const context = await handler.query(new Request(`${url.origin}${path}`));
	if (context instanceof Response) return context;
	const html = renderToStaticMarkup(
		createElement(StaticRouterProvider, {
			router: createStaticRouter(handler.dataRoutes, context),
			context,
			hydrate: false,
		}),
	);
	const canonical = `${url.origin}${path}`;
	const body = `> The markdown version of ${canonical}\n\n${htmlToMarkdown(html, url.origin)}\n`;
	return new Response(body, {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			Link: `<${canonical}>; rel="canonical"`,
			// The home page and Indices carry the day's figures; an hour is fresh
			// enough for an agent and spares a re-render per request.
			"Cache-Control": "public, max-age=900, stale-while-revalidate=3600",
		},
	});
};
