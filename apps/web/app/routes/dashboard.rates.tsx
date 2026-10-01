import { PRODUCT_NAME } from "@markets/schema";
import {
	getBreakevenOn,
	getCurvesOn,
	getLatestCurve,
	getRealCurveOn,
	getZeroCurveSeries,
} from "@saferate/treasury-client/client";
import { data, Form } from "react-router";
import { LineChart } from "@/components/LineChart";
import { parseDate } from "@markets/portfolio";
import { rate } from "@/lib/format";
import { requireOrganization } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.rates";

export const meta: Route.MetaFunction = () => [
	{ title: `Treasury Rates — ${PRODUCT_NAME}` },
];

/**
 * Every fitted curve for one day, and a year of the 2- and 10-year zero rates.
 * The same client functions the API's /v1/curves routes serve; the binding is
 * read-only. A day with no fit (weekend, holiday) says so rather than showing
 * blanks.
 */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	await requireOrganization(request, env);
	const asked = parseDate(new URL(request.url).searchParams.get("date") ?? "");
	const latest = await getLatestCurve({ env });
	if (latest === null)
		throw data("No fitted curve is available.", { status: 503 });
	const date = asked ?? latest.date;
	const [curves, real, breakeven] = await Promise.all([
		getCurvesOn({ date, env }),
		getRealCurveOn({ date, env }),
		getBreakevenOn({ date, env }),
	]);
	const from = new Date(`${date}T00:00:00Z`);
	from.setUTCFullYear(from.getUTCFullYear() - 1);
	const history = await getZeroCurveSeries({
		env,
		from: from.toISOString().slice(0, 10),
		to: date,
	});
	const byDate = new Map<string, { two: number | null; ten: number | null }>();
	for (const point of history) {
		const row = byDate.get(point.date) ?? { two: null, ten: null };
		if (point.tenorYears === 2) row.two = point.zeroRate;
		if (point.tenorYears === 10) row.ten = point.zeroRate;
		byDate.set(point.date, row);
	}
	return {
		date,
		latestDate: latest.date,
		hasCurve: curves?.hasAnyCurve ?? false,
		zero: curves?.zero ?? [],
		par: curves?.par ?? null,
		moneyMarket: curves?.moneyMarket ?? null,
		real,
		breakeven,
		history: [...byDate]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([d, r]) => ({ date: d, ...r })),
	};
};

const Table = ({
	title,
	note,
	rows,
}: {
	title: string;
	note?: string;
	rows: { label: string; value: number | null }[];
}) => (
	<div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
		<h2 className="font-semibold text-neutral-900">{title}</h2>
		{rows.length === 0 ? (
			<p className="mt-2 text-sm text-slate-500">Not fitted this day.</p>
		) : (
			<table className="mt-2 w-full text-sm">
				<tbody>
					{rows.map((r) => (
						<tr className="border-t border-slate-100 first:border-t-0" key={r.label}>
							<td className="py-1.5 text-slate-600">{r.label}</td>
							<td className="tabular py-1.5 text-right font-medium">
								{rate(r.value, 3)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		)}
		{note ? <p className="mt-2 text-xs text-slate-500">{note}</p> : null}
	</div>
);

const tenorLabel = (years: number) => `${years}Y`;

export default function Rates({ loaderData }: Route.ComponentProps) {
	const d = loaderData;
	return (
		<main className="max-w-6xl">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
						Treasury Rates
					</h1>
					<p className="mt-1 text-sm text-slate-600">
						Safe Rate's fitted curves for {d.date}
						{d.date === d.latestDate ? ", the latest published day" : ""}. Rates are
						percent, continuously compounded on the zero and real curves.
					</p>
				</div>
				<Form className="flex items-end gap-2 text-sm" method="get">
					<label className="text-xs text-slate-600">
						Day
						<input
							className="ml-1 rounded border border-slate-300 px-2 py-1"
							defaultValue={d.date}
							max={d.latestDate}
							min="2008-09-02"
							name="date"
							type="date"
						/>
					</label>
					<button
						className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold"
						type="submit"
					>
						Show
					</button>
				</Form>
			</div>

			{!d.hasCurve ? (
				<p className="mt-8 rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-600">
					No curve was fitted on {d.date}: Treasury publishes on business days only.
					Pick a trading day.
				</p>
			) : (
				<>
					<section className="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
						<h2 className="font-semibold text-neutral-900">The curve</h2>
						<LineChart
							format={(v) => `${v.toFixed(2)}%`}
							series={[
								{
									label: "Zero",
									className: "stroke-primary",
									points: d.zero.map((p) => ({
										date: tenorLabel(p.tenorYears),
										value: p.zeroRate,
									})),
								},
								{
									label: "Par",
									className: "stroke-slate-400",
									points: d.zero.map((p) => ({
										date: tenorLabel(p.tenorYears),
										value: p.parYield,
									})),
								},
							]}
						/>
					</section>

					<section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
						<Table
							rows={
								d.moneyMarket?.rates.map((r) => ({ label: r.label, value: r.rate })) ??
								[]
							}
							note={
								d.moneyMarket
									? `Fitted to ${d.moneyMarket.billCount} bills, ${d.moneyMarket.convention}. Read the front end here.`
									: undefined
							}
							title="Money market"
						/>
						<Table
							rows={d.zero.map((p) => ({
								label: tenorLabel(p.tenorYears),
								value: p.zeroRate,
							}))}
							note="Spot rates from coupon securities."
							title="Zero curve"
						/>
						<Table
							rows={d.par?.rates.map((r) => ({ label: r.label, value: r.rate })) ?? []}
							note="The coupon that prices a bond at par."
							title="Par curve"
						/>
						<Table
							rows={
								d.real?.rates.map((r) => ({ label: r.label, value: r.rate })) ?? []
							}
							note={
								d.real
									? `TIPS real rates, from ${d.real.tipsCount} linkers.`
									: undefined
							}
							title="Real (TIPS)"
						/>
					</section>

					{d.breakeven ? (
						<section className="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
							<h2 className="font-semibold text-neutral-900">Breakeven inflation</h2>
							<div className="mt-2 overflow-x-auto">
								<table className="w-full text-sm">
									<thead className="text-left text-xs uppercase tracking-wide text-slate-500">
										<tr>
											<th className="py-1.5 font-semibold">Tenor</th>
											<th className="py-1.5 text-right font-semibold">Nominal</th>
											<th className="py-1.5 text-right font-semibold">Real</th>
											<th className="py-1.5 text-right font-semibold">Breakeven</th>
										</tr>
									</thead>
									<tbody>
										{d.breakeven.points.map((p) => (
											<tr className="border-t border-slate-100" key={p.tenorYears}>
												<td className="py-1.5">{tenorLabel(p.tenorYears)}</td>
												<td className="tabular py-1.5 text-right">{rate(p.nominal)}</td>
												<td className="tabular py-1.5 text-right">{rate(p.real)}</td>
												<td className="tabular py-1.5 text-right font-medium">
													{rate(p.breakeven)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							<p className="mt-2 text-xs text-slate-500">
								The inflation at which TIPS and nominal Treasuries return the same. It
								carries an inflation risk premium and a TIPS liquidity premium, so it is
								a market price, not a forecast.
							</p>
						</section>
					) : null}

					<section className="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
						<h2 className="font-semibold text-neutral-900">
							The last year: 2- and 10-year zero rates
						</h2>
						<LineChart
							format={(v) => `${v.toFixed(2)}%`}
							series={[
								{
									label: "2-year",
									className: "stroke-slate-400",
									points: d.history.map((h) => ({ date: h.date, value: h.two })),
								},
								{
									label: "10-year",
									className: "stroke-primary",
									points: d.history.map((h) => ({ date: h.date, value: h.ten })),
								},
							]}
						/>
					</section>
				</>
			)}
		</main>
	);
}
