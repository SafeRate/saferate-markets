import { describe, expect, test } from "bun:test";
import {
	describeThrown,
	recordSiteError,
	wasSiteErrorRecorded,
} from "@markets/persistence";
import { ZClientErrorBody } from "../app/routes/api.client-error";

/** A D1 stand-in that keeps the bound values of every insert. */
const fakeDb = () => {
	const rows: unknown[][] = [];
	const db = {
		prepare: () => ({
			bind: (...values: unknown[]) => ({
				run: async () => {
					rows.push(values);
					return { success: true };
				},
			}),
		}),
	} as unknown as D1Database;
	return { db, rows };
};

const fakeCtx = () => {
	const pending: Promise<unknown>[] = [];
	return {
		ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
		settle: () => Promise.all(pending),
	};
};

describe("recordSiteError", () => {
	test("writes the path without its query string, and the cf-ray", async () => {
		const { db, rows } = fakeDb();
		const { ctx, settle } = fakeCtx();
		const request = new Request(
			"https://saferate.markets/profile?address=1%20Main%20St&key=sk_live_x",
			{ headers: { "cf-ray": "abc123" } },
		);
		recordSiteError({
			code: "web-render",
			ctx,
			db,
			message: "boom",
			request,
		});
		await settle();
		expect(rows).toHaveLength(1);
		const [, code, path, message, stack, cfRay] = rows[0] ?? [];
		expect(code).toBe("web-render");
		expect(path).toBe("/profile");
		expect(message).toBe("boom");
		expect(stack).toBeNull();
		expect(cfRay).toBe("abc123");
	});

	test("marks the request even with no binding, so the fallback does not double-record", () => {
		const { ctx } = fakeCtx();
		const request = new Request("https://saferate.markets/");
		expect(wasSiteErrorRecorded(request)).toBe(false);
		recordSiteError({ code: "web-render", ctx, message: "x", request });
		expect(wasSiteErrorRecorded(request)).toBe(true);
	});

	test("a cron row has no request and names its job", async () => {
		const { db, rows } = fakeDb();
		const { ctx, settle } = fakeCtx();
		recordSiteError({
			code: "web-cron",
			ctx,
			db,
			message: "overage reporting failed: 502",
			path: "cron:overage",
			request: null,
		});
		await settle();
		expect(rows[0]?.[2]).toBe("cron:overage");
		expect(rows[0]?.[5]).toBeNull();
	});

	test("a failing insert never throws into the caller", async () => {
		const db = {
			prepare: () => {
				throw new Error("D1 down");
			},
		} as unknown as D1Database;
		const { ctx, settle } = fakeCtx();
		const original = console.error;
		console.error = () => {};
		try {
			expect(() =>
				recordSiteError({
					code: "api-server",
					ctx,
					db,
					message: "x",
					request: null,
				}),
			).not.toThrow();
			await settle();
		} finally {
			console.error = original;
		}
	});
});

describe("describeThrown", () => {
	test("a plain object is serialised, not [object Object]", () => {
		expect(describeThrown({ status: 405 }).message).toBe(
			'Object: {"status":405}',
		);
	});

	test("an Error keeps its stack", () => {
		const described = describeThrown(new Error("nope"));
		expect(described.message).toBe("nope");
		expect(described.stack).toContain("nope");
	});
});

describe("client-error body", () => {
	test("strips a query string and hash from the page, and unknown keys", () => {
		const parsed = ZClientErrorBody.parse({
			email: "someone@example.com",
			message: "TypeError: x is undefined",
			page: "/profile?address=1 Main St#map",
		});
		expect(parsed.page).toBe("/profile");
		expect("email" in parsed).toBe(false);
	});

	test("refuses an empty message", () => {
		expect(ZClientErrorBody.safeParse({ message: "  " }).success).toBe(false);
	});
});
