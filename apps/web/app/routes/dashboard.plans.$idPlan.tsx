import {
	addTransactions,
	createPortfolio,
	deleteBuilderPlan,
	getBuilderPlan,
	getLiabilityStream,
} from "@markets/persistence";
import { PRODUCT_NAME } from "@markets/schema";
import { data, Form, Link, redirect } from "react-router";
import { describeSecurity, face, money, price } from "@/lib/format";
import { orderLines } from "@/lib/orders";
import { requireOrganization } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.plans.$idPlan";

export const meta: Route.MetaFunction = ({ data: loaded }) => [
	{ title: `${loaded?.plan.namePlan ?? "Plan"} — ${PRODUCT_NAME}` },
];

export const loader = async ({
	request,
	context,
	params,
}: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const org = await requireOrganization(request, env);
	const plan = await getBuilderPlan({
		db: env.DB,
		idOrganization: org.idOrganization,
		idPlan: params.idPlan,
	});
	if (plan === null) throw data("No such plan.", { status: 404 });
	const stream =
		plan.idLiabilityStream === null
			? null
			: await getLiabilityStream({
					db: env.DB,
					idOrganization: org.idOrganization,
					idLiabilityStream: plan.idLiabilityStream,
				});
	return {
		plan,
		lines: orderLines(plan),
		streamName: stream?.nameLiabilityStream ?? null,
	};
};

export const action = async ({
	request,
	context,
	params,
}: Route.ActionArgs) => {
	const env = context.cloudflare.env;
	const org = await requireOrganization(request, env);
	const scope = { db: env.DB, idOrganization: org.idOrganization };
	const plan = await getBuilderPlan({ ...scope, idPlan: params.idPlan });
	if (plan === null) throw data("No such plan.", { status: 404 });
	const form = await request.formData();
	const intent = String(form.get("intent"));
	if (intent === "delete") {
		if (form.get("confirm") !== "yes")
			return { error: "Tick the box to confirm the delete." };
		await deleteBuilderPlan({ ...scope, idPlan: plan.idPlan });
		return redirect("/dashboard/execution");
	}
	if (intent === "portfolio") {
		// A paper portfolio: the plan's buys at its limit prices, on its price
		// date, settling when it would have. Adjust the trades to what was filled.
		const idPortfolio = await createPortfolio({
			...scope,
			namePortfolio: plan.namePlan,
			codeBenchmark: null,
			policyIncome: "cash",
		});
		await addTransactions({
			...scope,
			idPortfolio,
			idUser: org.idUser,
			source: "manual",
			transactions: plan.positions.map((p) => ({
				cusip: p.cusip,
				side: "buy" as const,
				tradeDate: plan.asOf,
				settleDate: plan.settleDate,
				faceAmount: p.faceAmount,
				cleanPrice: p.planPrice,
				account: null,
			})),
		});
		return redirect(`/dashboard/portfolios/${idPortfolio}/transactions`);
	}
	return { error: "Unknown action." };
};

const th = "px-3 py-2 font-semibold";
const td = "tabular px-3 py-2";

export default function PlanPage({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const { plan, lines, streamName } = loaderData;
	const tdLines = lines.filter((l) => l.treasuryDirect.isClose);
	return (
		<main className="max-w-6xl">
			<p className="text-sm">
				<Link
					className="text-primary underline-offset-4 hover:underline"
					to="/dashboard/execution"
				>
					← Order sheets
				</Link>
			</p>
			<div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
				<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
					{plan.namePlan}
				</h1>
				<div className="flex gap-2">
					<a
						className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-semibold text-slate-700 hover:border-primary/40"
						href={`/dashboard/plans/${plan.idPlan}/orders.csv`}
					>
						Download order sheet (CSV)
					</a>
					<Form method="post">
						<input name="intent" type="hidden" value="portfolio" />
						<button
							className="rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
							type="submit"
						>
							Track as a portfolio
						</button>
					</Form>
				</div>
			</div>
			<p className="mt-1 text-sm text-slate-600">
				Priced at the {plan.asOf} close, settling {plan.settleDate}.{" "}
				{plan.positions.length} positions, {money(plan.cost)}.
				{streamName ? ` Funds ${streamName}.` : ""} Prices move: rebuild before
				trading if this is not today's.
			</p>

			<section className="mt-8">
				<h2 className="font-semibold text-neutral-900">
					Secondary market: any broker or custodian (IBKR, Apex...)
				</h2>
				<div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
					<table className="w-full text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className={th}>Side</th>
								<th className={th}>CUSIP</th>
								<th className={th}>Security</th>
								<th className={`${th} text-right`}>Face</th>
								<th className={`${th} text-right`}>Limit (clean)</th>
								<th className={`${th} text-right`}>Est. cost</th>
							</tr>
						</thead>
						<tbody>
							{lines.map((l) => (
								<tr className="border-t border-slate-100" key={l.cusip}>
									<td className="px-3 py-2 font-semibold text-emerald-700">BUY</td>
									<td className="px-3 py-2 font-mono text-xs">{l.cusip}</td>
									<td className="px-3 py-2">{describeSecurity(l)}</td>
									<td className={`${td} text-right`}>
										{face(l.faceAmount)}
										{l.faceAmount < 1_000_000 ? (
											<span className="block text-[10px] text-amber-700">odd lot</span>
										) : null}
									</td>
									<td className={`${td} text-right`}>{price(l.planPrice)}</td>
									<td className={`${td} text-right`}>{money(l.cost)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className="mt-2 text-xs text-slate-500">
					Limit prices are the close plus the plan's markup; estimated cost includes
					accrued interest to settlement. Day orders, prices per 100 of face. Odd
					lots (under $1 million face) trade, but dealers quote institutional prices
					for $1 million blocks, so expect a wider spread on them.
				</p>
			</section>

			<section className="mt-8">
				<h2 className="font-semibold text-neutral-900">TreasuryDirect</h2>
				<p className="mt-1 text-sm text-slate-600">
					TreasuryDirect buys only new issues at auction, non-competitive, up to $10
					million per security per auction, and cannot sell. So none of the
					securities above can be bought there as they are; where an auctioned term
					matures close to one, the new issue can stand in for it, bought at its next
					auction at a rate not known until then.
				</p>
				{tdLines.length === 0 ? (
					<p className="mt-3 text-sm text-slate-600">
						No position here has a close auctioned equivalent.
					</p>
				) : (
					<div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
						<table className="w-full text-sm">
							<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
								<tr>
									<th className={th}>Instead of</th>
									<th className={th}>Buy at auction</th>
									<th className={th}>Auctioned</th>
									<th className={`${th} text-right`}>Face</th>
									<th className={th}>Note</th>
								</tr>
							</thead>
							<tbody>
								{tdLines.map((l) => (
									<tr className="border-t border-slate-100" key={l.cusip}>
										<td className="px-3 py-2">
											<span className="font-mono text-xs">{l.cusip}</span>{" "}
											{describeSecurity(l)}
										</td>
										<td className="px-3 py-2 font-medium">{l.treasuryDirect.term}</td>
										<td className="px-3 py-2 text-slate-600">
											{l.treasuryDirect.cadence}
										</td>
										<td className={`${td} text-right`}>{face(l.faceAmount)}</td>
										<td className="px-3 py-2 text-xs text-slate-600">
											{l.treasuryDirect.overLimit
												? "Over $10m: split across auctions or buy the rest on the secondary market"
												: ""}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<p className="mt-2 text-xs text-slate-500">
					Exact auction dates come from Treasury's auction schedule, which Safe Rate
					will show here once it is stored.
				</p>
			</section>

			<section className="mt-10 border-t border-slate-100 pt-4">
				<Form className="flex flex-wrap items-center gap-3" method="post">
					<input name="intent" type="hidden" value="delete" />
					<label className="text-sm text-slate-600">
						<input className="mr-1" name="confirm" type="checkbox" value="yes" />
						Delete this plan permanently
					</label>
					<button
						className="text-sm text-red-700 underline underline-offset-4"
						type="submit"
					>
						Delete
					</button>
					{actionData?.error ? (
						<span className="text-sm text-red-700">{actionData.error}</span>
					) : null}
				</Form>
			</section>
		</main>
	);
}
