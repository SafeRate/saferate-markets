import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RATE_LIMIT_PER_MINUTE } from "@markets/schema";
import { bearer, setup } from "./helpers";

/**
 * The limit lives in TWO places because Cloudflare forces it: the binding's
 * number is wrangler config, and the copy customers read is the schema
 * constant. This file is what keeps them one number.
 */

type TRateLimit = {
	name: string;
	namespace_id: string;
	simple: { limit: number; period: number };
};

const wrangler = (() => {
	const raw = readFileSync(join(import.meta.dir, "../wrangler.jsonc"), "utf8");
	// JSONC: drop whole-line comments. No string in this file contains "//"
	// followed by a newline-spanning value, so this is sufficient here.
	const json = raw.replace(/^\s*\/\/.*$/gm, "");
	return JSON.parse(json) as {
		ratelimits?: TRateLimit[];
		env: Record<string, { ratelimits?: TRateLimit[] }>;
	};
})();

const perEnvironment = {
	development: wrangler.ratelimits,
	staging: wrangler.env.staging.ratelimits,
	production: wrangler.env.production.ratelimits,
};

describe("the wrangler limit is the schema's limit", () => {
	for (const [name, limits] of Object.entries(perEnvironment)) {
		// Environments do not inherit bindings, so each one is checked, not just
		// the top level. A missing one would silently fail open.
		test(`${name}: RATE_LIMITER is bound at ${RATE_LIMIT_PER_MINUTE}/min`, () => {
			const limiter = limits?.find((l) => l.name === "RATE_LIMITER");
			expect(limiter).toBeDefined();
			expect(limiter?.simple).toEqual({
				limit: RATE_LIMIT_PER_MINUTE,
				period: 60,
			});
		});
	}

	test("each environment counts in its own namespace", () => {
		const ids = Object.values(perEnvironment).map(
			(l) => l?.find((x) => x.name === "RATE_LIMITER")?.namespace_id,
		);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("enforcement", () => {
	test("a throttled request is a 429 with Retry-After, and is not metered", async () => {
		const { call, key, batches } = await setup({
			limiter: { limit: async () => ({ success: false }) },
		});
		const response = await call("/v1/curves/zero", { headers: bearer(key) });
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("60");
		const body = await response.json();
		expect(body.error).toBe("rate_limited");
		expect(body.message).toContain(String(RATE_LIMIT_PER_MINUTE));
		expect(batches).toHaveLength(0);
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

	// Minting more keys must not multiply the allowance.
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
