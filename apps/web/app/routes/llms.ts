import { API_SURFACES, PRODUCT_NAME, SITE_HOSTS } from "@markets/schema";
import { pageMetaOf } from "@/lib/publicPageModules.server";
import { PUBLIC_TWIN_PATHS, twinPathOf } from "@/lib/publicPages";
import { canonicalOrigin } from "@/lib/canonicalOrigin";
import type { Route } from "./+types/llms";

/**
 * llms.txt: the index an AI agent reads first. Each public page with its
 * markdown version, its title and description read from the page's own meta
 * (lib/publicPageModules.server.ts), and the API and MCP, whose routes and
 * tools come from API_SURFACES. Nothing here is a second copy of a page.
 */
export const loader = ({ request, context }: Route.LoaderArgs) => {
	const origin = canonicalOrigin(context.cloudflare.env, request);
	const api = SITE_HOSTS.production.api;
	const pages = PUBLIC_TWIN_PATHS.map((path) => {
		const { title, description } = pageMetaOf(path);
		const name = title.replace(/\s*\|\s*Safe Rate Markets$/, "");
		return `- [${name}](${origin}${twinPathOf(path)})${description ? `: ${description}` : ""}`;
	}).join("\n");
	const tools = [
		...new Set(
			API_SURFACES.flatMap((s) => (s.tool ?? "").split(", ")).filter(Boolean),
		),
	];
	const body = `# ${PRODUCT_NAME}

> Portfolio management and data for the U.S. Treasury market: every marketable Treasury priced daily since September 2008, fitted yield curves, analytics, rich/cheap, auctions and eleven total-return indices, from primary sources, with a REST API and an MCP server.

Every page below is linked to its markdown version; the HTML page is the same path without \`.txt\`.

## Pages

${pages}

## API and MCP

- REST API: ${api}, with an OpenAPI reference at ${api}/openapi.json. Bearer key from a plan (${origin}/pricing).
- MCP server: ${api}/mcp, the same key. Tools: ${tools.join(", ")}.
- Documentation: ${origin}${twinPathOf("/docs")}

## Interactive views

Most of this data can also be explored, free, at https://saferate.com/treasury.
`;
	return new Response(body, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
};
