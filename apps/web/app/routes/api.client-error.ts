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
 * ⚠️ NO SERVER-SIDE RATE LIMIT. The defence is the client's own cap (5 reports
 * per page load, deduplicated), which stops a render loop and does not stop a
 * deliberate flood. Same trade as saferate-ai's consumer endpoint; add a limit
 * before treating this as abuse-resistant.
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
