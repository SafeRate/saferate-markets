import {
	getPortfolio,
	listPortfolios,
	listTransactions,
} from "@markets/persistence";
import { PRODUCT_NAME } from "@markets/schema";
import { Form, Link } from "react-router";
import { money, number, percent } from "@/lib/format";
import { requireDashboard } from "@/lib/session.server";
import { analyseStress, type TCustomShock } from "@/services/stress.server";
import type { Route } from "./+types/dashboard.stress";

export const meta: Route.MetaFunction = () => [
	{ title: `Stress Testing — ${PRODUCT_NAME}` },
];

const num = (raw: string | null) => {
	const value = Number(raw);
	return raw !== null && raw.trim() !== "" && Number.isFinite(value)
		? Math.max(-1000, Math.min(1000, value))
		: null;
};

export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const org = await requireDashboard(request, env);
	const portfolios = await listPortfolios({
		db: env.DB,
		idOrganization: org.idOrganization,
	});
	const url = new URL(request.url);
	const chosen =
		url.searchParams.get("portfolio") ?? portfolios[0]?.idPortfolio ?? null;
	const portfolio =
		chosen === null
			? null
			: await getPortfolio({
					db: env.DB,
					idOrganization: org.idOrganization,
					idPortfolio: chosen,
				});
	const parallel = num(url.searchParams.get("parallel"));
	const twist = num(url.searchParams.get("twist"));
	const fly = num(url.searchParams.get("fly"));
	const custom: TCustomShock | null =
		parallel === null && twist === null && fly === null
			? null
			: { parallelBp: parallel ?? 0, twistBp: twist ?? 0, butterflyBp: fly ?? 0 };
	if (portfolio === null)
		return { portfolios, portfolio: null, custom, analysis: null };
	const transactions = await listTransactions({
		db: env.DB,
		idOrganization: org.idOrganization,
		idPortfolio: portfolio.idPortfolio,
	});
	const analysis = await analyseStress({
		env,
		transactions,
		policyIncome: portfolio.policyIncome,
		custom,
	});
	return { portfolios, portfolio, custom, analysis };
};

const th = "px-3 py-2 font-semibold";
const td = "tabular px-3 py-2";
const bp = (v: number | undefined) =>
	v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(0)}`;
const pnlClass = (v: number) =>
	v > 0 ? "text-emerald-700" : v < 0 ? "text-red-700" : "";

type TRow = {
	name: string;
	shift2y: number | undefined;
	shift10y: number | undefined;
	shift30y: number | undefined;
	firstOrder: number;
	convexity: number;
	other: number;
	total: number;
	fraction: number | null;
};

const ScenarioTable = ({
	rows,
	extra,
}: {
	rows: (TRow & { window?: string; category?: string })[];
	extra?: boolean;
}) => (
	<div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
		<table className="w-full text-sm">
			<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
				<tr>
					<th className={th}>Scenario</th>
					{extra ? <th className={th}>Window</th> : null}
					<th className={`${th} text-right`}>2Y</th>
					<th className={`${th} text-right`}>10Y</th>
					<th className={`${th} text-right`}>30Y</th>
					<th className={`${th} text-right`}>P&amp;L</th>
					<th className={`${th} text-right`}>% of value</th>
					<th className={`${th} text-right`}>Duration</th>
					<th className={`${th} text-right`}>Convexity</th>
					<th className={`${th} text-right`}>TIPS / FRN</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((r) => (
					<tr
						className="border-t border-slate-100"
						key={`${r.name}-${r.window ?? ""}`}
					>
						<td className="px-3 py-2">
							{r.name}
							{r.category ? (
								<span className="ml-1 text-xs text-slate-500">({r.category})</span>
							) : null}
						</td>
						{extra ? (
							<td className={`${td} whitespace-nowrap text-slate-500`}>{r.window}</td>
						) : null}
						<td className={`${td} text-right text-slate-600`}>{bp(r.shift2y)}</td>
						<td className={`${td} text-right text-slate-600`}>{bp(r.shift10y)}</td>
						<td className={`${td} text-right text-slate-600`}>{bp(r.shift30y)}</td>
						<td className={`${td} text-right font-medium ${pnlClass(r.total)}`}>
							{money(r.total)}
						</td>
						<td className={`${td} text-right ${pnlClass(r.total)}`}>
							{percent(r.fraction)}
						</td>
						<td className={`${td} text-right text-slate-600`}>
							{money(r.firstOrder)}
						</td>
						<td className={`${td} text-right text-slate-600`}>
							{money(r.convexity)}
						</td>
						<td className={`${td} text-right text-slate-600`}>
							{r.other === 0 ? "—" : money(r.other)}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	</div>
);

type TTsay = NonNullable<
	Extract<
		Awaited<ReturnType<typeof analyseStress>>,
		{ status: "analysed" }
	>["tsay"]
>;

const pValue = (p: number) => (p < 0.0001 ? "< 0.0001" : p.toFixed(4));

const TsaySection = ({
	tsay,
	sigmaNote,
}: {
	tsay: TTsay;
	sigmaNote: number;
}) => {
	const rows: {
		label: string;
		raw: string;
		filtered: string;
		reading: string;
	}[] = [
		{
			label: "Excess kurtosis",
			raw: number(tsay.raw.excessKurtosis, 2),
			filtered: number(tsay.filtered.excessKurtosis, 2),
			reading:
				"0 for a normal distribution; above 0, more big days than a normal allows",
		},
		{
			label: "Skewness",
			raw: number(tsay.raw.skewness, 2),
			filtered: number(tsay.filtered.skewness, 2),
			reading: "below 0, the big days are losses more often than gains",
		},
		{
			label: "Jarque-Bera p-value",
			raw: pValue(tsay.raw.jarqueBeraPValue),
			filtered: pValue(tsay.filtered.jarqueBeraPValue),
			reading: "below 0.05 rejects a normal distribution",
		},
		{
			label: "Ljung-Box Q(10), squared",
			raw: `${number(tsay.raw.ljungBoxSquared, 0)} (p ${pValue(tsay.raw.ljungBoxSquaredPValue)})`,
			filtered: `${number(tsay.filtered.ljungBoxSquared, 0)} (p ${pValue(tsay.filtered.ljungBoxSquaredPValue)})`,
			reading:
				"a small p on the raw series means volatility clusters; after filtering it should not",
		},
		{
			label: "Hill tail index (losses)",
			raw: tsay.raw.hillAlpha === null ? "—" : number(tsay.raw.hillAlpha, 2),
			filtered:
				tsay.filtered.hillAlpha === null ? "—" : number(tsay.filtered.hillAlpha, 2),
			reading: "the smaller, the heavier the tail; a normal has no finite index",
		},
	];
	return (
		<section className="mt-8">
			<h2 className="font-semibold text-neutral-900">
				Fat tails and clustering (Tsay)
			</h2>
			<div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
				<table className="w-full text-sm">
					<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
						<tr>
							<th className={th}>Test</th>
							<th className={`${th} text-right`}>Daily P&amp;L</th>
							<th className={`${th} text-right`}>GARCH-filtered</th>
							<th className={th}>How to read it</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr className="border-t border-slate-100" key={r.label}>
								<td className="px-3 py-2">{r.label}</td>
								<td className={`${td} text-right`}>{r.raw}</td>
								<td className={`${td} text-right`}>{r.filtered}</td>
								<td className="px-3 py-2 text-xs text-slate-500">{r.reading}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<div className="mt-3 grid gap-3 sm:grid-cols-3">
				<div className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
					<p className="text-xs uppercase tracking-wide text-slate-500">
						GARCH(1,1)
					</p>
					<p className="mt-1">
						Persistence {number(tsay.garch.persistence, 4)}; today's daily volatility{" "}
						{money(tsay.garch.todayVolatility)} against a long-run{" "}
						{money(tsay.garch.longRunDailyVolatility)}.
					</p>
				</div>
				<div className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm sm:col-span-2">
					<p className="text-xs uppercase tracking-wide text-slate-500">
						Student-t, {number(tsay.studentT.degreesOfFreedom, 1)} degrees of freedom
					</p>
					<p className="mt-1">
						{tsay.studentT.oneDay
							.map(
								(r) =>
									`1-day ${Math.round(r.confidence * 100)}%: VaR ${money(r.valueAtRisk)} (${percent(r.valueAtRisk / sigmaNote)}), shortfall ${money(r.expectedShortfall)}`,
							)
							.join(" · ")}
					</p>
				</div>
			</div>
			<p className="mt-2 text-xs text-slate-500">
				Tsay's diagnostics on this book's history: what today's key-rate DV01 would
				have made or lost on each of {tsay.days.toLocaleString("en-US")} days since
				2008. GARCH divides each day by the volatility of its time; what is left is
				the shape of the shocks, fitted with a Student-t by maximum likelihood
				(fewer degrees of freedom, fatter tails; a normal is the limit as they
				grow). The t view is a third estimate beside the historical and
				extreme-value figures above; where they disagree, the tail is the uncertain
				part.
			</p>
		</section>
	);
};

export default function Stress({ loaderData }: Route.ComponentProps) {
	const { portfolios, portfolio, custom, analysis } = loaderData;
	const header = (
		<div className="flex flex-wrap items-end justify-between gap-3">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
					Stress Testing
				</h1>
				<p className="mt-1 text-sm text-slate-600">
					What today's holdings would lose in standard shocks, in every stored market
					episode since 2008, in a shock of your own, and in the tail of the
					historical distribution.
				</p>
			</div>
			{portfolios.length > 0 ? (
				<Form className="flex items-end gap-2 text-sm" method="get">
					<label className="text-xs text-slate-600">
						Portfolio
						<select
							className="ml-1 rounded border border-slate-300 px-2 py-1"
							defaultValue={portfolio?.idPortfolio}
							name="portfolio"
						>
							{portfolios.map((p) => (
								<option key={p.idPortfolio} value={p.idPortfolio}>
									{p.namePortfolio}
								</option>
							))}
						</select>
					</label>
					<button
						className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold"
						type="submit"
					>
						Show
					</button>
				</Form>
			) : null}
		</div>
	);
	if (portfolio === null || analysis === null)
		return (
			<main className="max-w-6xl">
				{header}
				<p className="mt-8 rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-600">
					No portfolio to test.{" "}
					<Link
						className="text-primary underline underline-offset-4"
						to="/dashboard/portfolios"
					>
						Create one in Portfolio Tracking
					</Link>
					.
				</p>
			</main>
		);
	if (analysis.status !== "analysed")
		return (
			<main className="max-w-6xl">
				{header}
				<p className="mt-8 rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-600">
					{analysis.status === "empty"
						? "This portfolio has no trades yet."
						: `This portfolio cannot be valued until its trades are fixed: ${analysis.problems.join(" ")}`}
				</p>
			</main>
		);

	const a = analysis;
	const peak = Math.max(...a.keyRateDv01.map((k) => Math.abs(k.dv01)), 1e-9);
	const hist = a.risk?.[0]?.histogram ?? null;
	const histPeak = hist ? Math.max(...hist.map((b) => b.count)) : 1;
	return (
		<main className="max-w-6xl">
			{header}
			<p className="mt-3 text-sm text-slate-600">
				{portfolio.namePortfolio}, held at the {a.asOf} close:{" "}
				{money(a.marketValue)}
				{a.cash > 0 ? ` including ${money(a.cash)} cash` : ""}. DV01 of the bills,
				notes and bonds {money(a.dv01)} per basis point
				{a.others.length > 0 ? "; TIPS and FRNs are shown apart below" : ""}.
			</p>

			<section className="mt-8">
				<h2 className="font-semibold text-neutral-900">
					Value at risk and expected shortfall
				</h2>
				{a.risk === null ? (
					<p className="mt-3 text-sm text-slate-600">
						No bills, notes or bonds held: nothing for the curve simulation to move.
					</p>
				) : (
					<div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
						<table className="w-full text-sm">
							<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
								<tr>
									<th className={th}>Horizon</th>
									<th className={`${th} text-right`}>VaR 95%</th>
									<th className={`${th} text-right`}>VaR 99%</th>
									<th className={`${th} text-right`}>Shortfall 95%</th>
									<th className={`${th} text-right`}>Shortfall 99%</th>
									<th className={`${th} text-right`}>Tail shape</th>
								</tr>
							</thead>
							<tbody>
								{a.risk.map((r) => (
									<tr
										className="border-t border-slate-100 align-top"
										key={r.horizonDays}
									>
										<td className="px-3 py-2">
											{r.horizonDays === 1 ? "1 day" : `${r.horizonDays} days`}
										</td>
										{(["var95", "var99", "es95", "es99"] as const).map((k) => (
											<td className={`${td} text-right`} key={k}>
												<span className="font-medium">{money(r.extremeValue[k])}</span>
												<span className="block text-xs text-slate-500">
													{percent(r.extremeValue[k] / a.marketValue)} · empirical{" "}
													{money(r.empirical[k])}
												</span>
											</td>
										))}
										<td className={`${td} text-right`}>
											{r.extremeValue.tailShape === null
												? "—"
												: number(r.extremeValue.tailShape, 3)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				{hist ? (
					<div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
						<p className="text-xs text-slate-500">
							Simulated one-day P&amp;L, 50,000 paths
						</p>
						<div className="mt-2 flex h-28 items-end gap-px">
							{hist.map((b) => (
								<div
									className={`flex-1 rounded-t ${b.to <= 0 ? "bg-red-400/70" : "bg-primary/60"}`}
									key={b.from}
									style={{ height: `${(b.count / histPeak) * 100}%` }}
									title={`${money(b.from)} to ${money(b.to)}: ${b.count}`}
								/>
							))}
						</div>
						<div className="mt-1 flex justify-between text-[10px] text-slate-500">
							<span>{money(hist[0].from)}</span>
							<span>{money(hist.at(-1)?.to)}</span>
						</div>
					</div>
				) : null}
				<p className="mt-2 text-xs text-slate-500">
					Filtered historical simulation over {a.historyDays.toLocaleString("en-US")}{" "}
					daily curve moves since {a.historyFrom}: each day's move at twelve key
					rates, divided by that day's GARCH(1,1) volatility and rescaled to today's,
					applied to this book's key-rate DV01. The headline figure reads the far
					tail from a fitted generalised Pareto (extreme value theory, after Tsay);
					the empirical figure reads it straight from the paths, and cannot report a
					loss worse than the worst day seen. Expected shortfall is the average loss
					beyond the value at risk. A tail shape above zero is a heavy tail. Linear
					in DV01; TIPS and FRNs are excluded.
				</p>
			</section>

			{a.tsay ? <TsaySection sigmaNote={a.marketValue} tsay={a.tsay} /> : null}

			<section className="mt-8">
				<h2 className="font-semibold text-neutral-900">Key-rate DV01</h2>
				<div className="mt-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
					<div className="flex h-24 items-end gap-1">
						{a.keyRateDv01.map((k) => (
							<div
								className="flex flex-1 flex-col items-center"
								key={k.years}
								title={`${k.years}Y: ${money(k.dv01)} per bp`}
							>
								<div
									className="w-full rounded-t bg-primary/70"
									style={{ height: `${(Math.abs(k.dv01) / peak) * 80}px` }}
								/>
								<span className="mt-1 text-[10px] text-slate-500">
									{k.years < 1 ? `${k.years * 12}M` : `${k.years}Y`}
								</span>
							</div>
						))}
					</div>
				</div>
			</section>

			<section className="mt-8">
				<div className="flex flex-wrap items-end justify-between gap-3">
					<h2 className="font-semibold text-neutral-900">Standard shocks</h2>
					<Form className="flex flex-wrap items-end gap-2 text-xs" method="get">
						<input name="portfolio" type="hidden" value={portfolio.idPortfolio} />
						{(
							[
								["parallel", "Parallel bp", custom?.parallelBp],
								["twist", "2s10s bp", custom?.twistBp],
								["fly", "5Y belly bp", custom?.butterflyBp],
							] as const
						).map(([name, label, value]) => (
							<label className="text-slate-600" key={name}>
								{label}
								<input
									className="ml-1 w-20 rounded border border-slate-300 px-2 py-1"
									defaultValue={value ?? ""}
									name={name}
									step="1"
									type="number"
								/>
							</label>
						))}
						<button
							className="rounded-full border border-slate-300 px-3 py-1 font-semibold"
							type="submit"
						>
							Add your shock
						</button>
					</Form>
				</div>
				<div className="mt-3">
					<ScenarioTable rows={a.standard} />
				</div>
				<p className="mt-2 text-xs text-slate-500">
					Every note, bond and bill cashflow repriced exactly on the {a.curveDate}{" "}
					fitted zero curve, shocked at twelve key rates. Duration is the first-order
					part of the P&amp;L and convexity the rest. TIPS move by their real
					duration times the shock, assuming breakevens are unchanged; floaters by
					their rate duration, near zero since they reset.
				</p>
			</section>

			<section className="mt-8">
				<h2 className="font-semibold text-neutral-900">
					Market episodes, replayed on today's holdings
				</h2>
				<div className="mt-3">
					{a.replayed.length === 0 ? (
						<p className="text-sm text-slate-600">No stored market events.</p>
					) : (
						<ScenarioTable
							extra
							rows={a.replayed.map((r) => ({ ...r, window: `${r.from} to ${r.to}` }))}
						/>
					)}
				</div>
				<p className="mt-2 text-xs text-slate-500">
					Each event's actual key-rate move, from the last fitted day before it began
					to its end, applied to what is held now.
				</p>
			</section>
		</main>
	);
}
