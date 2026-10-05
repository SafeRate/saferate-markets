import { PRODUCT_NAME } from "@markets/schema";
import { REBALANCE_LABEL, STRATEGIES } from "@markets/portfolio";
import { Form, useNavigation } from "react-router";
import { RunningNotice } from "@/components/RunningNotice";
import { LineChart } from "@/components/LineChart";
import { money, percent, signClass } from "@/lib/format";
import { BENCHMARK_OPTIONS } from "@/lib/portfolioOptions";
import { requireOrganization } from "@/lib/session.server";
import {
	EARLIEST_START,
	latestDate,
	MAX_YEARS,
	parseRequest,
	runBacktestsCached,
} from "@/services/backtest.server";
import type { Route } from "./+types/dashboard.backtest";

export const meta: Route.MetaFunction = () => [
	{ title: `Strategy Backtests | ${PRODUCT_NAME}` },
];

/**
 * The Builder's strategy templates, run through history on real closes: see
 * packages/portfolio backtest.ts for the rules (managed by maturity slots from each rebalance
 * day's universe with the book's own value, self-financing, costs on every
 * trade, the ledger for everything between).
 */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	await requireOrganization(request, env);
	const latest = await latestDate(env);
	const params = new URL(request.url).searchParams;
	const fiveYearsBack = `${Number(latest.slice(0, 4)) - 5}${latest.slice(4)}`;
	const form = {
		strategy: params.get("strategy") ?? "all",
		start: params.get("start") ?? fiveYearsBack,
		end: params.get("end") ?? latest,
		frequency: params.get("frequency") ?? "quarterly",
		horizon: params.get("horizon") ?? "10",
		initial: params.get("initial") ?? "1000000",
		cost: params.get("cost") ?? "0.5",
		benchmark: params.get("benchmark") ?? "",
	};
	const parsed = parseRequest(params, latest, fiveYearsBack);
	const limits = { earliest: EARLIEST_START, latest, maxYears: MAX_YEARS };
	if (parsed === null) return { form, limits, outcome: null };
	if (!parsed.ok)
		return {
			form,
			limits,
			outcome: { ok: false as const, message: parsed.message },
		};
	const ran = await runBacktestsCached(
		env,
		context.cloudflare.ctx,
		parsed.request,
		latest,
	);
	return {
		form,
		limits,
		outcome: {
			ok: true as const,
			request: parsed.request,
			benchmark: ran.benchmark,
			results: ran.results.map((r) =>
				r.result.ok
					? { key: r.key, name: r.name, ...r.result, ok: true as const }
					: {
							key: r.key,
							name: r.name,
							ok: false as const,
							message: r.result.message,
						},
			),
		},
	};
};

type TLoader = Route.ComponentProps["loaderData"];

const th = "px-3 py-2 font-semibold";
const td = "tabular px-3 py-2";
const input =
	"mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm";
const COLOURS = [
	"stroke-primary",
	"stroke-sky-500",
	"stroke-emerald-600",
	"stroke-amber-500",
	"stroke-rose-500",
	"stroke-violet-500",
	"stroke-teal-500",
];

const annualisedOver = (
	cumulative: number,
	first: string | null,
	last: string | null,
) => {
	if (first === null || last === null) return null;
	const years = (Date.parse(last) - Date.parse(first)) / (365.25 * 86_400_000);
	return years > 1 ? (1 + cumulative) ** (1 / years) - 1 : cumulative;
};

const Stat = ({
	label,
	value,
	tone = "",
}: {
	label: string;
	value: string;
	tone?: string;
}) => (
	<div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
		<p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
		<p
			className={`tabular mt-1.5 text-xl font-semibold text-neutral-900 ${tone}`}
		>
			{value}
		</p>
	</div>
);

const Results = ({ outcome }: { outcome: NonNullable<TLoader["outcome"]> }) => {
	if (!outcome.ok)
		return (
			<p className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
				{outcome.message}
			</p>
		);
	const ok = outcome.results.filter((r) => r.ok);
	const failed = outcome.results.filter((r) => !r.ok);
	const b = outcome.benchmark;
	const axis = ok[0]?.series.map((p) => p.date) ?? [];
	const on = (series: { date: string; growth: number }[]) => {
		const byDate = new Map(series.map((p) => [p.date, p.growth * 100]));
		return axis.map((date) => ({ date, value: byDate.get(date) ?? null }));
	};
	const single = outcome.results.length === 1 ? ok[0] : undefined;
	const leaks = ok.filter((r) => Math.abs(r.externalCash) > 1);
	return (
		<>
			{single ? (
				<section className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
					<Stat
						label="Annualized"
						tone={signClass(single.annualised)}
						value={percent(single.annualised)}
					/>
					<Stat label="Volatility, a year" value={percent(single.volatility)} />
					<Stat
						label="Worst drawdown"
						tone={signClass(single.maxDrawdown)}
						value={percent(single.maxDrawdown)}
					/>
					<Stat label="Ending value" value={money(single.finalValue)} />
				</section>
			) : null}

			<section className="mt-8 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
				<p className="text-xs uppercase tracking-wide text-slate-500">
					Growth of $100
				</p>
				<LineChart
					format={(v) => `$${v.toFixed(0)}`}
					series={[
						...ok.map((r, i) => ({
							label: r.name,
							className: COLOURS[i % COLOURS.length],
							points: on(r.series),
						})),
						...(b
							? [
									{
										label: `${b.name} index`,
										className: "stroke-slate-400 [stroke-dasharray:4_3]",
										points: on(b.series),
									},
								]
							: []),
					]}
				/>
			</section>

			<section className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
				<table className="w-full text-sm">
					<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
						<tr>
							<th className={th}>Strategy</th>
							<th className={`${th} text-right`}>Annualized</th>
							<th className={`${th} text-right`}>Total</th>
							<th className={`${th} text-right`}>Volatility</th>
							<th className={`${th} text-right`}>Worst drawdown</th>
							<th className={`${th} text-right`}>Turnover a year</th>
							<th className={`${th} text-right`}>Income</th>
							<th className={`${th} text-right`}>Ending value</th>
							<th className={`${th} text-right`}>Trades</th>
						</tr>
					</thead>
					<tbody>
						{ok.map((r) => (
							<tr className="border-t border-slate-100" key={r.key}>
								<td className="px-3 py-2 font-medium">{r.name}</td>
								<td className={`${td} text-right ${signClass(r.annualised)}`}>
									{percent(r.annualised)}
								</td>
								<td className={`${td} text-right ${signClass(r.cumulative)}`}>
									{percent(r.cumulative)}
								</td>
								<td className={`${td} text-right`}>{percent(r.volatility)}</td>
								<td className={`${td} text-right`}>{percent(r.maxDrawdown)}</td>
								<td className={`${td} text-right`}>{percent(r.turnover, 0)}</td>
								<td className={`${td} text-right`}>{money(r.income)}</td>
								<td className={`${td} text-right`}>{money(r.finalValue)}</td>
								<td className={`${td} text-right`}>
									{r.trades.toLocaleString("en-US")}
								</td>
							</tr>
						))}
						{b ? (
							<tr className="border-t border-slate-200 bg-slate-50/60">
								<td className="px-3 py-2 text-slate-600">{b.name} index</td>
								<td className={`${td} text-right`}>
									{percent(annualisedOver(b.cumulative, b.first, b.last))}
								</td>
								<td className={`${td} text-right`}>{percent(b.cumulative)}</td>
								<td className={td} colSpan={6} />
							</tr>
						) : null}
					</tbody>
				</table>
			</section>
			{failed.map((r) => (
				<p className="mt-2 text-sm text-red-800" key={r.key}>
					{r.name}: {r.message}
				</p>
			))}
			{leaks.length > 0 ? (
				<p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
					{leaks
						.map((r) => `${r.name} needed ${money(r.externalCash)} more than it held`)
						.join("; ")}
					: the returns above treat that as new money.
				</p>
			) : null}

			{single ? (
				<section className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
					<table className="w-full text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className={th}>Rebalanced</th>
								<th className={`${th} text-right`}>Value going in</th>
								<th className={`${th} text-right`}>Bought</th>
								<th className={`${th} text-right`}>Sold</th>
								<th className={`${th} text-right`}>Trades</th>
								<th className={`${th} text-right`}>Rungs filled</th>
								<th className={th}>Notes</th>
							</tr>
						</thead>
						<tbody>
							{single.rebalances.map((r) => (
								<tr className="border-t border-slate-100" key={r.date}>
									<td className={td}>{r.date}</td>
									<td className={`${td} text-right`}>{money(r.value)}</td>
									<td className={`${td} text-right`}>{money(r.bought)}</td>
									<td className={`${td} text-right`}>{money(r.sold)}</td>
									<td className={`${td} text-right`}>{r.trades}</td>
									<td className={`${td} text-right`}>{r.held}</td>
									<td className="px-3 py-2 text-xs text-slate-500">
										{r.notes.join(" ")}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			) : null}

			<p className="mt-4 text-xs text-slate-500">
				The whole starting amount is in the book from the first day. On each
				rebalance date every position still inside one of the template's maturity
				rungs is held: ladders, the short end, the bullet and bills to maturity,
				while the intermediate, long and barbell bonds are sold once they age out of
				their sector. Cash from maturities, coupons and sales then buys whichever
				rungs are short of their equal share of the book, at the close plus the cost
				(sales at the close less it); what cannot be placed waits in cash, earning
				the bill curve's 1-month rate, and no money is ever added. The bullet's
				target dates are fixed at the start. Returns are time-weighted from the
				first day's close, so the first purchase's cost counts; volatility is of
				daily returns, annualized; turnover is half of everything bought and sold
				after the start, a year, over the average value. The index starts at the
				same close. A backtest uses the closes Safe Rate holds, not the prices a
				trade would have got, and says nothing about the future.
			</p>
		</>
	);
};

export default function Backtest({ loaderData }: Route.ComponentProps) {
	const { form, limits, outcome } = loaderData;
	const navigation = useNavigation();
	const running =
		navigation.state === "loading" &&
		navigation.location.pathname === "/dashboard/backtest" &&
		new URLSearchParams(navigation.location.search).has("run");
	return (
		<main className="max-w-6xl">
			<h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
				Strategy Backtests
			</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				The Portfolio Builder's strategy templates, run through history on real
				closes. Compare all seven, or look at one in detail.
			</p>

			<Form
				className="mt-6 grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4"
				method="get"
			>
				<input name="run" type="hidden" value="1" />
				<label className="text-sm">
					Strategy
					<select className={input} defaultValue={form.strategy} name="strategy">
						<option value="all">Compare all seven</option>
						{STRATEGIES.map((s) => (
							<option key={s.key} value={s.key}>
								{s.name}
							</option>
						))}
					</select>
				</label>
				<label className="text-sm">
					From
					<input
						className={input}
						defaultValue={form.start}
						max={limits.latest}
						min={limits.earliest}
						name="start"
						type="date"
					/>
				</label>
				<label className="text-sm">
					To
					<input
						className={input}
						defaultValue={form.end}
						max={limits.latest}
						min={limits.earliest}
						name="end"
						type="date"
					/>
				</label>
				<label className="text-sm">
					Rebalance
					<select className={input} defaultValue={form.frequency} name="frequency">
						{(["monthly", "quarterly", "annual"] as const).map((f) => (
							<option key={f} value={f}>
								{REBALANCE_LABEL[f]} (up to {limits.maxYears[f]} years)
							</option>
						))}
					</select>
				</label>
				<label className="text-sm">
					Starting amount
					<input
						className={input}
						defaultValue={form.initial}
						inputMode="numeric"
						name="initial"
					/>
				</label>
				<label className="text-sm">
					Cost each way, 32nds
					<input
						className={input}
						defaultValue={form.cost}
						inputMode="decimal"
						name="cost"
					/>
				</label>
				<label className="text-sm">
					Horizon, years (ladder, bullet)
					<input
						className={input}
						defaultValue={form.horizon}
						inputMode="numeric"
						name="horizon"
					/>
				</label>
				<label className="text-sm">
					Benchmark
					<select className={input} defaultValue={form.benchmark} name="benchmark">
						<option value="">The strategy's own (Aggregate for all)</option>
						{BENCHMARK_OPTIONS.map((o) => (
							<option key={o.code} value={o.code}>
								{o.label}
							</option>
						))}
					</select>
				</label>
				<div className="sm:col-span-2 lg:col-span-4">
					<button
						className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-60"
						disabled={running}
						type="submit"
					>
						{running ? "Running…" : "Run the backtest"}
					</button>
					<span className="ml-3 text-xs text-slate-500">
						Prices from {limits.earliest} to {limits.latest}. A run can take up to 30
						seconds.
					</span>
				</div>
			</Form>

			{running ? (
				<RunningNotice title="Running the backtest" upToSeconds={30} />
			) : outcome ? (
				<Results outcome={outcome} />
			) : null}
		</main>
	);
}
