import { describe, expect, test } from "bun:test";
import { toolErrorCode } from "../src/lib/toolOutcome";

const text = (value: unknown, extra: Record<string, unknown> = {}) => ({
	content: [
		{
			type: "text",
			text: typeof value === "string" ? value : JSON.stringify(value),
		},
	],
	...extra,
});

describe("toolErrorCode", () => {
	test("a success is null", () => {
		expect(toolErrorCode(text({ ok: true, rows: [] }))).toBeNull();
		expect(toolErrorCode(text({ rows: [] }))).toBeNull();
		expect(toolErrorCode(text("plain prose"))).toBeNull();
	});

	test("a refusal is its own code", () => {
		expect(toolErrorCode(text({ error: "bad_request", ok: false }))).toBe(
			"bad_request",
		);
		expect(toolErrorCode(text({ ok: false }))).toBe("error");
	});

	test("MCP isError without a code is tool_error", () => {
		expect(toolErrorCode(text("Not available yet.", { isError: true }))).toBe(
			"tool_error",
		);
	});

	test("asking for a missing argument is input_required", () => {
		expect(toolErrorCode({ inputRequests: {} })).toBe("input_required");
	});

	test("an unexpected shape never throws", () => {
		expect(toolErrorCode(null)).toBeNull();
		expect(toolErrorCode({ content: "x" })).toBeNull();
	});
});
