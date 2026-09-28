import { describe, expect, test } from "bun:test";
import { TREASURY_TOOL_NAMES } from "@markets/mcp-tools";
import { API_SURFACES } from "@markets/schema";
import { setup } from "./helpers";

/**
 * The docs page's overview (API_SURFACES) against the published spec, both
 * ways, so a route added without an entry, or an entry for a route that went
 * away, fails here rather than on the docs page.
 */

const publishedPaths = async () => {
	const { call } = await setup();
	const spec = (await (await call("/openapi.json")).json()) as {
		paths: Record<string, unknown>;
	};
	return Object.keys(spec.paths).filter((path) => path.startsWith("/v1/"));
};

const listed = API_SURFACES.flatMap((group) => group.routes.map((r) => r.path));

describe("the docs overview matches the API", () => {
	test("every published /v1 route is listed", async () => {
		const missing = (await publishedPaths()).filter(
			(path) => !listed.includes(path),
		);
		expect(missing).toEqual([]);
	});

	test("every listed route is published", async () => {
		const published = await publishedPaths();
		expect(listed.filter((path) => !published.includes(path))).toEqual([]);
	});

	test("every MCP tool named is a real tool", () => {
		const named = API_SURFACES.flatMap((group) =>
			(group.tool ?? "").split(", ").filter(Boolean),
		);
		expect(
			named.filter(
				(tool) => !(TREASURY_TOOL_NAMES as readonly string[]).includes(tool),
			),
		).toEqual([]);
	});
});
