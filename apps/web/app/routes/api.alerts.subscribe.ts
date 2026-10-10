import { handleAlertSignup } from "@/services/alertSignup.server";
import type { Route } from "./+types/api.alerts.subscribe";

/** POST only: saferate.com's server-side sign-up (services/alertSignup.server.ts). */
export const loader = () =>
	Response.json({ status: "method_not_allowed" }, { status: 405 });

export const action = async ({ request, context }: Route.ActionArgs) => {
	if (request.method !== "POST")
		return Response.json({ status: "method_not_allowed" }, { status: 405 });
	const { status, body } = await handleAlertSignup(
		context.cloudflare.env,
		request,
	);
	return Response.json(body, {
		status,
		headers:
			status === 429 && body.retry_after_seconds
				? { "Retry-After": String(body.retry_after_seconds) }
				: undefined,
	});
};
