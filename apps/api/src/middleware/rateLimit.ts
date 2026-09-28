import { RATE_LIMIT_PER_MINUTE } from "@markets/schema";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";

/**
 * RATE_LIMIT_PER_MINUTE per organization, REST and MCP together.
 *
 * Keyed on the ORGANIZATION, not the key: rotating or minting more keys must
 * not multiply the allowance. Sits after apiKeyAuth, which is what resolves the
 * organization, and before the meter, so a throttled request is not recorded
 * as usage (it did no work, exactly as a 401 does no work).
 *
 * FAILS OPEN when the binding is absent or errors, and says so in the log. The
 * limiter protects capacity; it is not access control, and failing closed would
 * turn a misconfigured binding into an outage for every paying customer.
 */
export const rateLimit = () =>
	createMiddleware<AppEnv>(async (c, next) => {
		const limiter = c.env.RATE_LIMITER;
		const { idOrganization } = c.get("auth");

		let isAllowed = true;
		if (limiter === undefined) {
			console.error("[rate-limit] RATE_LIMITER binding missing; not enforcing");
		} else {
			try {
				isAllowed = (await limiter.limit({ key: idOrganization })).success;
			} catch (error) {
				console.error("[rate-limit] limiter failed; not enforcing", error);
			}
		}

		if (!isAllowed) {
			c.header("Retry-After", "60");
			return c.json(
				{
					error: "rate_limited" as const,
					message: `Rate limit reached: ${RATE_LIMIT_PER_MINUTE} requests per minute per organization, across the REST API and MCP together. Retry after a minute.`,
				},
				429,
			);
		}
		await next();
	});
