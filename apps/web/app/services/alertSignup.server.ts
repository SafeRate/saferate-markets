import { resolveEmailProvider } from "@markets/email";
import {
	countAlertSignups,
	createAlertSignup,
	deleteAlertSignup,
} from "@markets/persistence";
import { resolveMarketsEnv, SENDER_ADDRESS } from "@markets/schema";
import { z } from "zod";
import { confirmSignupEmail } from "@/lib/alertEmails";
import { siteFor } from "./alerts.server";

/**
 * Sign-ups from outside Markets: saferate.com's /treasury/auctions posts here
 * server-side (POST /api/alerts/subscribe), agreed with treasury-integration
 * on 2026-10-09. Double opt-in: this only records the request and mails one
 * confirmation; nothing is subscribed until its link is followed.
 *
 * The contract (statuses are the caller's whole interface; do not add one
 * without telling saferate.com):
 *   202 confirmation_sent   show "check your inbox"
 *   400 invalid_email | invalid_request | invalid_turnstile
 *   401 unauthorized        the shared secret did not match
 *   429 rate_limited        per visitor address, with retry_after_seconds
 *   503 unavailable         nothing was sent; never show "check your inbox"
 *
 * There is no "already subscribed": answering that to an anonymous form would
 * tell anyone whether an address is on the list. A repeat within a day for
 * the same address is answered 202 and sends nothing.
 */

export const SIGNUP_TTL_MS = 48 * 60 * 60 * 1000;
const PER_IP_HOUR = 5;
const PER_IP_DAY = 20;
const HOUR = 60 * 60 * 1000;

const ZBody = z.object({
	email: z.string().trim().toLowerCase().email().max(254),
	daily: z.boolean().default(true),
	auctions: z.boolean().default(true),
	ref: z.string().max(200).optional(),
	turnstile: z.string().max(4096).optional(),
});

type TSignupEnv = Env & {
	ALERTS_SUBSCRIBE_SECRET?: string;
	TURNSTILE_SECRET_KEY?: string;
	EMAIL_RECIPIENT_ALLOWLIST?: string;
};

export type TSignupOutcome = {
	status: number;
	body: { status: string; retry_after_seconds?: number };
};

const out = (
	status: number,
	name: string,
	extra: Partial<TSignupOutcome["body"]> = {},
): TSignupOutcome => ({ status, body: { status: name, ...extra } });

const sameSecret = (a: string, b: string) => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
};

export const hashToken = async (token: string) =>
	[
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
		),
	]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

const newToken = () => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
};

/** Cloudflare Turnstile, checked server-side. A spent or expired token is the usual failure. */
const turnstileOk = async (
	secret: string,
	token: string,
	ip: string | null,
	fetcher: typeof fetch,
) => {
	const form = new FormData();
	form.set("secret", secret);
	form.set("response", token);
	if (ip) form.set("remoteip", ip);
	const response = await fetcher(
		"https://challenges.cloudflare.com/turnstile/v0/siteverify",
		{ method: "POST", body: form },
	);
	if (!response.ok) throw new Error(`Turnstile returned ${response.status}`);
	const result = (await response.json()) as { success?: boolean };
	return result.success === true;
};

export const handleAlertSignup = async (
	env: TSignupEnv,
	request: Request,
	fetcher: typeof fetch = fetch,
): Promise<TSignupOutcome> => {
	const expected = env.ALERTS_SUBSCRIBE_SECRET;
	const given = (request.headers.get("Authorization") ?? "").replace(
		/^Bearer\s+/i,
		"",
	);
	// No secret configured is a misconfiguration, and it must not open the door.
	if (!expected || !sameSecret(expected, given)) return out(401, "unauthorized");

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return out(400, "invalid_request");
	}
	const parsed = ZBody.safeParse(raw);
	if (!parsed.success)
		return out(
			400,
			parsed.error.issues.some((i) => i.path[0] === "email")
				? "invalid_email"
				: "invalid_request",
		);
	const body = parsed.data;
	if (!body.daily && !body.auctions) return out(400, "invalid_request");
	const ip = request.headers.get("X-Subscriber-IP")?.trim() || null;

	if (!env.TURNSTILE_SECRET_KEY) {
		console.error("[alerts] TURNSTILE_SECRET_KEY is not set; refusing sign-ups");
		return out(503, "unavailable");
	}
	// Cloudflare's always-pass test secrets verify any token, made-up ones
	// included, and nothing would look wrong. Staging uses one on purpose;
	// production must refuse to run on one rather than run unprotected.
	if (
		resolveMarketsEnv(env.MARKETS_ENV) === "production" &&
		/^[0-9]x0+AA$/.test(env.TURNSTILE_SECRET_KEY)
	) {
		console.error(
			"[alerts] a Turnstile TEST secret is set in production; refusing sign-ups",
		);
		return out(503, "unavailable");
	}
	if (!body.turnstile) return out(400, "invalid_turnstile");
	try {
		if (
			!(await turnstileOk(env.TURNSTILE_SECRET_KEY, body.turnstile, ip, fetcher))
		)
			return out(400, "invalid_turnstile");
	} catch (error) {
		console.error("[alerts] Turnstile check failed:", error);
		return out(503, "unavailable");
	}

	const now = Date.now();
	if (ip) {
		const [hour, day] = await Promise.all([
			countAlertSignups({
				db: env.DB,
				by: "ipAddress",
				value: ip,
				sinceMs: now - HOUR,
			}),
			countAlertSignups({
				db: env.DB,
				by: "ipAddress",
				value: ip,
				sinceMs: now - 24 * HOUR,
			}),
		]);
		if (hour >= PER_IP_HOUR || day >= PER_IP_DAY) {
			const retry = hour >= PER_IP_HOUR ? 3600 : 86_400;
			return out(429, "rate_limited", { retry_after_seconds: retry });
		}
	}
	// One confirmation per address per day, invisibly: the answer is the same.
	const recent = await countAlertSignups({
		db: env.DB,
		by: "email",
		value: body.email,
		sinceMs: now - 24 * HOUR,
	});
	if (recent > 0) return out(202, "confirmation_sent");

	const token = newToken();
	const idAlertSignup = await hashToken(token);
	await createAlertSignup({
		db: env.DB,
		idAlertSignup,
		signup: {
			email: body.email,
			rundown: body.daily,
			auctions: body.auctions,
			source: body.ref ?? null,
		},
		ipAddress: ip,
		ttlMs: SIGNUP_TTL_MS,
	});
	const email = confirmSignupEmail({
		confirmUrl: `${siteFor(env)}/alerts/confirm?t=${token}`,
		rundown: body.daily,
		auctions: body.auctions,
	});
	const sent = await resolveEmailProvider(env as never).send({
		to: body.email,
		from: SENDER_ADDRESS,
		...email,
	});
	if (sent.status === "failed") {
		console.error("[alerts] confirmation not sent:", sent.reason);
		// Otherwise a retry would be answered as a repeat and never mailed.
		await deleteAlertSignup({ db: env.DB, idAlertSignup });
		return out(503, "unavailable");
	}
	// "withheld" is staging's allowlist doing its job; the request was accepted.
	return out(202, "confirmation_sent");
};
