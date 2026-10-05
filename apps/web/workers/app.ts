import { createRequestHandler } from "react-router";
import { canonicalHostRedirect } from "@/lib/canonicalHost";
import { PUBLIC_TWIN_PATHS, twinPathOf } from "@/lib/publicPages";
import { getAuth } from "@/services/auth.server";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

export default {
	async fetch(request, env, ctx) {
		// FIRST, before auth: a magic link must never be built on, or land on, a
		// redirect-only host, or its single-use token is spent on the redirect.
		const redirect = canonicalHostRedirect(request);
		if (redirect) return redirect;

		// Better Auth owns /api/auth/*: the magic-link callback, session reads,
		// sign-out. Ahead of the router because it needs the raw Request and
		// returns its own Response with Set-Cookie headers.
		const url = new URL(request.url);
		if (url.pathname.startsWith("/api/auth/")) {
			try {
				return await getAuth({ env, request }).handler(request);
			} catch (error) {
				// Auth could not even be constructed: a missing secret or DB binding.
				console.error("[auth] handler failed", url.pathname, error);
				return new Response("Authentication is unavailable", { status: 503 });
			}
		}

		try {
			const response = await requestHandler(request, {
				cloudflare: { env, ctx },
			});
			// A header rather than a meta tag, so it covers every response including
			// ones with no HTML head. The site stays out of search until launch.
			const headers = new Headers(response.headers);
			headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
			// Nothing here is meant to be framed, and the dashboard shows keys.
			headers.set("X-Frame-Options", "DENY");
			headers.set("Content-Security-Policy", "frame-ancestors 'none'");
			// Each public page names its markdown twin, so an agent that does not
			// know to ask for Accept: text/markdown can still find it.
			const page = PUBLIC_TWIN_PATHS.find((p) => p === url.pathname);
			if (
				page !== undefined &&
				response.status === 200 &&
				(response.headers.get("Content-Type") ?? "").includes("text/html")
			)
				headers.append(
					"Link",
					`<${url.origin}${twinPathOf(page)}>; rel="alternate"; type="text/markdown"`,
				);
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		} catch (error) {
			console.error("[worker] unhandled", url.pathname, error);
			return new Response("Internal Server Error", { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
