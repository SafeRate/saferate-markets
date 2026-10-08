import { expect, test } from "bun:test";
import { safeNext } from "../app/lib/signInNext";
import { amountFrom, DEFAULT_AMOUNT } from "../app/lib/ladderAmount";

test("sign-in returns only to a dashboard path", () => {
	expect(safeNext("/dashboard/builder?mode=strategy&budget=50000")).toBe(
		"/dashboard/builder?mode=strategy&budget=50000",
	);
	expect(safeNext("/dashboard")).toBe("/dashboard");
	expect(safeNext("/dashboard?x=1")).toBe("/dashboard?x=1");
	for (const hostile of [
		"https://evil.example/dashboard",
		"//evil.example/dashboard",
		"/dashboard//evil.example",
		"/dashboardx",
		"/pricing",
		"/dashboard/\\evil",
		"",
		null,
	])
		expect(safeNext(hostile)).toBe("/dashboard");
});

test("the ladder amount is clamped, and nonsense is the default", () => {
	expect(amountFrom(null)).toBe(DEFAULT_AMOUNT);
	expect(amountFrom("abc")).toBe(DEFAULT_AMOUNT);
	expect(amountFrom("-5")).toBe(DEFAULT_AMOUNT);
	expect(amountFrom("$250,000")).toBe(250_000);
	expect(amountFrom("50")).toBe(10_000);
	expect(amountFrom("1e12")).toBe(10_000_000);
});
