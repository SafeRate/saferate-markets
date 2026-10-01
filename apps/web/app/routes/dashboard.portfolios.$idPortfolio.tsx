import { getPortfolio, listTransactions } from "@markets/persistence";
import { INCOME_POLICY_LABEL, parseDate } from "@markets/portfolio";
import { PRODUCT_NAME } from "@markets/schema";
import { data, Form, Link } from "react-router";
import { LineChart } from "@/components/LineChart";
import {
	describeSecurity,
	face,
	money,
	number,
	percent,
	price,
	rate,
	signClass,
} from "@/lib/format";
import { requireOrganization } from "@/lib/session.server";
import { valuePortfolio } from "@/services/portfolio.server";
import type { Route } from "./+types/dashboard.portfolios.$idPortfolio";

export const meta: Route.MetaFunction = ({ data: loaded }) => [
	{
		title: `${loaded?.portfolio.namePortfolio ?? "Portfolio"} — ${PRODUCT_NAME}`,
	},
];

export const loader = async ({
	request,
	context,
	params,
}: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const org = await requireOrganization(request, env);
	const portfolio = await getPortfolio({
		db: env.DB,
		idOrganization: org.idOrganization,
		idPortfolio: params.idPortfolio,
	});
	if (portfolio === null) throw data("No such portfolio.", { status: 404 });
	const url = new URL(request.url);
	const from = parseDate(url.searchParams.get("from") ?? "");
	const to = parseDate(url.searchParams.get("to") ?? "");
	const transactions = await listTransactions({
		db: env.DB,
		idOrganization: org.idOrganization,
		idPortfolio: portfolio.idPortfolio,
	});
	const ATTRIBUTION_PERIODS = [
		"mtd",
		"qtd",
		"ytd",
		"1y",
		"inception",
		"custom",
	] as const;
	const askedAttr = url.searchParams.get("attr") ?? "ytd";
	const attributionPeriod = (ATTRIBUTION_PERIODS as readonly string[]).includes(
		askedAttr,
	)
		? (askedAttr as (typeof ATTRIBUTION_PERIODS)[number])
		: "ytd";
	const valued = await valuePortfolio({
		env,
		transactions,
		codeBenchmark: portfolio.codeBenchmark,
		policyIncome: portfolio.policyIncome,
		custom: from !== null && to !== null && from < to ? { from, to } : null,
		attributionPeriod:
			attributionPeriod === "custom" &&
			!(from !== null && to !== null && from < to)
				? "ytd"
				: attributionPeriod,
	});
	return { portfolio, valued, from, to };
};

const Stat = ({
	label,
	value,
	hint,
	tone = "",
}: {
	label: string;
	value: string;
	hint?: string;
	tone?: string;
}) => (
	<div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
		<p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
		<p
			className={`tabular mt-1.5 text-xl font-semibold text-neutral-900 ${tone}`}
		>
			{value}
		</p>
		{hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
	</div>
);

const Section = ({
	title,
	children,
	aside,
}: {
	title: string;
	children: React.ReactNode;
	aside?: React.ReactNode;
}) => (
	<section className="mt-8">
		<div className="flex flex-wrap items-baseline justify-between gap-2">
			<h2 className="font-semibold text-neutral-900">{title}</h2>
			{aside}
		</div>
		<div className="mt-3">{children}</div>
	</section>
);

const th = "px-3 py-2 font-semibold";
const td = "tabular px-3 py-2";

const ATTRIBUTION_GROUPS: { title: string; keys: string[] }[] = [
	{ title: "Carry and roll-down", keys: ["carry", "rolldown"] },
	{
		title: "Curve",
		keys: ["curveShift", "curveTwist", "curveButterfly", "curveShape"],
	},
	{ title: "Selection", keys: ["selection"] },
	{ title: "Bills, TIPS and FRNs", keys: ["otherIncome", "otherPrice"] },
	{ title: "Trading and cash", keys: ["trading", "cash"] },
];

const PERIOD_LINKS = [
	["mtd", "MTD"],
	["qtd", "QTD"],
	["ytd", "YTD"],
	["1y", "1 year"],
	["inception", "Since inception"],
] as const;

const bp = (value: number | null | undefined) =>
	value === null || value === undefined
		? "—"
		: `${value >= 0 ? "+" : ""}${(value * 10_000).toFixed(1)} bp`;

type TAttribution = {
	key: string;
	label: string;
	start: string | null;
	end: string;
	totalReturn: number | null;
	components: {
		key: string;
		label: string;
		dollars: number;
		contribution: number;
	}[];
	residual: number;
	benchmark: { cumulative: number; annualised: number } | null;
};

const AttributionSection = ({
	attribution: a,
	benchmarkName,
	from,
	to,
}: {
	attribution: TAttribution;
	benchmarkName: string | null;
	from: string | null;
	to: string | null;
}) => {
	const byKey = new Map(a.components.map((c) => [c.key, c]));
	const active =
		a.totalReturn === null || a.benchmark === null
			? null
			: a.totalReturn - a.benchmark.cumulative;
	return (
		<Section
			aside={
				<nav className="flex flex-wrap gap-1 text-xs">
					{PERIOD_LINKS.map(([key, label]) => (
						<Link
							className={`rounded-full border px-3 py-1 font-semibold ${a.key === key ? "border-primary bg-primary/10 text-primary" : "border-slate-300 text-slate-600 hover:border-primary/40"}`}
							key={key}
							preventScrollReset
							to={`?attr=${key}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`}
						>
							{label}
						</Link>
					))}
					{from && to ? (
						<Link
							className={`rounded-full border px-3 py-1 font-semibold ${a.key === "custom" ? "border-primary bg-primary/10 text-primary" : "border-slate-300 text-slate-600"}`}
							preventScrollReset
							to={`?attr=custom&from=${from}&to=${to}`}
						>
							{from} to {to}
						</Link>
					) : null}
				</nav>
			}
			title={`Attribution: ${a.label.toLowerCase()}`}
		>
			{a.totalReturn === null ? (
				<p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">
					Nothing was held in this period.
				</p>
			) : (
				<div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
					<table className="w-full text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className={th}>Source</th>
								<th className={`${th} text-right`}>Dollars</th>
								<th className={`${th} text-right`}>Contribution</th>
							</tr>
						</thead>
						<tbody>
							{ATTRIBUTION_GROUPS.map((group) => {
								const rows = group.keys
									.map((k) => byKey.get(k))
									.filter((c) => c !== undefined);
								const shown = rows.filter((c) => Math.abs(c.dollars) >= 0.005);
								if (shown.length === 0) return null;
								const sumDollars = rows.reduce((s, c) => s + c.dollars, 0);
								const sumShare = rows.reduce((s, c) => s + c.contribution, 0);
								return [
									<tr
										className="border-t border-slate-200 bg-slate-50/60"
										key={group.title}
									>
										<td className="px-3 py-2 font-semibold text-neutral-900">
											{group.title}
										</td>
										<td
											className={`${td} text-right font-semibold ${signClass(sumDollars)}`}
										>
											{money(sumDollars)}
										</td>
										<td
											className={`${td} text-right font-semibold ${signClass(sumShare)}`}
										>
											{bp(sumShare)}
										</td>
									</tr>,
									...(shown.length > 1
										? shown.map((c) => (
												<tr className="border-t border-slate-100" key={c.key}>
													<td className="px-3 py-1.5 pl-8 text-slate-600">{c.label}</td>
													<td className={`${td} py-1.5 text-right ${signClass(c.dollars)}`}>
														{money(c.dollars)}
													</td>
													<td
														className={`${td} py-1.5 text-right ${signClass(c.contribution)}`}
													>
														{bp(c.contribution)}
													</td>
												</tr>
											))
										: []),
								];
							})}
							<tr className="border-t-2 border-slate-300">
								<td className="px-3 py-2 font-semibold text-neutral-900">
									Portfolio return ({a.start} to {a.end})
								</td>
								<td className={`${td} text-right font-semibold`}>
									{money(a.components.reduce((s, c) => s + c.dollars, 0))}
								</td>
								<td
									className={`${td} text-right font-semibold ${signClass(a.totalReturn)}`}
								>
									{percent(a.totalReturn)}
								</td>
							</tr>
							{a.benchmark ? (
								<>
									<tr className="border-t border-slate-100">
										<td className="px-3 py-2 text-slate-600">
											{benchmarkName ?? "Benchmark"}
										</td>
										<td />
										<td className={`${td} text-right`}>
											{percent(a.benchmark.cumulative)}
										</td>
									</tr>
									<tr className="border-t border-slate-100">
										<td className="px-3 py-2 font-semibold">Active return</td>
										<td />
										<td className={`${td} text-right font-semibold ${signClass(active)}`}>
											{bp(active)}
										</td>
									</tr>
								</>
							) : null}
						</tbody>
					</table>
				</div>
			)}
			<p className="mt-2 text-xs text-slate-500">
				Notes and bonds are decomposed each day by exact repricing on Safe Rate's
				fitted zero curve: carry (the curve's forwards realised, the same per dollar
				for every bond), roll-down (ageing down an unchanged curve), the curve's
				move split into level, slope and curvature on Diebold-Li loadings, and
				selection (the change in the bond's own cheapness to the curve). Bills sit
				below the curve's fitted range and TIPS and FRNs are priced off other
				curves, so they are split into income and price only. Days are linked with
				Carino's method, so contributions add to the time-weighted return
				{Math.abs(a.residual) > 1e-6 ? ` (unexplained: ${bp(a.residual)})` : ""}.
			</p>
		</Section>
	);
};

export default function PortfolioPage({ loaderData }: Route.ComponentProps) {
	const { portfolio, valued, from, to } = loaderData;
	const header = (
		<>
			<p className="text-sm">
				<Link
					className="text-primary underline-offset-4 hover:underline"
					to="/dashboard/portfolios"
				>
					← Portfolios
				</Link>
			</p>
			<div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
				<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
					{portfolio.namePortfolio}
				</h1>
				<Link
					className="rounded-full border border-slate-200 px-4 py-1.5 text-sm font-semibold text-slate-700 hover:border-primary/40 hover:text-primary"
					to={`/dashboard/portfolios/${portfolio.idPortfolio}/transactions`}
				>
					Trades and settings
				</Link>
			</div>
		</>
	);

	if (valued.status === "empty")
		return (
			<main className="max-w-5xl">
				{header}
				<p className="mt-8 rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-600">
					No trades yet.{" "}
					<Link
						className="text-primary underline underline-offset-4"
						to={`/dashboard/portfolios/${portfolio.idPortfolio}/transactions`}
					>
						Add trades or import a CSV
					</Link>{" "}
					to see value, returns and risk.
				</p>
			</main>
		);

	if (valued.status === "problems")
		return (
			<main className="max-w-5xl">
				{header}
				<div className="mt-8 rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-900">
					<p className="font-semibold">
						This portfolio cannot be valued until these are fixed:
					</p>
					<ul className="mt-2 list-disc space-y-1 pl-5">
						{valued.problems.map((p) => (
							<li key={p}>{p}</li>
						))}
					</ul>
				</div>
			</main>
		);

	const v = valued;
	const s = v.summary;
	return (
		<main className="max-w-6xl">
			{header}
			<p className="mt-1 text-sm text-slate-600">
				Valued at the {v.asOf} close. Coupons and proceeds:{" "}
				{INCOME_POLICY_LABEL[v.policyIncome].toLowerCase()}.
				{v.benchmark
					? ` Benchmark: Safe Rate ${v.benchmark.name}.`
					: " No benchmark set."}
			</p>

			{v.awayFromClose.length > 0 ? (
				<div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
					<p className="font-semibold">
						{v.awayFromClose.length} trade
						{v.awayFromClose.length === 1 ? " is" : "s are"} priced more than a point
						from that day's close.
					</p>
					<p className="mt-1">
						The gap is booked as that day's return, so check the price and date:{" "}
						{v.awayFromClose
							.map(
								(t) =>
									`${t.side} ${t.cusip} on ${t.tradeDate} at ${price(t.cleanPrice)} (close ${price(t.close)})`,
							)
							.join("; ")}
						.
					</p>
				</div>
			) : null}

			<section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<Stat
					hint={s.cash > 0 ? `including ${money(s.cash)} cash` : undefined}
					label="Market value"
					value={money(s.marketValue)}
				/>
				<Stat
					label="Total gain"
					tone={signClass(s.totalGain)}
					value={money(s.totalGain)}
					hint="value + paid out − put in"
				/>
				<Stat
					label="Income earned"
					value={money(s.incomeEarned)}
					hint="coupons, and interest on cash"
				/>
				<Stat
					label="Money-weighted return"
					value={percent(s.moneyWeighted)}
					hint="annual, on your actual cash"
				/>
			</section>

			<Section
				aside={
					<Form className="flex flex-wrap items-end gap-2 text-sm" method="get">
						<label className="text-xs text-slate-600">
							From
							<input
								className="ml-1 rounded border border-slate-300 px-2 py-1"
								defaultValue={from ?? ""}
								name="from"
								type="date"
							/>
						</label>
						<label className="text-xs text-slate-600">
							To
							<input
								className="ml-1 rounded border border-slate-300 px-2 py-1"
								defaultValue={to ?? v.asOf}
								name="to"
								type="date"
							/>
						</label>
						<button
							className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold"
							type="submit"
						>
							Custom range
						</button>
					</Form>
				}
				title="Returns"
			>
				<div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
					<table className="w-full text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className={th}>Period</th>
								<th className={th}>From close of</th>
								<th className={`${th} text-right`}>Portfolio</th>
								<th className={`${th} text-right`}>
									{v.benchmark ? v.benchmark.name : "Benchmark"}
								</th>
								<th className={`${th} text-right`}>Difference</th>
							</tr>
						</thead>
						<tbody>
							{[...v.periods, ...(v.custom ? [v.custom] : [])].map((row) => {
								const isLong = row.annualised !== row.cumulative;
								const mine = isLong ? row.annualised : row.cumulative;
								const theirs = isLong
									? row.benchmarkAnnualised
									: row.benchmarkCumulative;
								const gap = mine === null || theirs === null ? null : mine - theirs;
								return (
									<tr
										className="border-t border-slate-100"
										key={`${row.key}-${row.start}`}
									>
										<td className="px-3 py-2">
											{row.label}
											{isLong ? (
												<span className="ml-1 text-xs text-slate-500">(annualised)</span>
											) : null}
											{!row.isFullPeriod && row.key !== "inception" ? (
												<span className="ml-1 text-xs text-amber-700">since inception</span>
											) : null}
										</td>
										<td className={`${td} text-slate-500`}>
											{row.start}
											{row.key === "custom" ? ` to ${row.end}` : ""}
										</td>
										<td className={`${td} text-right font-medium ${signClass(mine)}`}>
											{percent(mine)}
										</td>
										<td className={`${td} text-right`}>
											{v.benchmark ? percent(theirs) : "—"}
										</td>
										<td className={`${td} text-right ${signClass(gap)}`}>
											{gap === null
												? "—"
												: `${gap >= 0 ? "+" : ""}${(gap * 10_000).toFixed(0)} bp`}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
				<p className="mt-2 text-xs text-slate-500">
					Time-weighted: daily returns chained, so the timing of your purchases and
					sales does not move them, and they compare directly with the index. A
					period the portfolio did not span is measured from the close of its first
					day, for the portfolio and the benchmark alike; the first purchase's
					trade-to-close gap is in the dollar gain and the money-weighted return. A
					period opens at the prior close (month to date from the last close of the
					previous month). "Since inception" marks a period that began before the
					portfolio did.
				</p>
			</Section>

			<AttributionSection
				attribution={v.attribution}
				benchmarkName={v.benchmark?.name ?? null}
				from={from}
				to={to}
			/>

			<Section title="Growth of $100">
				<div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
					<LineChart
						format={(value) => `$${value.toFixed(2)}`}
						series={[
							{
								label: portfolio.namePortfolio,
								className: "stroke-primary",
								points: v.series.map((p) => ({ date: p.date, value: p.growth * 100 })),
							},
							...(v.benchmark
								? [
										{
											label: v.benchmark.name,
											className: "stroke-slate-400",
											points: v.series.map((p) => ({
												date: p.date,
												value: p.benchmarkGrowth === null ? null : p.benchmarkGrowth * 100,
											})),
										},
									]
								: []),
						]}
					/>
				</div>
			</Section>

			<Section title="Holdings">
				<div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
					<table className="w-full text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className={th}>Security</th>
								<th className={`${th} text-right`}>Face</th>
								<th className={`${th} text-right`}>Avg cost</th>
								<th className={`${th} text-right`}>Close</th>
								<th className={`${th} text-right`}>Accrued</th>
								<th className={`${th} text-right`}>Market value</th>
								<th className={`${th} text-right`}>Weight</th>
								<th className={`${th} text-right`}>Unrealised</th>
								<th className={`${th} text-right`}>Realised</th>
							</tr>
						</thead>
						<tbody>
							{v.positions.map((p) => (
								<tr className="border-t border-slate-100" key={p.cusip}>
									<td className="px-3 py-2">
										<span className="font-mono text-xs">{p.cusip}</span>{" "}
										{describeSecurity(p.info)}
									</td>
									<td className={`${td} text-right`}>{face(p.faceAmount)}</td>
									<td className={`${td} text-right`}>{price(p.averageCleanCost)}</td>
									<td className={`${td} text-right`}>
										{price(p.close)}
										{p.markDate !== v.asOf ? (
											<span className="block text-[10px] text-amber-700">
												{p.markDate}
											</span>
										) : null}
									</td>
									<td className={`${td} text-right`}>{number(p.accruedPer100, 4)}</td>
									<td className={`${td} text-right`}>{money(p.marketValue)}</td>
									<td className={`${td} text-right`}>
										{percent(s.marketValue > 0 ? p.marketValue / s.marketValue : null, 1)}
									</td>
									<td className={`${td} text-right ${signClass(p.unrealisedPriceGain)}`}>
										{money(p.unrealisedPriceGain)}
									</td>
									<td className={`${td} text-right ${signClass(p.realisedPriceGain)}`}>
										{money(p.realisedPriceGain)}
									</td>
								</tr>
							))}
							{s.cash > 0 ? (
								<tr className="border-t border-slate-100">
									<td className="px-3 py-2">Cash</td>
									<td colSpan={4} />
									<td className={`${td} text-right`}>{money(s.cash)}</td>
									<td className={`${td} text-right`}>
										{percent(s.cash / s.marketValue, 1)}
									</td>
									<td colSpan={2} />
								</tr>
							) : null}
						</tbody>
					</table>
				</div>
				<p className="mt-2 text-xs text-slate-500">
					Cost is first in, first out, clean. Gains are price gains only: accrued
					interest is income. Not tax accounting: no discount accretion or premium
					amortisation.
					{v.staleMarks > 0
						? ` ${v.staleMarks} day${v.staleMarks === 1 ? "" : "s"} had a held security with no close; it was marked at its previous close.`
						: ""}
				</p>
				{v.closedPositions.length > 0 ? (
					<p className="mt-2 text-xs text-slate-600">
						Closed or matured:{" "}
						{v.closedPositions
							.map(
								(c) =>
									`${c.cusip} ${describeSecurity(c.info)} ${money(c.realisedPriceGain)}`,
							)
							.join("; ")}
						.
					</p>
				) : null}
			</Section>

			<div className="grid gap-6 lg:grid-cols-2">
				<Section title="Risk">
					<div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
						{v.risk.coveredShare !== null ? (
							<>
								<dl className="grid grid-cols-2 gap-3 text-sm">
									<div>
										<dt className="text-xs text-slate-500">Modified duration</dt>
										<dd className="tabular font-semibold">
											{number(v.risk.modifiedDuration)} years
										</dd>
									</div>
									<div>
										<dt className="text-xs text-slate-500">DV01</dt>
										<dd className="tabular font-semibold">{money(v.risk.dv01)} per bp</dd>
									</div>
									<div>
										<dt className="text-xs text-slate-500">Yield (value-weighted)</dt>
										<dd className="tabular font-semibold">
											{rate(v.risk.yieldPercent, 3)}
										</dd>
									</div>
									<div>
										<dt className="text-xs text-slate-500">Convexity</dt>
										<dd className="tabular font-semibold">
											{number(v.risk.convexity, 3)}
										</dd>
									</div>
								</dl>
								{v.risk.keyRates.length > 0 ? (
									<div className="mt-4">
										<p className="text-xs text-slate-500">Key-rate durations</p>
										<div className="mt-2 flex h-24 items-end gap-1">
											{v.risk.keyRates.map((k) => {
												const peak = Math.max(
													...v.risk.keyRates.map((x) => Math.abs(x.duration)),
													1e-9,
												);
												return (
													<div
														className="flex flex-1 flex-col items-center"
														key={k.label}
														title={`${k.label}: ${k.duration.toFixed(3)}`}
													>
														<div
															className="w-full rounded-t bg-primary/70"
															style={{ height: `${(Math.abs(k.duration) / peak) * 80}px` }}
														/>
														<span className="mt-1 text-[10px] text-slate-500">{k.label}</span>
													</div>
												);
											})}
										</div>
									</div>
								) : null}
							</>
						) : (
							<p className="text-sm text-slate-600">No bills, notes or bonds held.</p>
						)}
						{v.risk.linkers || v.risk.floaters ? (
							<dl className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-sm">
								{v.risk.linkers ? (
									<div>
										<dt className="text-xs text-slate-500">
											TIPS ({money(v.risk.linkers.marketValue)}): real duration
										</dt>
										<dd className="tabular font-semibold">
											{number(v.risk.linkers.realDuration)} years
										</dd>
									</div>
								) : null}
								{v.risk.floaters ? (
									<div>
										<dt className="text-xs text-slate-500">
											FRNs ({money(v.risk.floaters.marketValue)}): spread / rate duration
										</dt>
										<dd className="tabular font-semibold">
											{number(v.risk.floaters.spreadDuration)} /{" "}
											{number(v.risk.floaters.rateDuration, 3)} years
										</dd>
									</div>
								) : null}
							</dl>
						) : null}
						<p className="mt-3 text-xs text-slate-500">
							From each security's stored analytics at the {v.asOf} close, weighted by
							market value; bills, notes and bonds above, so cash lowers none of it.
							TIPS duration is to the real yield and a floater's is mostly to its
							spread, so each is shown apart rather than blended in.
							{v.risk.uncovered.length > 0
								? ` Not covered (${percent(1 - (v.risk.coveredShare ?? 1), 1)} of bond value, no analytics that day, usually inside three months of maturity): ${v.risk.uncovered.join(", ")}.`
								: ""}
						</p>
					</div>
				</Section>

				<Section title="Income, next 12 months">
					<div className="rounded-xl border border-slate-200 bg-white shadow-sm">
						{v.incomeNextYear.length === 0 ? (
							<p className="p-4 text-sm text-slate-600">
								Nothing due in the next year.
							</p>
						) : (
							<table className="w-full text-sm">
								<tbody>
									{v.incomeNextYear.map((f) => (
										<tr
											className="border-t border-slate-100 first:border-t-0"
											key={`${f.date}-${f.cusip}-${f.kind}`}
										>
											<td className={`${td} text-slate-600`}>{f.date}</td>
											<td className="px-3 py-2">
												{f.kind === "coupon" ? "Coupon" : "Maturity"} ·{" "}
												{describeSecurity(f.info)}
												{f.isEstimate ? (
													<span className="ml-1 text-xs text-amber-700">estimate</span>
												) : null}
											</td>
											<td className={`${td} text-right`}>{money(f.amount)}</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
						<p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
							All remaining coupons and principal: {money(v.incomeTotal)}. Dates are
							contractual; a payment on a weekend or holiday is made the next business
							day. TIPS and FRN amounts after the latest close hold today's index ratio
							or floating rate flat, so they are estimates.
						</p>
					</div>
				</Section>
			</div>
		</main>
	);
}
