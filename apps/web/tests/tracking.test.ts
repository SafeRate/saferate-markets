import { describe, expect, test } from "bun:test";
import {
	isPathPublic,
	TRACKING_TOOLS,
	trackingToolsFor,
} from "@markets/schema";

describe("isPathPublic fails closed", () => {
	test("public pages are public", () => {
		for (const p of [
			"/",
			"/pricing",
			"/docs",
			"/docs/indices",
			"/privacy-choices",
		]) {
			expect(isPathPublic(p)).toBe(true);
		}
	});

	// The keys page prints a live API key once; sign-in shows an email and a
	// one-time link. No third-party tag may load on any of them.
	test("the dashboard, sign-in and auth are never public, however written", () => {
		for (const p of [
			"/dashboard",
			"/dashboard/keys",
			"/dashboard/billing",
			"/Dashboard/Keys/",
			"/dashboard?x=1",
			"/sign-in",
			"/sign-out",
			"/api/auth/magic-link/verify",
		]) {
			expect(isPathPublic(p)).toBe(false);
		}
	});

	test("anything unparseable is non-public", () => {
		for (const p of ["", "dashboard", null, undefined])
			expect(isPathPublic(p)).toBe(false);
	});

	test("a prefix match is on a segment, not a string: /dashboards is not /dashboard", () => {
		expect(isPathPublic("/dashboards")).toBe(true);
	});
});

describe("trackingToolsFor", () => {
	test("no tool is allowed on the keys page", () => {
		expect(trackingToolsFor(TRACKING_TOOLS, "/dashboard/keys")).toHaveLength(0);
	});
	test("both are allowed on pricing", () => {
		expect(trackingToolsFor(TRACKING_TOOLS, "/pricing")).toHaveLength(2);
	});
});
