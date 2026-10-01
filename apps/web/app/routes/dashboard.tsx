import {
	countActiveApiKeys,
	currentPeriodMonth,
	getMonthlyUsage,
	getOrganizationSubscription,
	isEntitled,
	listPortfolios,
	listTransactions,
} from "@markets/persistence";
import { checkoutPlanById, PRODUCT_NAME } from "@markets/schema";
import { Link } from "react-router";
import { LineChart } from "@/components/LineChart";
import { describeSecurity, money, percent, signClass } from "@/lib/format";
import { requireDashboard } from "@/lib/session.server";
import { valuePortfolio } from "@/services/portfolio.server";
import type { Route } from "./+types/dashboard";

export const meta: Route.MetaFunction = () => [
	{ title: `Dashboard — ${PRODUCT_NAME}` },
];

/**
 * THE HONESTY RULE (OKLocate's): every number here is either real or explicitly
 * absent. The overview leads with the customer's portfolio, valued by the same
 * valuePortfolio the Tracking page uses, so the two cannot disagree; with
 * several, ?portfolio= picks one (the first with trades by default). Usage IS
 * measured from the first request, so a zero this month is a real zero. The
 * plan is read from organizationSubscriptions, the same record the API's
 * entitlement check reads.
 */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const org = await requireDashboard(request, env);
	// Portfolios are the demo's for an unpaid account; plan, keys and usage are
	// always the account's own.
	const scope = { db: env.DB, idOrganization: org.idOrganization };
	const own = { db: env.DB, idOrganization: org.idOrganizationOwn };
	const period = currentPeriodMonth();
	const [usage, subscription, activeKeys, portfolios] = await Promise.all([
		getMonthlyUsage({ ...own, limitMonths: 1 }),
		getOrganizationSubscription(own),
		countActiveApiKeys(own),
		listPortfolios(scope),
	]);
	const thisMonth = usage.filter((u) => u.periodMonth === period);
	const count = (surface: "rest" | "mcp") =>
		thisMonth.find((u) => u.surface === surface)?.countRequests ?? 0;

	const asked = new URL(request.url).searchParams.get("portfolio");
	const selected =
		portfolios.find((p) => p.idPortfolio === asked) ??
		portfolios.find((p) => (p.countTransactions ?? 0) > 0) ??
		portfolios[0] ??
		null;
	const valued =
		selected === null
			? null
			: await valuePortfolio({
					env,
					transactions: await listTransactions({
						...scope,
						idPortfolio: selected.idPortfolio,
					}),
					codeBenchmark: selected.codeBenchmark,
					policyIncome: selected.policyIncome,
					custom: null,
					// The cheapest period to attribute; the overview shows no attribution.
					attributionPeriod: "mtd",
				});

	return {
		hasPlan: isEntitled(subscription),
		planName: isEntitled(subscription)
			? (checkoutPlanById(subscription?.idPlan)?.name ?? "Unknown plan")
			: null,
		email: org.email,
		organizationName: org.nameOrganization,
		activeKeys,
		period,
		restRequests: count("rest"),
		mcpRequests: count("mcp"),
		portfolios: portfolios.map((p) => ({
			idPortfolio: p.idPortfolio,
			namePortfolio: p.namePortfolio,
		})),
		selected,
		overview:
			valued === null
				? null
				: valued.status !== "valued"
					? valued
					: {
							status: "valued" as const,
							asOf: valued.asOf,
							benchmark: valued.benchmark,
							summary: valued.summary,
							periods: valued.periods,
							series: valued.series,
							staleMarks: valued.staleMarks,
							topHoldings: [...valued.positions]
								.sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0))
								.slice(0, 5)
								.map((p) => ({
									cusip: p.cusip,
									info: p.info,
									marketValue: p.marketValue,
								})),
							countHoldings: valued.positions.length,
						},
	};
};

const Stat = ({
	label,
	value,
	className = "",
}: {
	label: string;
	value: string;
	className?: string;
}) => (
	<div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
		<p className="text-xs uppercase tracking-wide text-muted-foreground">
			{label}
		</p>
		<p
			className={`tabular mt-2 text-2xl font-semibold text-neutral-900 ${className}`}
		>
			{value}
		</p>
	</div>
);

const link = "text-primary underline underline-offset-4";
const th = "px-3 py-2 font-semibold";
const td = "tabular px-3 py-2";

type TLoader = Route.ComponentProps["loaderData"];

const PortfolioPicker = ({
	portfolios,
	selected,
}: {
	portfolios: TLoader["portfolios"];
	selected: string;
}) => (
	<form className="flex items-center gap-2 text-sm" method="get">
		<label className="text-muted-foreground" htmlFor="portfolio">
			Portfolio
		</label>
		<select
			className="rounded-md border border-slate-300 bg-white px-2 py-1"
			defaultValue={selected}
			id="portfolio"
			name="portfolio"
			onChange={(e) => e.currentTarget.form?.requestSubmit()}
		>
			{portfolios.map((p) => (
				<option key={p.idPortfolio} value={p.idPortfolio}>
					{p.namePortfolio}
				</option>
			))}
		</select>
		<noscript>
			<button className={link} type="submit">
				Show
			</button>
		</noscript>
	</form>
);

const PortfolioOverview = ({ d }: { d: TLoader }) => {
	const selected = d.selected;
	if (selected === null || d.overview === null)
		return (
			<section className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
				<h2 className="font-semibold text-neutral-900">
					Track a Treasury portfolio
				</h2>
				<p className="mt-2 text-sm text-muted-foreground">
					Enter trades or upload a blotter to see value, returns against a Safe Rate
					index, attribution and risk. Or start from what you owe: save a liability
					stream and let the Builder draft the order sheet.
				</p>
				<div className="mt-4 flex flex-wrap gap-6 text-sm">
					<Link className={link} to="/dashboard/portfolios">
						Create a portfolio
					</Link>
					<Link className={link} to="/dashboard/builder">
						Build one from a budget or liabilities
					</Link>
					<Link className={link} to="/dashboard/liabilities">
						Save a liability stream
					</Link>
				</div>
			</section>
		);

	const o = d.overview;
	const open = `/dashboard/portfolios/${selected.idPortfolio}`;
	const heading = (
		<div className="mt-8 flex flex-wrap items-center justify-between gap-3">
			<h2 className="text-lg font-semibold text-neutral-900">
				{selected.namePortfolio}
			</h2>
			{d.portfolios.length > 1 ? (
				<PortfolioPicker
					portfolios={d.portfolios}
					selected={selected.idPortfolio}
				/>
			) : null}
		</div>
	);

	if (o.status === "empty")
		return (
			<>
				{heading}
				<p className="mt-3 text-sm text-muted-foreground">
					No trades yet.{" "}
					<Link className={link} to={`${open}/transactions`}>
						Add trades
					</Link>{" "}
					to see value and returns.
				</p>
			</>
		);
	if (o.status === "problems")
		return (
			<>
				{heading}
				<div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
					<p className="font-semibold">
						This portfolio cannot be valued until these are fixed:
					</p>
					<ul className="mt-2 list-disc space-y-1 pl-5">
						{o.problems.map((p) => (
							<li key={p}>{p}</li>
						))}
					</ul>
					<Link className={`${link} mt-2 inline-block`} to={`${open}/transactions`}>
						Fix the trades
					</Link>
				</div>
			</>
		);

	const s = o.summary;
	const inception = o.periods.find((p) => p.key === "inception");
	return (
		<>
			{heading}
			<p className="mt-1 text-xs text-muted-foreground">
				Valued at the {o.asOf} close
				{o.benchmark ? `, against the ${o.benchmark.name}` : ""}.
				{o.staleMarks > 0
					? ` ${o.staleMarks} holding${o.staleMarks === 1 ? " has" : "s have"} no close that day and use the last one.`
					: ""}
			</p>
			<section className="mt-4 grid gap-4 sm:grid-cols-4">
				{/* The ledger's market value already includes cash; adding it again
				    showed Test 13's $750M block as $1.0B (found 2026-09-29). */}
				<Stat label="Market value" value={money(s.marketValue)} />
				<Stat
					className={signClass(s.totalGain)}
					label="Total gain"
					value={money(s.totalGain)}
				/>
				<Stat
					className={signClass(inception?.cumulative ?? null)}
					label="Return since inception"
					value={percent(inception?.cumulative ?? null)}
				/>
				<Stat
					label="Money-weighted, a year"
					value={percent(s.moneyWeighted ?? null)}
				/>
			</section>

			<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
				<table className="w-full text-sm">
					<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
						<tr>
							<th className={th}>Period</th>
							<th className={`${th} text-right`}>Portfolio</th>
							{o.benchmark ? (
								<>
									<th className={`${th} text-right`}>Benchmark</th>
									<th className={`${th} text-right`}>Difference</th>
								</>
							) : null}
						</tr>
					</thead>
					<tbody>
						{o.periods.map((p) => (
							<tr className="border-t border-slate-100" key={p.key}>
								<td className="px-3 py-2">
									{p.label}
									{p.isFullPeriod ? null : (
										<span className="ml-1 text-xs text-muted-foreground">
											from {p.start}
										</span>
									)}
								</td>
								<td className={`${td} text-right ${signClass(p.cumulative)}`}>
									{percent(p.cumulative)}
								</td>
								{o.benchmark ? (
									<>
										<td className={`${td} text-right`}>
											{percent(p.benchmarkCumulative)}
										</td>
										<td className={`${td} text-right`}>
											{p.cumulative === null || p.benchmarkCumulative === null
												? "—"
												: `${((p.cumulative - p.benchmarkCumulative) * 10_000).toFixed(0)} bp`}
										</td>
									</>
								) : null}
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<div className="mt-4 grid gap-4 lg:grid-cols-5">
				<div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:col-span-3">
					<p className="text-xs uppercase tracking-wide text-muted-foreground">
						Growth of $100
					</p>
					<LineChart
						format={(value) => `$${value.toFixed(2)}`}
						height={160}
						series={[
							{
								label: selected.namePortfolio,
								className: "stroke-primary",
								points: o.series.map((p) => ({ date: p.date, value: p.growth * 100 })),
							},
							...(o.benchmark
								? [
										{
											label: o.benchmark.name,
											className: "stroke-slate-400",
											points: o.series.map((p) => ({
												date: p.date,
												value: p.benchmarkGrowth === null ? null : p.benchmarkGrowth * 100,
											})),
										},
									]
								: []),
						]}
					/>
				</div>
				<div className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm lg:col-span-2">
					<p className="text-xs uppercase tracking-wide text-muted-foreground">
						Largest holdings
						{o.countHoldings > o.topHoldings.length
							? `, ${o.topHoldings.length} of ${o.countHoldings}`
							: ""}
					</p>
					{o.topHoldings.length === 0 ? (
						<p className="mt-2 text-muted-foreground">Nothing held: all cash.</p>
					) : (
						<ul className="mt-2 space-y-1">
							{o.topHoldings.map((h) => (
								<li className="flex justify-between gap-3" key={h.cusip}>
									<span>
										{describeSecurity(h.info)}{" "}
										<span className="text-xs text-muted-foreground">{h.cusip}</span>
									</span>
									<span className="tabular">{money(h.marketValue)}</span>
								</li>
							))}
						</ul>
					)}
					{s.cash !== 0 ? (
						<p className="mt-2 flex justify-between border-t border-slate-100 pt-2">
							<span>Cash</span>
							<span className="tabular">{money(s.cash)}</span>
						</p>
					) : null}
				</div>
			</div>

			<nav className="mt-4 flex flex-wrap gap-6 text-sm">
				<Link className={link} to={open}>
					Open the portfolio
				</Link>
				<Link
					className={link}
					to={`/dashboard/stress?portfolio=${selected.idPortfolio}`}
				>
					Stress test it
				</Link>
				<Link className={link} to={`${open}/transactions`}>
					Trades
				</Link>
			</nav>
		</>
	);
};

export default function Dashboard({ loaderData }: Route.ComponentProps) {
	const d = loaderData;
	return (
		<main className="max-w-5xl">
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				{d.organizationName}
			</p>
			<h1 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900">
				Dashboard
			</h1>
			<p className="mt-2 text-sm text-muted-foreground">Signed in as {d.email}.</p>

			<PortfolioOverview d={d} />

			<section className="mt-10 rounded-lg border border-border p-4 text-sm">
				<p className="text-xs uppercase tracking-wide text-muted-foreground">
					Account
				</p>
				<p className="mt-2">
					{d.hasPlan ? (
						`${d.planName}, active.`
					) : (
						<>
							No plan yet, so API keys will be refused.{" "}
							<a className={link} href="/dashboard/billing">
								Subscribe
							</a>
						</>
					)}{" "}
					<span className="text-muted-foreground">
						API this month ({d.period}):{" "}
						<span className="tabular">{d.restRequests.toLocaleString("en-US")}</span>{" "}
						REST and{" "}
						<span className="tabular">{d.mcpRequests.toLocaleString("en-US")}</span>{" "}
						MCP requests on{" "}
						<span className="tabular">{d.activeKeys.toLocaleString("en-US")}</span>{" "}
						active key{d.activeKeys === 1 ? "" : "s"}.
					</span>
				</p>
				<div className="mt-3 flex flex-wrap gap-6">
					<a className={link} href="/dashboard/keys">
						API &amp; MCP
					</a>
					<a className={link} href="/dashboard/billing">
						Billing
					</a>
					<a className={link} href="/docs">
						Docs
					</a>
					<form action="/sign-out" method="post">
						<button
							className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
							type="submit"
						>
							Sign out
						</button>
					</form>
				</div>
			</section>
		</main>
	);
}
