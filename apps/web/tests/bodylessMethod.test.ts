import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isBodylessMethodWithBody } from "../app/lib/bodylessMethod";

const C_URL = "https://saferate.markets/";

describe("isBodylessMethodWithBody", () => {
	test("a GET declaring a Content-Length is refused", () => {
		const request = new Request(C_URL, { headers: { "content-length": "12" } });
		expect(isBodylessMethodWithBody(request)).toBe(true);
	});

	test("a HEAD declaring Transfer-Encoding is refused", () => {
		const request = new Request(C_URL, {
			headers: { "transfer-encoding": "chunked" },
			method: "HEAD",
		});
		expect(isBodylessMethodWithBody(request)).toBe(true);
	});

	test("an ordinary GET passes", () => {
		expect(isBodylessMethodWithBody(new Request(C_URL))).toBe(false);
	});

	test("a GET with Content-Length: 0 and no body passes", () => {
		const request = new Request(C_URL, { headers: { "content-length": "0" } });
		expect(isBodylessMethodWithBody(request)).toBe(false);
	});

	test("the 2026-10-24 shape: Content-Length 0 but a body is refused", () => {
		// What the scanner sent: framing headers say nothing, the body is there.
		// A POST with its method shadowed stands in for what workerd hands the
		// Worker, since Bun will not reliably build a GET with a body.
		const request = new Request(C_URL, { body: "x", method: "POST" });
		Object.defineProperty(request, "method", { value: "GET" });
		request.headers.set("content-length", "0");
		expect(isBodylessMethodWithBody(request)).toBe(true);
	});

	test("the check leaves a refused request's body unread", async () => {
		const request = new Request(C_URL, { body: "x", method: "POST" });
		Object.defineProperty(request, "method", { value: "HEAD" });
		isBodylessMethodWithBody(request);
		expect(request.bodyUsed).toBe(false);
		expect(await request.text()).toBe("x");
	});

	test("a POST with a body passes", () => {
		const request = new Request(C_URL, { body: "a=1", method: "POST" });
		expect(isBodylessMethodWithBody(request)).toBe(false);
	});
});

describe("the Worker refuses them before React Router", () => {
	// The Worker imports a virtual module, so it cannot be loaded in a test;
	// this checks the wiring instead: the guard runs, and runs first.
	const source = readFileSync(
		join(import.meta.dir, "../workers/app.ts"),
		"utf8",
	);

	test("the guard is called ahead of the request handler", () => {
		const guard = source.indexOf("isBodylessMethodWithBody(request)");
		expect(guard).toBeGreaterThan(-1);
		expect(guard).toBeLessThan(source.indexOf("await requestHandler("));
		expect(guard).toBeLessThan(source.indexOf("getAuth({ env, request })"));
	});
});
