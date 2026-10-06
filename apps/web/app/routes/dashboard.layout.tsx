import {
	FREE_TIER,
	isTrialActive,
	TRIAL,
	trialDaysLeft,
	trialLastDay,
} from "@markets/schema";
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
	// The trial as the banner states it, worked out here so the server and the
	// browser cannot render different days. Null when paid or not on a trial.
	const trial =
		!org.isLimited && org.tier !== "paid" && isTrialActive(org.trialEndsAt)
			? {
					daysLeft: trialDaysLeft(org.trialEndsAt as number),
					ends: trialLastDay(org.trialEndsAt as number),
				}
			: null;
	return {
		organizationName: org.nameOrganization,
		isDemo: org.isDemo,
		tier: org.tier,
		trial,
	};
};

const dayCount = (days: number) => (days === 1 ? "1 day" : `${days} days`);

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
						{loaderData.trial ? (
							<>
								Your {TRIAL.days}-day Team trial is running (
								{dayCount(loaderData.trial.daysLeft)} left):{" "}
								<a
									className="font-medium text-primary underline underline-offset-4"
									href="/dashboard/portfolios#new"
								>
									start your own portfolio
								</a>
								, with no limits, and{" "}
								<a
									className="font-medium text-primary underline underline-offset-4"
									href="/dashboard/keys"
								>
									create an API key
								</a>{" "}
								for the REST API and MCP.
							</>
						) : (
							<>
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
							</>
						)}
					</div>
				) : loaderData.trial ? (
					<div className="mb-6 rounded-xl border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm text-slate-700">
						<span className="font-semibold text-primary">
							Team trial, {dayCount(loaderData.trial.daysLeft)} left.
						</span>{" "}
						Everything is included, the API and MCP too, through{" "}
						{loaderData.trial.ends}.{" "}
						<a
							className="font-medium text-primary underline underline-offset-4"
							href="/dashboard/billing"
						>
							Subscribe
						</a>{" "}
						to keep it. Otherwise the account moves to the free plan and nothing is
						deleted.
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
