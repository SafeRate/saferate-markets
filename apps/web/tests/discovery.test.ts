import { describe, expect, test } from "bun:test";
import { PUBLIC_TWIN_PATHS } from "../app/lib/publicPages";
import { loader as robots } from "../app/routes/robots";
import { loader as sitemap } from "../app/routes/sitemap";

const args = (url: string, env: string) =>
	({
		request: new Request(url),
		context: { cloudflare: { env: { MARKETS_ENV: env } } },
		params: {},
	}) as never;

describe("robots.txt", () => {
	test("production welcomes every crawler and names the sitemap", async () => {
		const text = await robots(
			args("https://saferate.markets/robots.txt", "production"),
		).text();
		expect(text).toContain(
			"User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: /",
		);
		expect(text).toContain("Sitemap: https://saferate.markets/sitemap.xml");
		expect(text).not.toMatch(/^Disallow: \/$/m);
	});

	test("staging disallows everything", async () => {
		const text = await robots(
			args("https://staging.saferate.markets/robots.txt", "staging"),
		).text();
		expect(text).toMatch(/^Disallow: \/$/m);
		expect(text).not.toContain("Sitemap:");
	});
});

test("the sitemap lists every public page on this host, and no twin", async () => {
	const xml = await sitemap(
		args("https://saferate.markets/sitemap.xml", "production"),
	).text();
	const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
	expect(locs).toEqual(
		PUBLIC_TWIN_PATHS.map((p) => `https://saferate.markets${p}`),
	);
	expect(xml).not.toContain(".txt");
});
