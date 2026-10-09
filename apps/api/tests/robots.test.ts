import { describe, expect, test } from "bun:test";
import { setup } from "./helpers";

describe("robots.txt on the API host", () => {
	test("production lets crawlers read the OpenAPI spec and nothing else", async () => {
		const { call } = await setup({ environment: "production" });
		const body = await (await call("/robots.txt")).text();
		expect(body).toBe("User-agent: *\nAllow: /openapi.json\nDisallow: /\n");
		expect(body).not.toContain("/reference");
	});

	test("staging and development allow nothing", async () => {
		for (const environment of ["staging", "development"]) {
			const { call } = await setup({ environment });
			expect(await (await call("/robots.txt")).text()).toBe(
				"User-agent: *\nDisallow: /\n",
			);
		}
	});

	test("the spec itself still carries noindex, so it stays out of search", async () => {
		const { call } = await setup({ environment: "production" });
		const response = await call("/openapi.json");
		expect(response.status).toBe(200);
		expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
	});
});
