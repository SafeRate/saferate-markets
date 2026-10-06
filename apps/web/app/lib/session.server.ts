import {
	DEMO_ORGANIZATION_ID,
	getOrganizationSubscription,
	isEntitled,
	listPortfolios,
} from "@markets/persistence";
import { isTrialActive } from "@markets/schema";
import { data, redirect } from "react-router";
import { getServerSession } from "@/services/auth.server";
import { ensureOrganization } from "@/services/organizations.server";

/**
 * The session and the organization every dashboard route needs, or a redirect
 * to sign-in. One place, so no dashboard route can forget either half.
 */
export const requireOrganization = async (request: Request, env: Env) => {
	const session = await getServerSession({ env, request });
	if (!session?.user?.id) throw redirect("/sign-in");
	const organization = await ensureOrganization({
		db: env.DB,
		idUser: session.user.id,
		email: session.user.email,
	});
	return {
		idUser: session.user.id,
		email: session.user.email,
		idOrganization: String(organization.idOrganization),
		nameOrganization: String(organization.nameOrganization),
		/** When the Team trial ends (epoch ms), or null for no trial. */
		trialEndsAt:
			typeof organization.trialEndsAt === "number"
				? organization.trialEndsAt
				: null,
	};
};

/**
 * The portfolio pages' gate, with four tiers (2026-10-01 the paid gate and
 * the demo; 2026-10-06 the free tier, FREE_TIER, and the trial, TRIAL, both in
 * @markets/schema):
 *
 *  - PAID: the account's own organization, no limits here.
 *  - TRIAL: the Team trial is running and there is no subscription: as paid,
 *    once the account has a portfolio of its own. Before that it tours the
 *    demo like anyone else, so a new account never lands on an empty page.
 *  - FREE: unpaid with at least one portfolio of its own: its own organization,
 *    writes allowed; the limits (two portfolios, $100,000) are checked by the
 *    actions that create portfolios and add trades (services/freeTier.server.ts).
 *  - DEMO: unpaid with none yet: the shared DEMO organization (migration 0006),
 *    read-only, apart from the one write that starts the free tier, creating a
 *    first portfolio, for which a route passes `startsFreeTier` and gets the
 *    account's own organization.
 *
 * Every read on those pages goes through idOrganization unchanged, so the
 * switch is here and nowhere else. A write into the demo is refused HERE, not
 * by hiding forms. Billing, keys and sign-out keep requireOrganization.
 */
export type TTier = "paid" | "trial" | "free" | "demo";

export const requireDashboard = async (
	request: Request,
	env: Env,
	options: { startsFreeTier?: boolean } = {},
) => {
	const org = await requireOrganization(request, env);
	const isPaid = isEntitled(
		await getOrganizationSubscription({
			db: env.DB,
			idOrganization: org.idOrganization,
		}),
	);
	const isTrial = !isPaid && isTrialActive(org.trialEndsAt);
	const ownsPortfolios =
		isPaid ||
		(await listPortfolios({ db: env.DB, idOrganization: org.idOrganization }))
			.length > 0;
	const tier: TTier = isPaid
		? "paid"
		: !ownsPortfolios
			? "demo"
			: isTrial
				? "trial"
				: "free";
	const isWrite = request.method !== "GET" && request.method !== "HEAD";
	if (tier === "demo" && isWrite && !options.startsFreeTier)
		throw data(
			"The demo is read-only. Start your own portfolio, free up to $100,000, or subscribe.",
			{ status: 402 },
		);
	const readsDemo = tier === "demo" && !(isWrite && options.startsFreeTier);
	return {
		...org,
		/** The account's own organization, for billing, keys and usage. */
		idOrganizationOwn: org.idOrganization,
		/** Whose portfolios, streams and plans this page reads: the demo's in the demo. */
		idOrganization: readsDemo ? DEMO_ORGANIZATION_ID : org.idOrganization,
		isDemo: readsDemo,
		tier,
		/** The free tier's limits apply: neither paid nor on a running trial. */
		isLimited: !isPaid && !isTrial,
	};
};
