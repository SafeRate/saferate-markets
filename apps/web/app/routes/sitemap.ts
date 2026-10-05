import { PUBLIC_TWIN_PATHS } from "@/lib/publicPages";
import { canonicalOrigin } from "@/lib/canonicalOrigin";
import type { Route } from "./+types/sitemap";

/**
 * sitemap.xml: every public page, from the one list the markdown twins and
 * the Cloudflare rule use (lib/publicPages.ts), so a page cannot be in one and
 * missing from another. The HTML pages only: each twin names its page as
 * canonical, so listing the twins would list duplicates.
 */
export const loader = ({ request, context }: Route.LoaderArgs) => {
	const origin = canonicalOrigin(context.cloudflare.env, request);
	const urls = PUBLIC_TWIN_PATHS.map(
		(path) => `  <url><loc>${origin}${path}</loc></url>`,
	).join("\n");
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`,
		{
			headers: {
				"Content-Type": "application/xml; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
			},
		},
	);
};
