import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type TEnvConfig = { triggers?: { crons: string[] } };

const config = JSON.parse(
	readFileSync(join(import.meta.dir, "../wrangler.jsonc"), "utf8").replace(
		/^\s*\/\/.*$/gm,
		"",
	),
) as { triggers?: { crons: string[] }; env: Record<string, TEnvConfig> };

/**
 * Only production sweeps alerts. A staging sweep mails staging's own test
 * accounts, every one an @saferate.com address the allowlist lets through.
 */
describe("the alerts cron", () => {
	test("production sweeps every five minutes", () => {
		expect(config.env.production.triggers?.crons).toEqual(["*/5 * * * *"]);
	});

	test("staging has none, and says so, so a deploy removes it", () => {
		expect(config.env.staging.triggers?.crons).toEqual([]);
		expect(config.triggers?.crons ?? []).toEqual([]);
	});
});
