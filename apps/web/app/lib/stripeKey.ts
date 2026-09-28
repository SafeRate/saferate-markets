import type { TMarketsEnv } from "@markets/schema";

/**
 * Which Stripe key this environment may use, or why none.
 *
 * Production takes only a LIVE key; every other environment takes only a TEST
 * key. On 2026-09-28 Doppler dev and stg were first filled with rk_live_ keys
 * (created with test mode off), which would have let staging charge real cards.
 * OKLocate saw the reverse. Either way the fix is to refuse the mismatch here,
 * where it is one comparison, rather than discover it on a statement.
 *
 * A refusal returns key: null. auth.server.ts then mounts the plugin with a
 * placeholder so billing fails at its first call with a real Stripe error,
 * while SIGN-IN keeps working: billing must never take sign-in down.
 *
 * Decided by the MODE in the prefix, never by the whole prefix: sk_ and rk_ are
 * both valid (prd holds a restricted rk_live_, the sandbox an sk_test_).
 */
export const resolveStripeKey = (input: {
	environment: TMarketsEnv;
	key: string | undefined;
}): { key: string | null; problem: string | null } => {
	const key = input.key?.trim() ?? "";
	if (key === "") {
		return { key: null, problem: "STRIPE_SECRET_KEY is not set" };
	}
	const mode = /^(sk|rk)_live_/.test(key)
		? "live"
		: /^(sk|rk)_test_/.test(key)
			? "test"
			: "unrecognised";
	const wanted = input.environment === "production" ? "live" : "test";
	if (mode !== wanted) {
		return {
			key: null,
			problem: `refusing a ${mode} Stripe key in ${input.environment}, which takes only ${wanted} keys`,
		};
	}
	return { key, problem: null };
};
