import { FREE_TIER } from "@markets/schema";
import { createPortfolio, listPortfolios } from "@markets/persistence";
import { INCOME_POLICY_LABEL } from "@markets/portfolio";
import { PRODUCT_NAME } from "@markets/schema";
import { INDEX_META, isIndexCode } from "@saferate/treasury-client/types";
import { Form, Link, redirect, useNavigation } from "react-router";
import {
	BENCHMARK_OPTIONS,
	INCOME_OPTIONS,
	parseBenchmark,
	parsePolicy,
} from "@/lib/portfolioOptions";
import { useIsDemo } from "@/components/WriteGate";
import { freePortfolioLimitProblem } from "@/services/freeTier.server";
import { requireDashboard } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.portfolios";

export const meta: Route.MetaFunction = () => [
	{ title: `Portfolio Tracking | ${PRODUCT_NAME}` },
];

export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const org = await requireDashboard(request, env);
	return {
		portfolios: await listPortfolios({
			db: env.DB,
			idOrganization: org.idOrganization,
		}),
	};
};

export const action = async ({ request, context }: Route.ActionArgs) => {
	const env = context.cloudflare.env;
	// Creating a first portfolio is how an unpaid account leaves the demo and
	// starts the free tier, so this is the one write the demo allows.
	const org = await requireDashboard(request, env, { startsFreeTier: true });
	const form = await request.formData();
	const namePortfolio = String(form.get("namePortfolio") ?? "").trim();
	if (namePortfolio === "") return { error: "Give the portfolio a name." };
	if (org.tier !== "paid") {
		const problem = await freePortfolioLimitProblem({
			db: env.DB,
			idOrganization: org.idOrganization,
		});
		if (problem) return { error: problem };
	}
	const idPortfolio = await createPortfolio({
		db: env.DB,
		idOrganization: org.idOrganization,
		namePortfolio,
		codeBenchmark: parseBenchmark(form.get("codeBenchmark")),
		policyIncome: parsePolicy(form.get("policyIncome")),
	});
	return redirect(`/dashboard/portfolios/${idPortfolio}/transactions`);
};

const field =
	"mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm";

export default function Portfolios({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const { portfolios } = loaderData;
	const isDemo = useIsDemo();
	const busy = useNavigation().state !== "idle";
	return (
		<main className="max-w-4xl">
			<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
				Portfolio Tracking
			</h1>
			<p className="mt-2 text-sm text-slate-600">
				Enter or upload your trades; value, income, returns against a Safe Rate
				index and risk are computed from them and the daily Treasury closes. Bills,
				notes, bonds, TIPS and floating rate notes.
			</p>

			{portfolios.length > 0 ? (
				<div className="mt-8 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
					<table className="w-full text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className="px-4 py-2 font-semibold">Portfolio</th>
								<th className="px-4 py-2 font-semibold">Benchmark</th>
								<th className="px-4 py-2 font-semibold">Income</th>
								<th className="px-4 py-2 text-right font-semibold">Trades</th>
							</tr>
						</thead>
						<tbody>
							{portfolios.map((p) => (
								<tr className="border-t border-slate-100" key={p.idPortfolio}>
									<td className="px-4 py-2">
										<Link
											className="font-medium text-primary underline-offset-4 hover:underline"
											to={`/dashboard/portfolios/${p.idPortfolio}`}
										>
											{p.namePortfolio}
										</Link>
									</td>
									<td className="px-4 py-2 text-slate-600">
										{p.codeBenchmark !== null && isIndexCode(p.codeBenchmark)
											? INDEX_META[p.codeBenchmark].name
											: "None"}
									</td>
									<td className="px-4 py-2 text-slate-600">
										{INCOME_POLICY_LABEL[p.policyIncome]}
									</td>
									<td className="tabular px-4 py-2 text-right">
										{p.countTransactions ?? 0}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="mt-8 rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-600">
					No portfolios yet. Create one below, then add trades by hand or from a CSV.
				</p>
			)}

			<section
				className="mt-10 scroll-mt-24 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
				id="new"
			>
				<h2 className="font-semibold text-neutral-900">
					{isDemo ? "Start your own portfolio, free" : "New portfolio"}
				</h2>
				{isDemo ? (
					<p className="mt-1 text-sm text-slate-600">
						Free for up to {FREE_TIER.maxPortfolios} portfolios worth $
						{FREE_TIER.maxValueUsd.toLocaleString("en-US")} in total. Creating one
						switches the dashboard from the demo to your own Treasuries.
					</p>
				) : null}
				{/* Not a WriteGate: creating a first portfolio is how the demo starts
				    the free tier, so the form shows in the demo too. */}
				<Form className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3" method="post">
					<label className="text-sm font-medium text-slate-700">
						Name
						<input className={field} maxLength={80} name="namePortfolio" required />
					</label>
					<label className="text-sm font-medium text-slate-700">
						Benchmark
						<select className={field} defaultValue="broad" name="codeBenchmark">
							<option value="">None</option>
							{BENCHMARK_OPTIONS.map((o) => (
								<option key={o.code} value={o.code}>
									{o.label}
								</option>
							))}
						</select>
					</label>
					<label className="text-sm font-medium text-slate-700">
						Coupons and proceeds
						<select className={field} defaultValue="cash" name="policyIncome">
							{INCOME_OPTIONS.map((o) => (
								<option key={o.policy} value={o.policy}>
									{o.label}
								</option>
							))}
						</select>
					</label>
					<div className="sm:col-span-3">
						{actionData?.error ? (
							<p className="mb-2 text-sm text-red-700">{actionData.error}</p>
						) : null}
						<button
							className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
							disabled={busy}
							type="submit"
						>
							Create portfolio
						</button>
					</div>
				</Form>
			</section>
		</main>
	);
}
