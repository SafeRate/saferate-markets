import { parseDate } from "@markets/portfolio";
import { PRODUCT_NAME } from "@markets/schema";
import {
	getBreakevenOn,
	getCurvesOn,
	getLatestCurve,
	getRealCurveOn,
} from "@saferate/treasury-client/client";
import { TREASURY_COVERAGE_START } from "@saferate/treasury-client/types";
import { data, Form, Link } from "react-router";
import { LineChart } from "@/components/LineChart";
import { requireOrganization } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.curves";

export const meta: Route.MetaFunction = () => [
	{ title: `Curves — ${PRODUCT_NAME}` },
];

/**
 * The SHAPE of each fitted curve on a day, against itself a week, a month and
 * a year earlier, with the changes in basis points and the fit's quality.
 * Treasury Rates is the same day as tables and a history; this is the curve
 * as a curve. Every comparison day is the last FITTED day on or before the
 * calendar date (a weekend or holiday has no fit), found from the data.
 */
const BACK = [
	{ key: "week", label: "1 week earlier", days: 7 },
	{ key: "month", label: "1 month earlier", days: 30 },
	{ key: "year", label: "1 year earlier", days: 365 },
] as const;

const MEASURES = {
	zero: { label: "Zero (spot)", pick: (p: { zeroRate: number }) => p.zeroRate },
	par: { label: "Par yield", pick: (p: { parYield: number }) => p.parYield },
	forward: {
		label: "Instantaneous forward",
		pick: (p: { forwardRate: number }) => p.forwardRate,
	},
} as const;

export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	await requireOrganization(request, env);
	const url = new URL(request.url);
	const asked = parseDate(url.searchParams.get("date") ?? "");
	const measure = (url.searchParams.get("measure") ??
		"zero") as keyof typeof MEASURES;
	const latest = await getLatestCurve({ env });
	if (latest === null)
		throw data("No fitted curve is available.", { status: 503 });
	if (asked !== null && asked < TREASURY_COVERAGE_START)
		return {
			latest: latest.date,
			outcome: {
				ok: false as const,
				message: `Coverage starts ${TREASURY_COVERAGE_START}.`,
			},
		};

	const shift = (iso: string, days: number) =>
		new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000)
			.toISOString()
			.slice(0, 10);
	/** The curves on the last fitted day on or before `date`, within ten days. */
	const fittedOnOrBefore = async (date: string) => {
		for (let i = 0; i < 10; i++) {
			const day = shift(date, i);
			if (day < TREASURY_COVERAGE_START) return null;
			const curves = await getCurvesOn({ env, date: day });
			if (curves?.hasAnyCurve) return curves;
		}
		return null;
	};

	const main =
		asked === null
			? await getCurvesOn({ env, date: latest.date })
			: await getCurvesOn({ env, date: asked });
	if (main === null || !main.hasAnyCurve)
		return {
			latest: latest.date,
			outcome: {
				ok: false as const,
				message: `No curve was fitted on ${asked}: a weekend, a holiday, or a day not yet published.`,
			},
		};
	const earlier = await Promise.all(
		BACK.map((b) => fittedOnOrBefore(shift(main.date, b.days))),
	);
	const days = [
		main,
		...earlier.filter((c): c is NonNullable<typeof c> => c !== null),
	];
	const [real, breakeven] = await Promise.all([
		Promise.all(days.map((c) => getRealCurveOn({ env, date: c.date }))),
		Promise.all(days.map((c) => getBreakevenOn({ env, date: c.date }))),
	]);
	const pick = (MEASURES[measure] ?? MEASURES.zero).pick as (p: never) => number;

	return {
		latest: latest.date,
		outcome: {
			ok: true as const,
			date: main.date,
			measure: measure in MEASURES ? measure : "zero",
			labels: [
				main.date,
				...BACK.map((b, i) =>
					earlier[i] ? `${b.label} (${earlier[i]?.date})` : null,
				),
			],
			diagnostics: main.zeroDiagnostics,
			nominal: days.map((c) => ({
				date: c.date,
				points: c.zero.map((p) => ({
					tenor: p.tenorYears,
					value: pick(p as never),
				})),
			})),
			real: real.map((r, i) => ({
				date: days[i].date,
				points: r?.rates.map((x) => ({ tenor: x.label, value: x.rate })) ?? [],
				tipsCount: r?.tipsCount ?? null,
			})),
			breakeven: breakeven.map((b, i) => ({
				date: days[i].date,
				points:
					b?.points.map((x) => ({ tenor: x.tenorYears, value: x.breakeven })) ?? [],
			})),
			moneyMarket: days.map((c) => ({
				date: c.date,
				points:
					c.moneyMarket?.rates.map((x) => ({ tenor: x.label, value: x.rate })) ?? [],
			})),
			comparedOn: [null, ...earlier.map((c) => c?.date ?? null)],
		},
	};
};

const COLOURS = [
	"stroke-primary",
	"stroke-sky-500",
	"stroke-amber-500",
	"stroke-slate-400",
];
const NAMES = ["", "1 week earlier", "1 month earlier", "1 year earlier"];
const tenorText = (t: number | string) =>
	typeof t === "number" ? (t < 1 ? `${Math.round(t * 12)}M` : `${t}Y`) : t;

type TCurve = {
	date: string;
	points: { tenor: number | string; value: number }[];
};

const CurveChart = ({
	title,
	curves,
	note,
}: {
	title: string;
	curves: TCurve[];
	note?: string;
}) => {
	const tenors = curves[0]?.points.map((p) => tenorText(p.tenor)) ?? [];
	return (
		<section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
			<h2 className="font-semibold text-neutral-900">{title}</h2>
			{tenors.length === 0 ? (
				<p className="mt-2 text-sm text-slate-500">Not fitted this day.</p>
			) : (
				<LineChart
					format={(v) => `${v.toFixed(2)}%`}
					height={200}
					series={curves.map((c, i) => {
						const byTenor = new Map(
							c.points.map((p) => [tenorText(p.tenor), p.value]),
						);
						return {
							label: i === 0 ? c.date : `${NAMES[i]} (${c.date})`,
							className: COLOURS[i] ?? "stroke-slate-300",
							// The chart's x axis is the tenor, spaced evenly: read it as a list.
							points: tenors.map((t) => ({ date: t, value: byTenor.get(t) ?? null })),
						};
					})}
				/>
			)}
			{note ? <p className="mt-1 text-xs text-slate-500">{note}</p> : null}
		</section>
	);
};

export default function Curves({ loaderData }: Route.ComponentProps) {
	const { latest, outcome } = loaderData;
	const th = "px-2.5 py-1.5 font-semibold";
	const td = "tabular px-2.5 py-1.5";
	return (
		<main className="max-w-6xl">
			<h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
				Curves
			</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				Safe Rate's fitted U.S. Treasury curves
				{outcome.ok ? ` on ${outcome.date}` : ""}, each against itself a week, a
				month and a year earlier. For the day's figures as tables, see{" "}
				<Link
					className="text-primary underline underline-offset-4"
					to="/dashboard/rates"
				>
					Treasury Rates
				</Link>
				.
			</p>
			<Form className="mt-4 flex flex-wrap items-end gap-3" method="get">
				<label className="text-sm">
					Day
					<input
						className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
						defaultValue={outcome.ok ? outcome.date : latest}
						max={latest}
						min={TREASURY_COVERAGE_START}
						name="date"
						type="date"
					/>
				</label>
				<label className="text-sm">
					Nominal curve
					<select
						className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
						defaultValue={outcome.ok ? outcome.measure : "zero"}
						name="measure"
					>
						{Object.entries(MEASURES).map(([k, m]) => (
							<option key={k} value={k}>
								{m.label}
							</option>
						))}
					</select>
				</label>
				<button
					className="rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-white hover:bg-primary/90"
					type="submit"
				>
					Show
				</button>
			</Form>

			{!outcome.ok ? (
				<p className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
					{outcome.message}
				</p>
			) : (
				<>
					<div className="mt-6 grid gap-4 lg:grid-cols-2">
						<CurveChart
							curves={outcome.nominal}
							note={
								outcome.diagnostics
									? `Fitted to ${outcome.diagnostics.securityCount} notes and bonds; error ${outcome.diagnostics.rmseBasisPoints.toFixed(1)} bp in yield, ${outcome.diagnostics.rmsePriceCents.toFixed(1)} cents in price (root mean square).`
									: undefined
							}
							title={`Nominal: ${MEASURES[outcome.measure as keyof typeof MEASURES].label}`}
						/>
						<CurveChart
							curves={outcome.real}
							note={
								outcome.real[0]?.tipsCount
									? `TIPS real rates, fitted to ${outcome.real[0].tipsCount} linkers.`
									: undefined
							}
							title="Real (TIPS)"
						/>
						<CurveChart
							curves={outcome.breakeven}
							note="Nominal less real: a market price of inflation, carrying a risk premium and a TIPS liquidity premium, not a forecast."
							title="Breakeven inflation"
						/>
						<CurveChart
							curves={outcome.moneyMarket}
							note="The bill curve, the front end of the market."
							title="Money market"
						/>
					</div>

					<section className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
						<h2 className="border-b border-slate-100 px-4 py-2.5 font-semibold text-neutral-900">
							Nominal{" "}
							{MEASURES[outcome.measure as keyof typeof MEASURES].label.toLowerCase()}:
							the change, in basis points
						</h2>
						<table className="w-full text-sm">
							<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
								<tr>
									<th className={th}>Tenor</th>
									<th className={`${th} text-right`}>{outcome.date}</th>
									{outcome.nominal.slice(1).map((c, i) => (
										<th className={`${th} text-right`} key={c.date}>
											vs {NAMES[i + 1]}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{outcome.nominal[0].points.map((p, row) => (
									<tr className="border-t border-slate-100" key={String(p.tenor)}>
										<td className="px-2.5 py-1.5">{tenorText(p.tenor)}</td>
										<td className={`${td} text-right`}>{p.value.toFixed(3)}%</td>
										{outcome.nominal.slice(1).map((c) => {
											const then = c.points[row]?.value;
											const change = then === undefined ? null : (p.value - then) * 100;
											return (
												<td className={`${td} text-right`} key={c.date}>
													{change === null
														? "—"
														: `${change > 0 ? "+" : change < 0 ? "−" : ""}${Math.abs(change).toFixed(1)}`}
												</td>
											);
										})}
									</tr>
								))}
							</tbody>
						</table>
					</section>
					<p className="mt-3 text-xs text-slate-500">
						The nominal curve is fitted each day to the end-of-day prices of every
						note and bond (Nelson-Siegel-Svensson), continuously compounded; zero is
						the spot rate, par the coupon that prices a bond at 100, forward the rate
						for an instant at that maturity. Tenors are spaced evenly on the charts,
						so read them as a list, not a scale. A comparison day is the last fitted
						day on or before the date a week, a month or a year back.
					</p>
				</>
			)}
		</main>
	);
}
