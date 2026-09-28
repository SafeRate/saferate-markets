import { describe, expect, test } from "bun:test";
import { resolveStripeKey } from "../app/lib/stripeKey";

// Fake keys: the shape matters, not the value.
const LIVE_RK = `rk_live_${"x".repeat(99)}`;
const LIVE_SK = `sk_live_${"x".repeat(99)}`;
const TEST_SK = `sk_test_${"x".repeat(99)}`;
const TEST_RK = `rk_test_${"x".repeat(99)}`;

describe("resolveStripeKey", () => {
	// The mistake that happened on 2026-09-28: Doppler dev and stg first held
	// rk_live_ keys.
	test("refuses a live key outside production", () => {
		for (const environment of ["development", "staging"] as const) {
			for (const key of [LIVE_RK, LIVE_SK]) {
				const out = resolveStripeKey({ environment, key });
				expect(out.key).toBeNull();
				expect(out.problem).toContain("live");
			}
		}
	});

	test("refuses a test key in production", () => {
		for (const key of [TEST_SK, TEST_RK]) {
			const out = resolveStripeKey({ environment: "production", key });
			expect(out.key).toBeNull();
			expect(out.problem).toContain("test");
		}
	});

	test("accepts the right mode, restricted or not", () => {
		expect(
			resolveStripeKey({ environment: "production", key: LIVE_RK }).key,
		).toBe(LIVE_RK);
		expect(resolveStripeKey({ environment: "staging", key: TEST_SK }).key).toBe(
			TEST_SK,
		);
		expect(
			resolveStripeKey({ environment: "development", key: TEST_RK }).key,
		).toBe(TEST_RK);
	});

	test("an absent or unrecognised key is refused with a reason", () => {
		expect(
			resolveStripeKey({ environment: "staging", key: undefined }).problem,
		).toContain("not set");
		expect(
			resolveStripeKey({ environment: "staging", key: "pk_test_x" }).problem,
		).toContain("unrecognised");
	});
});
