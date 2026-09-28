import { redirect } from "react-router";
import { getAuth } from "@/services/auth.server";
import type { Route } from "./+types/sign-out";

/**
 * POST only. A GET sign-out is triggerable by any image tag or link prefetch on
 * another site, which logs the user out without their asking.
 */
export const action = async ({ request, context }: Route.ActionArgs) => {
	const auth = getAuth({ env: context.cloudflare.env, request });
	const response = await auth.api.signOut({
		headers: request.headers,
		asResponse: true,
	});

	// Carry Better Auth's Set-Cookie through onto the redirect; dropping it
	// leaves the session cookie in place and the user still signed in.
	const headers = new Headers();
	for (const cookie of response.headers.getSetCookie()) {
		headers.append("Set-Cookie", cookie);
	}
	headers.set("Location", "/");
	return new Response(null, { status: 302, headers });
};

export const loader = () => redirect("/");
