import { FREE_TIER } from "@markets/schema";
import { Outlet } from "react-router";
import { DashboardNav } from "@/components/DashboardNav";
import { requireDashboard } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.layout";

/**
 * The frame every /dashboard page sits in: the left-hand menu and the page.
 * Each child still calls requireOrganization itself; React Router runs the
 * loaders in parallel, so this one gating does not protect the others.
 */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const org = await requireDashboard(request, context.cloudflare.env);
	// isDemo and tier are read by components/WriteGate through this route's id.
	return {
		organizationName: org.nameOrganization,
		isDemo: org.isDemo,
		tier: org.tier,
	};
};

export default function DashboardLayout({ loaderData }: Route.ComponentProps) {
	return (
		<div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 md:flex-row md:gap-10 md:px-6 md:py-10">
			<aside className="md:sticky md:top-6 md:w-56 md:shrink-0 md:self-start">
				<DashboardNav organizationName={loaderData.organizationName} />
			</aside>
			<div className="min-w-0 flex-1">
				{loaderData.isDemo ? (
					<div className="mb-6 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-slate-700">
						<span className="font-semibold text-primary">Demo.</span> You are touring
						Safe Rate's sample portfolios, liabilities and plan, read-only. Every
						Markets page is live.{" "}
						<a
							className="font-medium text-primary underline underline-offset-4"
							href="/dashboard/portfolios#new"
						>
							Start your own portfolio
						</a>
						, free while your holdings are worth under $
						{FREE_TIER.maxValueUsd.toLocaleString("en-US")}, or{" "}
						<a
							className="font-medium text-primary underline underline-offset-4"
							href="/dashboard/billing"
						>
							subscribe
						</a>
						.
					</div>
				) : loaderData.tier === "free" ? (
					<div className="mb-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
						<span className="font-semibold text-slate-800">Free plan.</span> Up to{" "}
						{FREE_TIER.maxPortfolios} portfolios worth $
						{FREE_TIER.maxValueUsd.toLocaleString("en-US")} in total, in the
						dashboard.{" "}
						<a
							className="font-medium text-primary underline underline-offset-4"
							href="/dashboard/billing"
						>
							Subscribe
						</a>{" "}
						for more, and for the API and MCP.
					</div>
				) : null}
				<Outlet />
			</div>
		</div>
	);
}
