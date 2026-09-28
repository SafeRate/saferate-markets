import { rateLimitFor } from "@markets/schema";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";

/**
 * Per-organization rate limit, REST and MCP together, at the organization's
 * PLAN's limit (Individual 60/min, Team 300/min: rateLimitFor in
 * @markets/schema).
 *
 * Keyed on the ORGANIZATION, not the key: rotating or minting more keys must
 * not multiply the allowance. Sits after apiKeyAuth, which resolves the
 * organization and its plan, and before the meter, so a throttled request is
 * not recorded as usage (it did no work, exactly as a 401 does no work).
 *
 * One Cloudflare binding per plan, because a binding's limit is fixed in
 * wrangler config. An unknown plan gets the LOWEST limit (rateLimitFor).
 *
 * FAILS OPEN when the binding is absent or errors, and says so in the log. The
 * limiter protects capacity; it is not access control, and failing closed would
 * turn a misconfigured binding into an outage for every paying customer.
 */
export const rateLimit = () =>
	createMiddleware<AppEnv>(async (c, next) => {
		const { idOrganization, idPlan } = c.get("auth");
		const plan = rateLimitFor(idPlan);
		const limiter = c.env[plan.rateLimitBinding];

		let isAllowed = true;
		if (limiter === undefined) {
			console.error(
				`[rate-limit] ${plan.rateLimitBinding} binding missing; not enforcing`,
			);
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
					message: `Rate limit reached: ${plan.rateLimitPerMinute} requests per minute for your organization's plan, across the REST API and MCP together. Retry after a minute.`,
				},
				429,
			);
		}
		await next();
	});
