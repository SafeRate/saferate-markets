import {
	DEMO_ORGANIZATION_ID,
	getOrganizationSubscription,
	isEntitled,
	listPortfolios,
} from "@markets/persistence";
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
	};
};

/**
 * The portfolio pages' gate, with three tiers (2026-10-01 the paid gate and
 * the demo; 2026-10-06 the free tier, FREE_TIER in @markets/schema):
 *
 *  - PAID: the account's own organization, no limits here.
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
export type TTier = "paid" | "free" | "demo";

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
	const ownsPortfolios =
		isPaid ||
		(await listPortfolios({ db: env.DB, idOrganization: org.idOrganization }))
			.length > 0;
	const tier: TTier = isPaid ? "paid" : ownsPortfolios ? "free" : "demo";
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
	};
};
