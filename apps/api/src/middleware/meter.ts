import { recordUsage, touchApiKeyIfStale } from "@markets/persistence";
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
			}),
		);
		c.executionCtx.waitUntil(
			touchApiKeyIfStale({
				db: c.env.DB,
				idApiKey: auth.idApiKey,
				lastUsedAt: auth.lastUsedAt,
			}),
		);
	});
