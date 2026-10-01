import { requireOrganization } from "@/lib/session.server";
import { searchSecurities } from "@/services/securitySearch.server";
import type { Route } from "./+types/dashboard.securities.search";

/** CUSIP search for the trade form: JSON, signed-in only. See services/securitySearch.server.ts. */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	await requireOrganization(request, env);
	const q = new URL(request.url).searchParams.get("q") ?? "";
	return Response.json({ results: await searchSecurities(env, q) });
};
