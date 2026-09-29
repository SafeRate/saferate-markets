import { Outlet } from "react-router";
import { DashboardNav } from "@/components/DashboardNav";
import { requireOrganization } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.layout";

/**
 * The frame every /dashboard page sits in: the left-hand menu and the page.
 * Each child still calls requireOrganization itself; React Router runs the
 * loaders in parallel, so this one gating does not protect the others.
 */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const org = await requireOrganization(request, context.cloudflare.env);
	return { organizationName: org.nameOrganization };
};

export default function DashboardLayout({ loaderData }: Route.ComponentProps) {
	return (
		<div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 md:flex-row md:gap-10 md:px-6 md:py-10">
			<aside className="md:sticky md:top-6 md:w-56 md:shrink-0 md:self-start">
				<DashboardNav organizationName={loaderData.organizationName} />
			</aside>
			<div className="min-w-0 flex-1">
				<Outlet />
			</div>
		</div>
	);
}
