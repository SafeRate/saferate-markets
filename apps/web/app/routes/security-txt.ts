import { CONTACT_ADDRESS } from "@markets/schema";
import { canonicalOrigin } from "@/lib/canonicalOrigin";
import type { Route } from "./+types/security-txt";

/**
 * /.well-known/security.txt (RFC 9116): where to report a vulnerability. A
 * route rather than a static file because `Expires` is required and must stay
 * in the future: it is always 180 days from today, so the file never expires
 * unnoticed the way a committed date would.
 */
export const loader = ({ request, context }: Route.LoaderArgs) => {
	const origin = canonicalOrigin(context.cloudflare.env, request);
	const expires = new Date(Date.now() + 180 * 86_400_000);
	expires.setUTCHours(0, 0, 0, 0);
	return new Response(
		`Contact: mailto:${CONTACT_ADDRESS}
Expires: ${expires.toISOString()}
Preferred-Languages: en
Canonical: ${origin}/.well-known/security.txt
Policy: ${origin}/terms
`,
		{
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "public, max-age=86400",
			},
		},
	);
};
