import {
	readAnalytics,
	readDailyLevels,
	explainNoOpenConstituents,
	readOpenConstituents,
} from "@markets/mcp-tools";
import { fromBase, PERIOD_LABEL, trailingReturns } from "@markets/portfolio";
import { PRODUCT_NAME } from "@markets/schema";
import { INDEX_META, isIndexCode } from "@saferate/treasury-client/types";
import { data, Link } from "react-router";
import { LineChart } from "@/components/LineChart";
import { money, percent, signClass } from "@/lib/format";
import { requireOrganization } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.indices.$code";

export const meta: Route.MetaFunction = ({ data: d }) => [
	{ title: `${d?.name ?? "Index"} | ${PRODUCT_NAME}` },
];

/**
 * One index: trailing returns from its daily levels chained from its base
 * (indexReturns.ts), growth of $100 over a chosen range, its characteristics
 * PER DURATION BASIS (the Aggregate is three rows: nominal, real, floating,
 * and a blended duration would be a sensitivity to nothing), and the open
 * period's constituents. Two traps from treasury-integration, 2026-10-01:
 * the open snapshot's rebalance date is the period START, where a closed
 * constituent file's date is its END; and every date here is read from the
 * data, since a month-end can be held back for review.
 */
const RANGES = { "1y": 1, "5y": 5, inception: null } as const;

export const loader = async ({
	request,
	params,
	context,
}: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	await requireOrganization(request, env);
	const code = params.code ?? "";
	if (!isIndexCode(code)) throw data("No such index.", { status: 404 });
	const range = (new URL(request.url).searchParams.get("range") ??
		"5y") as keyof typeof RANGES;
	const years = range in RANGES ? RANGES[range] : 5;

	const [daily, analytics, open] = await Promise.all([
		readDailyLevels(env, { code }),
		readAnalytics(env, { code }),
		readOpenConstituents(env, code),
	]);
	// Only on the branch that already found no list: one extra read, rarely.
	const openMissing =
		open === null ? await explainNoOpenConstituents(env, code) : null;
	const series = fromBase(daily);
	const returns = trailingReturns(series);
	const latest = daily.at(-1) ?? null;

	const from =
		years === null || returns === null
			? (series[0]?.date ?? null)
			: `${Number(returns.end.slice(0, 4)) - years}${returns.end.slice(4)}`;
	const window = series.filter((p) => from === null || p.date >= from);
	const opening = window[0]?.level ?? 1;
	const chart = window
		.filter((_, i) => i % 5 === 0 || i === window.length - 1)
		.map((p) => ({ date: p.date, value: (p.level / opening) * 100 }));

	const analyticsDate = analytics
		.map((a) => a.date)
		.sort()
		.at(-1);
	const meta = INDEX_META[code];
	return {
		code,
		name: meta.name,
		ticker: meta.ticker,
		covers: meta.covers,
		latest,
		baseDate: series[0]?.date ?? null,
		returns,
		range: range in RANGES ? range : "5y",
		chart,
		analytics: analytics.filter((a) => a.date === analyticsDate),
		openMissing,
		open:
			open === null
				? null
				: {
						rebalanceDate: open.rebalanceDate,
						asOfDate: open.asOfDate,
						count: open.rows.length,
						rows: open.rows.slice(0, 25),
					},
	};
};

const th = "px-3 py-2 font-semibold";
const td = "tabular px-3 py-2";

export default function IndexPage({ loaderData }: Route.ComponentProps) {
	const d = loaderData;
	return (
		<main className="max-w-6xl">
			<p className="text-sm">
				<Link
					className="text-primary underline underline-offset-4"
					to="/dashboard/indices"
				>
					Indices
				</Link>
			</p>
			<h1 className="mt-2 text-3xl font-semibold tracking-tight text-neutral-900">
				{d.name}
			</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				{d.ticker} · {d.covers}
				{d.latest
					? ` · ${d.latest.level.toFixed(4)} on ${d.latest.date}${d.latest.isProvisional ? " (provisional)" : ""}`
					: ""}
				{d.baseDate ? ` · base 100 on ${d.baseDate}` : ""}
			</p>

			{d.returns ? (
				<section className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-4 lg:grid-cols-7">
					{d.returns.periods.map((p) => (
						<div
							className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
							key={p.key}
						>
							<p className="text-[11px] uppercase tracking-wide text-slate-500">
								{PERIOD_LABEL[p.key]}
							</p>
							<p
								className={`tabular mt-1 text-lg font-semibold ${signClass(p.cumulative)}`}
							>
								{percent(p.cumulative)}
							</p>
							{p.key === "3y" || p.key === "5y" || p.key === "inception" ? (
								<p className="text-[11px] text-slate-500">
									{percent(p.annualised)} a year
								</p>
							) : null}
						</div>
					))}
				</section>
			) : null}

			<section className="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
				<div className="flex flex-wrap items-baseline justify-between gap-2">
					<p className="text-xs uppercase tracking-wide text-slate-500">
						Growth of $100
					</p>
					<div className="flex gap-2 text-xs">
						{(["1y", "5y", "inception"] as const).map((r) => (
							<Link
								className={`rounded-full border px-2.5 py-0.5 ${r === d.range ? "border-primary bg-primary/10 text-primary" : "border-slate-200 text-slate-600"}`}
								key={r}
								to={`?range=${r}`}
							>
								{r === "inception"
									? "Since inception"
									: r === "1y"
										? "1 year"
										: "5 years"}
							</Link>
						))}
					</div>
				</div>
				<LineChart
					format={(v) => `$${v.toFixed(0)}`}
					series={[{ label: d.name, className: "stroke-primary", points: d.chart }]}
				/>
			</section>

			{d.analytics.length > 0 ? (
				<section className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
					<h2 className="border-b border-slate-100 px-4 py-2.5 font-semibold text-neutral-900">
						Characteristics, rebalanced {d.analytics[0].rebalanceDate}, valued{" "}
						{d.analytics[0].date}
					</h2>
					<table className="w-full text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className={th}>Duration basis</th>
								<th className={`${th} text-right`}>Share</th>
								<th className={`${th} text-right`}>Securities</th>
								<th className={`${th} text-right`}>Market value</th>
								<th className={`${th} text-right`}>Yield</th>
								<th className={`${th} text-right`}>Duration</th>
								<th className={`${th} text-right`}>Convexity</th>
								<th className={`${th} text-right`}>Avg maturity</th>
							</tr>
						</thead>
						<tbody>
							{d.analytics.map((a) => (
								<tr className="border-t border-slate-100" key={a.durationBasis}>
									<td className="px-3 py-2 capitalize">{a.durationBasis}</td>
									<td className={`${td} text-right`}>
										{a.basisSharePercent.toFixed(1)}%
									</td>
									<td className={`${td} text-right`}>{a.constituentCount}</td>
									<td className={`${td} text-right`}>{money(a.marketValue)}</td>
									<td className={`${td} text-right`}>
										{a.yieldToMaturityPercent.toFixed(3)}%
									</td>
									<td className={`${td} text-right`}>
										{a.durationBasis === "floating"
											? `${a.spreadDuration.toFixed(2)} spread`
											: a.modifiedDuration.toFixed(2)}
									</td>
									<td className={`${td} text-right`}>{a.convexity.toFixed(4)}</td>
									<td className={`${td} text-right`}>
										{a.averageMaturity.toFixed(2)} y
									</td>
								</tr>
							))}
						</tbody>
					</table>
					<p className="px-4 py-2 text-xs text-slate-500">
						One row per duration basis: nominal bonds, inflation-linked and
						floating-rate notes are sensitive to different rates, so their durations
						are never blended. A floater's rate duration is near zero because its
						coupon resets; its spread duration is shown instead. Convexity is quoted
						as index providers publish it (the textbook figure divided by 100). Yield
						is real for the inflation-linked basis.
					</p>
				</section>
			) : null}

			{d.open ? (
				<section className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
					<h2 className="border-b border-slate-100 px-4 py-2.5 font-semibold text-neutral-900">
						Constituents: {d.open.count} securities, struck {d.open.rebalanceDate},
						priced {d.open.asOfDate}
					</h2>
					<table className="w-full text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className={th}>Security</th>
								<th className={`${th} text-right`}>Weight</th>
								<th className={`${th} text-right`}>Return so far</th>
								<th className={`${th} text-right`}>Contribution</th>
								<th className={`${th} text-right`}>Float par</th>
							</tr>
						</thead>
						<tbody>
							{d.open.rows.map((c) => (
								<tr className="border-t border-slate-100" key={c.cusip}>
									<td className="px-3 py-2">
										<Link
											className="text-primary underline-offset-4 hover:underline"
											to={`/dashboard/securities/${c.cusip}`}
										>
											{Number(c.couponPercent.toFixed(4))}% {c.maturity}
										</Link>{" "}
										<span className="font-mono text-xs text-slate-500">{c.cusip}</span>
									</td>
									<td className={`${td} text-right`}>{c.weightPercent.toFixed(2)}%</td>
									<td
										className={`${td} text-right ${signClass(c.securityReturnPercent)}`}
									>
										{c.securityReturnPercent.toFixed(2)}%
									</td>
									<td className={`${td} text-right`}>
										{(c.contributionPercent * 100).toFixed(1)} bp
									</td>
									<td className={`${td} text-right`}>{money(c.floatPar)}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p className="px-4 py-2 text-xs text-slate-500">
						The open period: membership and weights struck at the last rebalance,
						priced to the newest day, with what each has earned so far. The largest 25
						by weight. Float par is the amount outstanding less Federal Reserve
						holdings and buybacks: what an investor can own.
					</p>
				</section>
			) : (
				<p className="mt-6 text-sm text-slate-500">{d.openMissing}</p>
			)}
		</main>
	);
}
