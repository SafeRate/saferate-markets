import {
	isBehaviouralEvent,
	recordEvent,
	type TEventName,
	type TEventProps,
	type TTouch,
} from "@markets/persistence";
import { isAnalyticsPermitted } from "@/lib/privacyChoices";

/**
 * The first-party visitor id, and the one helper routes use to record an event.
 *
 * `markets_vid` is a random UUID in an httpOnly cookie, minted on a visitor's first
 * permitted page view (workers/app.ts) and kept for two years. Sign-out does not
 * clear it, so a returning customer's visits stay theirs. It is what joins a visit
 * before sign-up to the account it became (linkVisitorToUser) — the single link
 * GA4 and Clarity could never give us.
 *
 * ⚠️ IT EXISTS ONLY WHEN ANALYTICS IS PERMITTED. With the opt-out cookie or GPC the
 * cookie is neither set nor READ: a visitor who opts out later stops being followed
 * on their next request, even though the old cookie is still in their browser.
 */

export const COOKIE_VISITOR = "markets_vid";
const C_VISITOR_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 2;
const C_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The visitor id on this request, or null when there is none or analytics is not permitted. */
export const visitorIdFrom = (request: Request) => {
	if (!isAnalyticsPermitted(request)) return null;
	for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
		const [name, value] = part.trim().split("=");
		if (name === COOKIE_VISITOR && value && C_UUID.test(value)) return value;
	}
	return null;
};

/** Same, from a raw Cookie header (a Better Auth hook has headers, not a Request). */
export const visitorIdFromHeaders = (headers: Headers | undefined) =>
	headers
		? visitorIdFrom(new Request("https://markets.invalid/", { headers }))
		: null;

export const serializeVisitorCookie = (input: {
	idVisitor: string;
	isSecure: boolean;
}) =>
	[
		`${COOKIE_VISITOR}=${input.idVisitor}`,
		"Path=/",
		`Max-Age=${C_VISITOR_MAX_AGE_SECONDS}`,
		"SameSite=Lax",
		"HttpOnly",
		...(input.isSecure ? ["Secure"] : []),
	].join("; ");

const C_CLICK_IDS = ["gclid", "fbclid", "msclkid", "li_fat_id"] as const;
const param = (url: URL, name: string) => {
	const value = url.searchParams.get(name)?.trim();
	return value ? value.slice(0, 120) : null;
};

/**
 * Where this request came from. The referrer is reduced to its host, and only when
 * it is another site: an internal navigation is not a touch.
 */
export const touchFrom = (request: Request): TTouch => {
	const url = new URL(request.url);
	let referrerHost: string | null = null;
	try {
		const referrer = request.headers.get("Referer");
		if (referrer) {
			const host = new URL(referrer).hostname;
			if (host && host !== url.hostname) referrerHost = host.slice(0, 255);
		}
	} catch {
		// A malformed Referer is no touch at all.
	}
	const country = (request as Request & { cf?: { country?: unknown } }).cf
		?.country;
	return {
		clickIdKind: C_CLICK_IDS.find((name) => url.searchParams.has(name)) ?? null,
		country: typeof country === "string" && country.length === 2 ? country : null,
		landingPath: url.pathname.slice(0, 200),
		referrerHost,
		utmCampaign: param(url, "utm_campaign"),
		utmContent: param(url, "utm_content"),
		utmMedium: param(url, "utm_medium"),
		utmSource: param(url, "utm_source"),
		utmTerm: param(url, "utm_term"),
	};
};

type TWho = {
	idOrganization?: string | null;
	idUser?: string | null;
	/** From requireOrganization: support acting as a customer. */
	impersonatedBy?: string | null;
};

/**
 * Record one event from a web request. The ONLY way routes write events, so the
 * three rules live here and nowhere else:
 *
 *   1. A behavioural event is dropped when analytics is not permitted.
 *   2. The visitor id is attached only when permitted (visitorIdFrom).
 *   3. Nothing is recorded while support is impersonating a customer: those clicks
 *      are ours, and counting them would teach a model that support is a customer.
 */
export const trackEvent = async <N extends TEventName>(input: {
	context: { cloudflare: { ctx: ExecutionContext; env: Env } };
	name: N;
	props: TEventProps<N>;
	request: Request;
	who?: TWho;
}) => {
	if (input.who?.impersonatedBy) return;
	if (isBehaviouralEvent(input.name) && !isAnalyticsPermitted(input.request))
		return;
	await recordEvent({
		ctx: input.context.cloudflare.ctx,
		db: input.context.cloudflare.env.DB,
		idOrganization: input.who?.idOrganization ?? null,
		idUser: input.who?.idUser ?? null,
		idVisitor: visitorIdFrom(input.request),
		name: input.name,
		path: new URL(input.request.url).pathname,
		props: input.props,
		source: "web",
	});
};
