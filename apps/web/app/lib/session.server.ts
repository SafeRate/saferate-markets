import { redirect } from "react-router";
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
