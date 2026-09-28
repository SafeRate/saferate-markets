import { z } from "zod";

/**
 * Staging shares real sending credentials with production, so without a guard a
 * sign-in attempt from a test environment mails a real person. This is the
 * allowlist pattern from saferate-ai, ported: team addresses go out for real,
 * everyone else is logged so the link can be recovered from `wrangler tail`.
 *
 * It is an allowlist and not a kill switch because the team has to be able to
 * sign in to staging.
 *
 * An ABSENT environment is treated as guarded, not unguarded. A worker deployed
 * before secrets were synced must withhold mail rather than send it.
 */

export const ZEmailGuard = z.object({
	environment: z.string(),
	isGuarded: z.boolean(),
	allowlist: z.array(z.string()),
});
export type TEmailGuard = z.infer<typeof ZEmailGuard>;

const DEFAULT_ALLOWLIST = ["@saferate.com"];

/**
 * Which environment is this, for guard purposes?
 *
 * Reads MARKETS_ENV first: it is a wrangler `vars` entry baked per environment
 * at BUILD time, so unlike a synced secret it cannot be absent at runtime.
 * DOPPLER_ENVIRONMENT is accepted as a fallback for a local shell that exports it.
 *
 * The direction of failure matters. An unrecognised or missing environment is
 * treated as NON-production, which withholds mail. That is right for staging and
 * would be catastrophic in production, which is exactly why production must not
 * depend on a value the secret sync can drop.
 */
export const resolveEmailGuard = (input: {
	environment?: string;
	allowlistOverride?: string;
}): TEmailGuard => {
	const environment = input.environment?.trim() ?? "";
	const isProduction = environment === "prd" || environment === "production";
	const allowlist = input.allowlistOverride
		? input.allowlistOverride
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: DEFAULT_ALLOWLIST;
	return ZEmailGuard.parse({
		environment: environment || "unknown",
		isGuarded: !isProduction,
		allowlist,
	});
};

/** Matches a full address or a domain suffix entry such as "@saferate.com". */
export const isRecipientAllowed = (input: {
	allowlist: string[];
	recipient: string;
}) => {
	const recipient = input.recipient.trim().toLowerCase();
	return input.allowlist.some((entry) => {
		const e = entry.trim().toLowerCase();
		if (!e) return false;
		return e.startsWith("@") ? recipient.endsWith(e) : recipient === e;
	});
};
