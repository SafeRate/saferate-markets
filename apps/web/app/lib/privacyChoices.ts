import { z } from "zod";

// Ported from saferate-oklocate apps/web/app/lib/privacyChoices.ts (2026-09-28).

/**
 * The visitor's analytics choice, and Global Privacy Control.
 *
 * Both are read SERVER side, and that is the point. An opted-out visitor never
 * receives the script at all, rather than receiving it and being asked to trust
 * that a later call quietened it. It also means the choice survives with
 * JavaScript disabled, and that `/privacy-choices` works as a plain form.
 *
 * The cookie is strictly necessary in the exact sense the term is meant: it
 * exists only to record the refusal of something else. Needing consent to store
 * someone's refusal of consent would be circular, which is why no banner gates
 * it.
 */

export const COOKIE_ANALYTICS_CHOICE = "markets_analytics";

export const ZAnalyticsChoice = z.enum(["on", "off"]);
export type TAnalyticsChoice = z.infer<typeof ZAnalyticsChoice>;

/** A year. Long enough that a visitor is not re-asked, short enough to lapse. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Global Privacy Control, as a request header.
 *
 * `Sec-GPC: 1` is the wire form of the signal. It is checked here rather than
 * only in the browser because the header arrives before we render, so honouring
 * it means never emitting the tag — and because California enforces an ignored
 * opt-out signal as a violation in its own right, not merely as a preference we
 * ought to respect.
 */
export const isGpcSignalled = (request: Request) =>
	request.headers.get("Sec-GPC") === "1";

const ZInputReadAnalyticsChoice = z.custom<Request>(
	(v) => v instanceof Request,
	"expected a Request",
);

/** The explicit choice, or null where the visitor has not made one. */
export const readAnalyticsChoice = (
	_input: Request,
): TAnalyticsChoice | null => {
	const request = ZInputReadAnalyticsChoice.parse(_input);
	const header = request.headers.get("Cookie") ?? "";
	for (const part of header.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name !== COOKIE_ANALYTICS_CHOICE) continue;
		const parsed = ZAnalyticsChoice.safeParse(decodeURIComponent(rest.join("=")));
		return parsed.success ? parsed.data : null;
	}
	return null;
};

/**
 * Whether analytics may load for this request.
 *
 * GPC wins over an explicit "on". Someone whose browser is set to refuse
 * tracking and who has an older opt-in cookie is refusing tracking; reading it
 * the other way would let a stale cookie override a live signal.
 *
 * A visitor who has expressed nothing gets analytics, because the model is
 * opt-out, as OKLocate's (a US audience). An EEA or UK audience would need
 * opt-in consent before anything loads; revisit if Markets sells there.
 */
export const isAnalyticsPermitted = (request: Request) => {
	if (isGpcSignalled(request)) return false;
	return readAnalyticsChoice(request) !== "off";
};

/** Why analytics is off, for the privacy-choices page to explain. */
export const describeAnalyticsState = (request: Request) => {
	const isGpc = isGpcSignalled(request);
	const choice = readAnalyticsChoice(request);
	return {
		isGpc,
		choice,
		isPermitted: !isGpc && choice !== "off",
		/** GPC is holding it off regardless of the stored choice. */
		isGpcOverriding: isGpc && choice !== "off",
	};
};

const ZInputSerializeAnalyticsChoice = z.object({
	choice: ZAnalyticsChoice,
	isSecure: z.boolean(),
});

type TInputSerializeAnalyticsChoice = z.infer<
	typeof ZInputSerializeAnalyticsChoice
>;

/**
 * The Set-Cookie value.
 *
 * HttpOnly, because only the server reads it and a preference that scripts
 * cannot touch is a preference an injected script cannot flip. SameSite=Lax so
 * it survives arriving from an external link. `isSecure` is passed rather than
 * inferred so local dev over http still sets it.
 */
export const serializeAnalyticsChoice = (
	_input: TInputSerializeAnalyticsChoice,
) => {
	const input = ZInputSerializeAnalyticsChoice.parse(_input);
	const parts = [
		`${COOKIE_ANALYTICS_CHOICE}=${input.choice}`,
		"Path=/",
		`Max-Age=${MAX_AGE_SECONDS}`,
		"SameSite=Lax",
		"HttpOnly",
	];
	if (input.isSecure) parts.push("Secure");
	return parts.join("; ");
};
