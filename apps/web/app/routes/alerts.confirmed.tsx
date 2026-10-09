import {
	getAlertPreferences,
	getConfirmedAlertSignup,
	putAlertPreferences,
} from "@markets/persistence";
import { redirect } from "react-router";
import { requireOrganization } from "@/lib/session.server";
import type { Route } from "./+types/alerts.confirmed";

/**
 * Where a confirmed sign-up lands once signed in: apply what they ticked on
 * top of what they already had (a sign-up only ever turns alerts on), then
 * open their alerts page, where the term filter is. Applied only when the
 * sign-up's address is the signed-in one.
 */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const { idUser, email } = await requireOrganization(request, env);
	const id = new URL(request.url).searchParams.get("s") ?? "";
	const signup = id
		? await getConfirmedAlertSignup({ db: env.DB, idAlertSignup: id })
		: null;
	if (!signup || signup.email !== email.trim().toLowerCase())
		throw redirect("/dashboard/alerts");
	const current = await getAlertPreferences({ db: env.DB, idUser });
	await putAlertPreferences({
		db: env.DB,
		idUser,
		source: signup.source,
		preferences: {
			...current,
			rundown: current.rundown || signup.rundown,
			auctionResults: current.auctionResults || signup.auctions,
			auctionAnnouncements: current.auctionAnnouncements || signup.auctions,
			paused: false,
		},
	});
	throw redirect("/dashboard/alerts?confirmed=1");
};
