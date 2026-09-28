import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKOUT_PLANS, rateLimitFor } from "@markets/schema";
import { bearer, setup } from "./helpers";

/**
 * Limits live in TWO places because Cloudflare forces it: each binding's number
 * is wrangler config, and the copy customers read is the plan in the schema.
 * This file keeps them one number per plan, in every environment.
 */

type TRateLimit = {
	name: string;
	namespace_id: string;
	simple: { limit: number; period: number };
};

const wrangler = (() => {
	const raw = readFileSync(join(import.meta.dir, "../wrangler.jsonc"), "utf8");
	return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
		ratelimits?: TRateLimit[];
		env: Record<string, { ratelimits?: TRateLimit[] }>;
	};
})();

const perEnvironment = {
	development: wrangler.ratelimits,
	staging: wrangler.env.staging.ratelimits,
	production: wrangler.env.production.ratelimits,
};

describe("each plan's wrangler limit is its schema limit", () => {
	for (const [name, limits] of Object.entries(perEnvironment)) {
		for (const plan of CHECKOUT_PLANS) {
			// Environments do not inherit bindings, so each is checked. A missing
			// one silently fails open.
			test(`${name}: ${plan.sale.rateLimitBinding} is ${plan.sale.rateLimitPerMinute}/min for ${plan.name}`, () => {
				const binding = limits?.find((l) => l.name === plan.sale.rateLimitBinding);
				expect(binding).toBeDefined();
				expect(binding?.simple).toEqual({
					limit: plan.sale.rateLimitPerMinute,
					period: 60,
				});
			});
		}
	}

	test("every binding in every environment counts in its own namespace", () => {
		const ids = Object.values(perEnvironment).flatMap((l) =>
			(l ?? []).map((x) => x.namespace_id),
		);
		expect(ids.length).toBe(3 * CHECKOUT_PLANS.length);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("rateLimitFor", () => {
	test("an unknown or missing plan gets the LOWEST limit, never a higher one", () => {
		const lowest = Math.min(
			...CHECKOUT_PLANS.map((p) => p.sale.rateLimitPerMinute),
		);
		expect(rateLimitFor("platinum").rateLimitPerMinute).toBe(lowest);
		expect(rateLimitFor(null).rateLimitPerMinute).toBe(lowest);
		expect(rateLimitFor("team").rateLimitPerMinute).toBe(300);
	});
});

describe("enforcement", () => {
	test("a throttled request is a 429 with Retry-After, naming the plan's limit, and is not metered", async () => {
		const { call, key, batches } = await setup({
			limiter: { limit: async () => ({ success: false }) },
		});
		const response = await call("/v1/curves/zero", { headers: bearer(key) });
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("60");
		const body = await response.json();
		expect(body.error).toBe("rate_limited");
		expect(body.message).toContain("60 requests per minute");
		expect(batches).toHaveLength(0);
	});

	test("a Team organization is limited by the Team binding, at 300", async () => {
		const { call, key, limitedBy } = await setup({ idPlan: "team" });
		await call("/v1/curves/zero", { headers: bearer(key) });
		expect(limitedBy).toEqual(["RATE_LIMITER_TEAM"]);

		const throttled = await setup({
			idPlan: "team",
			teamLimiter: { limit: async () => ({ success: false }) },
		});
		const response = await throttled.call("/v1/curves/zero", {
			headers: bearer(throttled.key),
		});
		expect((await response.json()).message).toContain("300 requests per minute");
	});

	test("an Individual organization is limited by the Individual binding", async () => {
		const { call, key, limitedBy } = await setup({ idPlan: "public" });
		await call("/v1/curves/zero", { headers: bearer(key) });
		expect(limitedBy).toEqual(["RATE_LIMITER"]);
	});

	test("MCP is limited by the same limiter", async () => {
		const { call, key } = await setup({
			limiter: { limit: async () => ({ success: false }) },
		});
		const response = await call("/mcp", {
			method: "POST",
			headers: { ...bearer(key), "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(response.status).toBe(429);
	});

	test("the limiter is keyed on the organization, not the key", async () => {
		const { call, key, limitedKeys } = await setup();
		await call("/v1/curves/zero", { headers: bearer(key) });
		expect(limitedKeys).toEqual(["org-1"]);
	});

	test("an unauthenticated request never reaches the limiter", async () => {
		const { call, limitedKeys } = await setup();
		await call("/v1/curves/zero");
		expect(limitedKeys).toHaveLength(0);
	});

	test("a missing binding fails OPEN rather than refusing everyone", async () => {
		const { call, key } = await setup({ omitLimiter: true });
		const response = await call("/v1/curves/zero", { headers: bearer(key) });
		expect(response.status).toBe(200);
	});
});
