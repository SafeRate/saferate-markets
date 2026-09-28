import { describe, expect, test } from "bun:test";
import {
	resolveTrackingTools,
	trackingToolsForPath,
} from "../app/lib/analytics";
import { isAnalyticsPermitted } from "../app/lib/privacyChoices";

describe("resolveTrackingTools: present id = may run, absent = off", () => {
	test("staging and dev carry empty ids, so nothing resolves", () => {
		expect(
			resolveTrackingTools({ GA_MEASUREMENT_ID: "", CLARITY_PROJECT_ID: "" }),
		).toHaveLength(0);
		expect(resolveTrackingTools({ GA_MEASUREMENT_ID: "   " })).toHaveLength(0);
	});

	test("production's ids resolve both tools", () => {
		const tools = resolveTrackingTools({
			GA_MEASUREMENT_ID: "G-GXT251RBGJ",
			CLARITY_PROJECT_ID: "ypjj2lural",
		});
		expect(tools.map((t) => t.idMeasurement)).toEqual([
			"G-GXT251RBGJ",
			"ypjj2lural",
		]);
	});

	test("even configured, nothing is allowed on the keys page", () => {
		const tools = resolveTrackingTools({
			GA_MEASUREMENT_ID: "G-GXT251RBGJ",
			CLARITY_PROJECT_ID: "ypjj2lural",
		});
		expect(trackingToolsForPath(tools, "/dashboard/keys")).toHaveLength(0);
		expect(trackingToolsForPath(tools, "/pricing")).toHaveLength(2);
	});
});

describe("the visitor's refusal, read server side", () => {
	const request = (headers: Record<string, string>) =>
		new Request("https://saferate.markets/pricing", { headers });

	test("no signal and no cookie: permitted (opt-out model)", () => {
		expect(isAnalyticsPermitted(request({}))).toBe(true);
	});
	test("the opt-out cookie refuses", () => {
		expect(
			isAnalyticsPermitted(request({ Cookie: "markets_analytics=off" })),
		).toBe(false);
	});
	test("Global Privacy Control refuses, even over an opt-in cookie", () => {
		expect(
			isAnalyticsPermitted(
				request({ "Sec-GPC": "1", Cookie: "markets_analytics=on" }),
			),
		).toBe(false);
	});
});
