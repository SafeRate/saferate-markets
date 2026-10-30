import {
	describeThrown,
	recordEvent,
	recordSiteError,
	recordVisitor,
	wasSiteErrorRecorded,
} from "@markets/persistence";
import { isbot } from "isbot";
import { createRequestHandler } from "react-router";
import { resolveMarketsEnv } from "@markets/schema";
import { isBodylessMethodWithBody } from "@/lib/bodylessMethod";
import { canonicalHostRedirect } from "@/lib/canonicalHost";
import { isAnalyticsPermitted } from "@/lib/privacyChoices";
import { PUBLIC_TWIN_PATHS, twinPathOf } from "@/lib/publicPages";
import {
	C_RUNDOWN_OVERDUE_PATH,
	findOverdueRundown,
	sweepAlerts,
} from "@/services/alerts.server";
import { getAuth } from "@/services/auth.server";
import {
	serializeVisitorCookie,
	touchFrom,
	visitorIdFrom,
} from "@/lib/visitor.server";

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

		// A GET or HEAD with a body makes React Router's request rebuild throw,
		// a 500 on whatever page it hit. Only scanners send one; see
		// lib/bodylessMethod.ts.
		if (isBodylessMethodWithBody(request)) {
			return new Response("Bad Request", { status: 400 });
		}

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
			// Production is open to search engines and AI agents (Dylan,
			// 2026-10-05: "we want to welcome everything"), apart from the
			// signed-in dashboard and sign-in, which hold nothing for an index.
			// Every other environment stays out of search entirely, so staging
			// never competes with the real site. A header rather than a meta tag,
			// so it covers responses with no HTML head (the .txt twins too).
			const headers = new Headers(response.headers);
			const isProduction = resolveMarketsEnv(env.MARKETS_ENV) === "production";
			const isPrivate =
				url.pathname.startsWith("/dashboard") ||
				url.pathname === "/sign-in" ||
				url.pathname === "/sign-out";
			if (!isProduction || isPrivate)
				headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
			// HTTPS only, remembered for a year, on every production host and its
			// subdomains: a trust signal for web filters as much as a protection.
			// Not preloaded, which is hard to undo.
			if (isProduction)
				headers.set(
					"Strict-Transport-Security",
					"max-age=31536000; includeSubDomains",
				);
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
			// A 5xx that handleError never saw: returned rather than thrown, or from
			// a resource route. Status-only, because no stack exists to capture —
			// but without this row the failure is invisible after 7 days.
			if (response.status >= 500 && !wasSiteErrorRecorded(request)) {
				recordSiteError({
					code: "web-server",
					ctx,
					db: env.DB,
					message: `HTTP ${response.status} from ${url.pathname}`,
					request,
				});
			}
			// First-party analytics (lib/visitor.server.ts): on a real page load by a
			// person who has not opted out, mint the visitor id if this browser has
			// none (recording its first touch), and record the page view with this
			// request's own touch. Documents only — not the .txt twins, resource routes
			// or redirects — and never a bot, which would be most of the rows.
			const isDocument =
				request.method === "GET" &&
				(response.headers.get("Content-Type") ?? "").includes("text/html");
			if (
				isDocument &&
				isAnalyticsPermitted(request) &&
				!isbot(request.headers.get("User-Agent") ?? "")
			) {
				const touch = touchFrom(request);
				let idVisitor = visitorIdFrom(request);
				if (!idVisitor) {
					idVisitor = crypto.randomUUID();
					headers.append(
						"Set-Cookie",
						serializeVisitorCookie({
							idVisitor,
							isSecure: url.protocol === "https:",
						}),
					);
					void recordVisitor({ ctx, db: env.DB, idVisitor, touch });
				}
				void recordEvent({
					ctx,
					db: env.DB,
					idVisitor,
					name: "page_view",
					path: url.pathname,
					props: {
						referrerHost: touch.referrerHost,
						status: response.status,
						utmCampaign: touch.utmCampaign,
						utmMedium: touch.utmMedium,
						utmSource: touch.utmSource,
					},
					source: "web",
				});
			}
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		} catch (error) {
			console.error("[worker] unhandled", url.pathname, error);
			const { message, stack } = describeThrown(error);
			recordSiteError({
				code: "web-server",
				ctx,
				db: env.DB,
				message,
				request,
				stack,
			});
			return new Response("Internal Server Error", { status: 500 });
		}
	},

	/**
	 * The email alerts sweep (services/alerts.server.ts), every five minutes.
	 * Each tick decides from the data what is new; the cron carries no
	 * schedule of its own beyond "often", so a late result or a late curve is
	 * mailed on the tick after it lands. Logged every time, sending or not, so
	 * a sweep that stopped can be told from one with nothing to do.
	 */
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(
			sweepAlerts(env)
				.then((line) => console.info(`[alerts] ${line}`))
				.catch((error) => {
					console.error("[alerts] sweep failed:", error);
					const { message, stack } = describeThrown(error);
					recordSiteError({
						code: "web-cron",
						ctx,
						db: env.DB,
						message: `alerts sweep failed: ${message}`,
						path: "cron:alerts",
						request: null,
						stack,
					});
				})
				// Then, whatever the sweep did: is today's rundown overdue? One row a
				// day at most (findOverdueRundown dedupes on its own row), so a stalled
				// edition is on record instead of being only a missing email.
				.then(() => findOverdueRundown({ db: env.DB, now: new Date() }))
				.then((overdue) => {
					if (overdue === null) return;
					console.error(`[alerts] ${overdue}`);
					recordSiteError({
						code: "web-cron",
						ctx,
						db: env.DB,
						message: overdue,
						path: C_RUNDOWN_OVERDUE_PATH,
						request: null,
					});
				})
				.catch((error) => console.error("[alerts] overdue check failed:", error)),
		);
	},
} satisfies ExportedHandler<Env>;
