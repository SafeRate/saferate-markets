import { describe, expect, test } from "bun:test";
import { ALTERNATE_HOSTS, REDIRECT_HOSTS, SITE_HOSTS } from "@markets/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalHostRedirect } from "../app/lib/canonicalHost";

// Tests the code that ships, not a re-implementation of it (OKLocate's rule).
const redirectOf = (url: string) => canonicalHostRedirect(new Request(url));

describe("canonicalHostRedirect", () => {
	// saferate.market was bought so a visitor who forgets the plural still
	// arrives (2026-09-28).
	test("the singular domain lands on the plural, path and query kept", () => {
		const response = redirectOf("https://saferate.market/docs?x=1");
		expect(response?.status).toBe(301);
		expect(response?.headers.get("Location")).toBe(
			"https://saferate.markets/docs?x=1",
		);
	});

	test("every redirect host lands on production", () => {
		for (const host of REDIRECT_HOSTS) {
			expect(redirectOf(`https://${host}/`)?.headers.get("Location")).toBe(
				`${SITE_HOSTS.production.web}/`,
			);
		}
	});

	test("the canonical hosts are not redirected", () => {
		for (const url of [
			SITE_HOSTS.production.web,
			SITE_HOSTS.staging.web,
			SITE_HOSTS.development.web,
		]) {
			expect(redirectOf(`${url}/dashboard`)).toBeNull();
		}
	});

	// A redirect host the Worker does not claim never reaches this code, so the
	// list and wrangler's production routes must be the same set.
	test("an alternate host serves the site: it is not redirected", () => {
		for (const host of ALTERNATE_HOSTS)
			expect(
				canonicalHostRedirect(new Request(`https://${host}/indices`)),
			).toBeNull();
	});

	test("the production web Worker claims exactly the apex, REDIRECT_HOSTS and ALTERNATE_HOSTS", () => {
		const raw = readFileSync(join(import.meta.dir, "../wrangler.jsonc"), "utf8");
		const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
			env: { production: { routes: { pattern: string }[] } };
		};
		const claimed = config.env.production.routes.map((r) => r.pattern).sort();
		const expected = [
			new URL(SITE_HOSTS.production.web).hostname,
			...REDIRECT_HOSTS,
			...ALTERNATE_HOSTS,
		].sort();
		expect(claimed).toEqual(expected);
	});
});
