import {
	recordEvent,
	recordUsage,
	touchApiKeyIfStale,
} from "@markets/persistence";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";

/**
 * Record one request after the handler has run. Ported from OKLocate.
 *
 * Post-phase, because the facts worth recording (status, what was asked) exist
 * only once the work is done. Both writes go through waitUntil so bookkeeping
 * never delays the response.
 *
 * Must sit INSIDE apiKeyAuth. If the order is ever swapped, `auth` is unset and
 * the row is dropped rather than written against nobody.
 */
export const meterUsage = (surface: AppEnv["Variables"]["surface"]) =>
	createMiddleware<AppEnv>(async (c, next) => {
		c.set("surface", surface);
		await next();

		const auth = c.get("auth");
		if (!auth) return;

		c.executionCtx.waitUntil(
			recordUsage({
				db: c.env.DB,
				analytics: c.env.API_USAGE,
				idOrganization: auth.idOrganization,
				idApiKey: auth.idApiKey,
				surface,
				operation: c.get("operation") ?? c.req.routePath,
				statusCode: c.get("statusOverride") ?? c.res.status,
				durationMs: Math.max(0, Date.now() - c.get("startedAt")),
				clientName: c.get("clientName") ?? null,
				errorCode: c.get("errorCode") ?? null,
			}),
		);
		// A key's first call ever — the activation moment for an API product.
		// lastUsedAt is null exactly once per key; two simultaneous first calls can
		// both see it, so analysis takes the earliest row per key.
		if (auth.lastUsedAt === null && c.res.status < 500)
			void recordEvent({
				ctx: c.executionCtx,
				db: c.env.DB,
				idOrganization: auth.idOrganization,
				name: "api_key_first_used",
				path: new URL(c.req.url).pathname,
				props: {
					operation: String(c.get("operation") ?? c.req.routePath).slice(0, 120),
					surface,
				},
				source: "api",
			});
		c.executionCtx.waitUntil(
			touchApiKeyIfStale({
				db: c.env.DB,
				idApiKey: auth.idApiKey,
				lastUsedAt: auth.lastUsedAt,
			}),
		);
	});
