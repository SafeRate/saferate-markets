import { listBuilderPlans } from "@markets/persistence";
import { PRODUCT_NAME } from "@markets/schema";
import { Link } from "react-router";
import { money } from "@/lib/format";
import { requireDashboard } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.execution";

export const meta: Route.MetaFunction = () => [
	{ title: `Trade Execution — ${PRODUCT_NAME}` },
];

const METHOD_LABEL: Record<string, string> = {
	match: "Cash-flow matching",
	immunise: "Immunization",
	horizon: "Horizon matching",
	strategy: "Strategy",
	index: "Index tracking",
	custom: "Your own",
};

export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const org = await requireDashboard(request, env);
	const plans = await listBuilderPlans({
		db: env.DB,
		idOrganization: org.idOrganization,
	});
	return {
		plans: plans.map((p) => ({
			idPlan: p.idPlan,
			namePlan: p.namePlan,
			method: METHOD_LABEL[p.method] ?? p.method,
			asOf: p.asOf,
			cost: p.cost,
			positions: (JSON.parse(p.positionsJson) as unknown[]).length,
		})),
	};
};

export default function Execution({ loaderData }: Route.ComponentProps) {
	return (
		<main className="max-w-5xl">
			<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
				Trade Execution
			</h1>
			<p className="mt-2 text-sm text-slate-600">
				Order sheets from saved Builder plans, split between the secondary market
				(any broker or custodian) and TreasuryDirect's auctions. Download one for
				your broker, or track it as a portfolio. Sending orders to a broker
				directly, starting with Interactive Brokers, comes later.
			</p>
			{loaderData.plans.length === 0 ? (
				<p className="mt-8 rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-600">
					No saved plans yet.{" "}
					<Link
						className="text-primary underline underline-offset-4"
						to="/dashboard/builder"
					>
						Build one in the Portfolio Builder
					</Link>
					.
				</p>
			) : (
				<div className="mt-8 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
					<table className="w-full text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className="px-4 py-2 font-semibold">Plan</th>
								<th className="px-4 py-2 font-semibold">Method</th>
								<th className="px-4 py-2 font-semibold">Priced</th>
								<th className="px-4 py-2 text-right font-semibold">Orders</th>
								<th className="px-4 py-2 text-right font-semibold">Cost</th>
								<th className="px-4 py-2" />
							</tr>
						</thead>
						<tbody>
							{loaderData.plans.map((p) => (
								<tr className="border-t border-slate-100" key={p.idPlan}>
									<td className="px-4 py-2">
										<Link
											className="font-medium text-primary hover:underline"
											to={`/dashboard/plans/${p.idPlan}`}
										>
											{p.namePlan}
										</Link>
									</td>
									<td className="px-4 py-2 text-slate-600">{p.method}</td>
									<td className="tabular px-4 py-2 text-slate-600">{p.asOf}</td>
									<td className="tabular px-4 py-2 text-right">{p.positions}</td>
									<td className="tabular px-4 py-2 text-right">{money(p.cost)}</td>
									<td className="px-4 py-2 text-right">
										<a
											className="text-xs text-primary underline underline-offset-4"
											href={`/dashboard/plans/${p.idPlan}/orders.csv`}
										>
											CSV
										</a>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</main>
	);
}
