import { redirect } from "react-router";
import { rundownPath } from "@/lib/rundownText";
import { editionOf, latestRundownDate } from "@/services/dailyRundown.server";
import type { Route } from "./+types/daily-rundown.treasury";

/**
 * /daily-rundown/treasury: always the newest published rundown, so a link
 * built anywhere (saferate.com, an old email) never lands on a weekend or a
 * day not yet published. A temporary redirect, since the target moves daily.
 */
export const loader = async ({ context }: Route.LoaderArgs) => {
	const latest = await latestRundownDate(context.cloudflare.env);
	if (latest === null)
		throw new Response("No rundown is published yet.", { status: 503 });
	return redirect(rundownPath(editionOf(latest)), {
		status: 302,
		headers: { "Cache-Control": "no-store" },
	});
};
