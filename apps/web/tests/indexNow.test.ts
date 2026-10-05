import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INDEXNOW_KEY } from "../app/lib/indexNow";

test("the public key file holds exactly the IndexNow key", () => {
	const file = readFileSync(
		join(import.meta.dir, `../public/${INDEXNOW_KEY}.txt`),
		"utf8",
	);
	expect(file).toBe(INDEXNOW_KEY);
	expect(INDEXNOW_KEY).toMatch(/^[a-zA-Z0-9-]{8,128}$/);
});
