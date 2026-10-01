import {
	DEMO_ORGANIZATION_ID,
	getOrganizationSubscription,
	isEntitled,
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
 * The portfolio pages' gate (2026-10-01, Dylan: the tools need a paid plan,
 * and an account that has not paid tours a demo). Paid: the account's own
 * organization. Not paid: `idOrganization` is the shared DEMO organization
 * (migration 0006), read-only. Every read on those pages goes through
 * idOrganization unchanged, so the switch is here and nowhere else.
 *
 * READ-ONLY IS ENFORCED HERE, not by hiding forms: any non-GET request from
 * an unpaid account is refused before a page's action runs, so nothing can
 * write into the demo even if a form slipped through. Billing, keys and
 * sign-out keep requireOrganization: those are the account's own.
 */
export const requireDashboard = async (request: Request, env: Env) => {
	const org = await requireOrganization(request, env);
	const isPaid = isEntitled(
		await getOrganizationSubscription({
			db: env.DB,
			idOrganization: org.idOrganization,
		}),
	);
	if (!isPaid && request.method !== "GET" && request.method !== "HEAD")
		throw data(
			"The demo is read-only. Subscribe to add and manage your own portfolios.",
			{ status: 402 },
		);
	return {
		...org,
		/** The account's own organization, for billing, keys and usage. */
		idOrganizationOwn: org.idOrganization,
		/** Whose portfolios, streams and plans this page reads: the demo's when unpaid. */
		idOrganization: isPaid ? org.idOrganization : DEMO_ORGANIZATION_ID,
		isDemo: !isPaid,
	};
};
