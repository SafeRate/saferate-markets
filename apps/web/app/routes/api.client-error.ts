import { recordSiteError } from "@markets/persistence";
import { z } from "zod";
import type { Route } from "./+types/api.client-error";

/**
 * Receive a browser exception from `lib/clientErrors.client.ts` and record it as
 * a `web-client` row in `siteErrors`, through the same sink as server failures.
 *
 * ⚠️ THE CLIENT IS NOT TRUSTED. Only `message`, `page` and `stack` are read,
 * each length-capped by the schema, and unknown keys are stripped. The row's
 * path is the page the browser NAMED, cut at any `?` or `#` in case a caller
 * sends one; it lands in a text column and is never rendered unescaped.
 *
 * RATE LIMITED per IP, twice. The client caps itself at 5 reports per page load,
 * which stops a render loop; CLIENT_ERROR_LIMITER (20/minute, wrangler.jsonc)
 * stops a deliberate flood of D1 writes. A refused report still answers 204 and
 * simply is not written: the visitor sees nothing different, and a flooder
 * learns nothing. Fails open: a limiter error must not cost a real report.
 *
 * 204 on anything but a malformed body: a visitor must never see a failed
 * request because telemetry could not be stored.
 */
export const ZClientErrorBody = z.object({
	message: z
		.string()
		.trim()
		.min(1)
		.max(2000)
		.transform((s) => s.slice(0, 500)),
	page: z
		.string()
		.max(2000)
		.nullish()
		.transform((s) => (s ? (s.split(/[?#]/)[0] ?? "").slice(0, 200) : null)),
	stack: z
		.string()
		.max(20_000)
		.nullish()
		.transform((s) => (s ? s.slice(0, 2000) : null)),
});

export const action = async ({ context, request }: Route.ActionArgs) => {
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return new Response("Malformed body", { status: 400 });
	}
	const parsed = ZClientErrorBody.safeParse(raw);
	if (!parsed.success) return new Response("Malformed body", { status: 400 });
	if (!(await isWithinClientErrorLimit(context.cloudflare.env, request))) {
		return new Response(null, { status: 204 });
	}

	recordSiteError({
		code: "web-client",
		ctx: context.cloudflare.ctx,
		db: context.cloudflare.env.DB,
		message: parsed.data.message,
		path: parsed.data.page,
		request,
		stack: parsed.data.stack,
	});
	return new Response(null, { status: 204 });
};

/**
 * CF-Connecting-IP, not X-Forwarded-For: Cloudflare sets the former and
 * overwrites any client copy. No IP (local dev) or no binding means no limit.
 */
const isWithinClientErrorLimit = async (env: Env, request: Request) => {
	const ip = request.headers.get("CF-Connecting-IP");
	if (!ip || !env.CLIENT_ERROR_LIMITER) return true;
	try {
		const { success } = await env.CLIENT_ERROR_LIMITER.limit({ key: ip });
		if (!success) console.warn(`[rate-limit] refused client-error for ${ip}`);
		return success;
	} catch (error) {
		console.error("[rate-limit] client-error limiter failed open:", error);
		return true;
	}
};
