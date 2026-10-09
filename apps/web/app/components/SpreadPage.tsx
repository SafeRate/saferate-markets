import { PRODUCT_NAME, SITE_HOSTS } from "@markets/schema";
import { useState } from "react";
import { Link } from "react-router";
import { JsonLd } from "@/components/JsonLd";
import { LineChart } from "@/components/LineChart";
import { StrategyDisclaimer } from "@/components/StrategyDisclaimer";
import { rate } from "@/lib/format";
import { breadcrumbJsonLd, datasetJsonLd } from "@/lib/jsonLd";
import type { TSpread } from "@/services/curveSpread.server";

/**
 * The page for one Treasury curve spread, shared by /curve/2s10s and
 * /curve/5s30s: the answer first (today's spread, its components, how it
 * moved and where it sits in its history), then the chart, the statistics,
 * related pages and sources. Every figure is in the server-rendered HTML; the
 * chart's range buttons only change which part of the history is drawn.
 */

const WINDOWS = [
	{ key: "1M", days: 31 },
	{ key: "3M", days: 92 },
	{ key: "1Y", days: 366 },
	{ key: "5Y", days: 1827 },
	{ key: "Max", days: null },
] as const;

const longDate = (iso: string) =>
	new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
const monthYear = (iso: string) =>
	new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
/** A spread or a change in basis points, signed, rounded to whole bp. */
export const bp = (value: number | null) =>
	value === null
		? "—"
		: `${value > 0.5 ? "+" : value < -0.5 ? "−" : ""}${Math.abs(Math.round(value))} bp`;

/**
 * How closely the fitted spread tracks Treasury's H.15 constant-maturity
 * spread, measured by treasury_exploration on 2026-10-09 over 274 days
 * (2025-09-04 to 2026-10-07). Update with the methodology page's table.
 */
const H15_AGREEMENT: Record<string, { rmse: number; mean: number }> = {
	"2s10s": { rmse: 2.36, mean: 1.31 },
	"5s30s": { rmse: 2.82, mean: 0.42 },
};

const RELATED: { path: string; label: string; key?: string }[] = [
	{ path: "/curve/2s10s", label: "2s10s Treasury spread", key: "2s10s" },
	{ path: "/curve/5s30s", label: "5s30s Treasury spread", key: "5s30s" },
	{ path: "/strategies/ladder-5y", label: "5-year Treasury ladder" },
	{ path: "/strategies/t-bill-reinvestment", label: "T-bill reinvestment" },
	{ path: "/methodology/treasury-curve", label: "Treasury curve methodology" },
];

export const SpreadPage = ({
	spread,
	path,
	title,
}: {
	spread: TSpread | null;
	path: string;
	title: string;
}) => {
	const [range, setRange] = useState<(typeof WINDOWS)[number]["key"]>("1Y");
	const web = SITE_HOSTS.production.web;
	const chosen = WINDOWS.find((w) => w.key === range) ?? WINDOWS[2];
	const from =
		spread && chosen.days !== null
			? new Date(
					new Date(`${spread.asOf}T00:00:00Z`).getTime() - chosen.days * 86_400_000,
				)
					.toISOString()
					.slice(0, 10)
			: null;
	const drawn = spread
		? spread.history.filter((p) => from === null || p.date >= from)
		: [];
	const shortLabel = spread ? `${spread.shortYears}-year` : "";
	const longLabel = spread ? `${spread.longYears}-year` : "";

	return (
		<main className="mx-auto max-w-6xl px-6 py-16">
			<JsonLd
				data={datasetJsonLd({
					id: `${web}${path}#dataset`,
					name: `${title} (Safe Rate fitted par curve)`,
					description: spread
						? `The ${longLabel} minus the ${shortLabel} U.S. Treasury par yield, in basis points, from Safe Rate's fitted Treasury curve, every business day since ${monthYear(spread.since)}.`
						: `A U.S. Treasury curve spread from Safe Rate's fitted par curve, every business day since September 2008.`,
					url: `${web}${path}`,
					temporalStart: spread?.since,
					keywords: [
						"U.S. Treasury",
						"yield curve",
						"curve spread",
						spread?.name ?? title,
					],
					apiPaths: [],
				})}
			/>
			<JsonLd
				data={breadcrumbJsonLd([
					{ name: PRODUCT_NAME, path: "/" },
					{ name: title, path },
				])}
			/>
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				Treasury curve
			</p>
			<h1 className="mt-3 text-4xl font-semibold tracking-tight text-neutral-900">
				{title}
				{spread ? `: ${bp(spread.bp)} (${longDate(spread.asOf)})` : ""}
			</h1>
			{spread ? (
				<div className="mt-5 max-w-3xl space-y-3 text-lg leading-relaxed text-slate-700">
					<p>
						On {longDate(spread.asOf)}, the {longLabel} Treasury par yield was{" "}
						{rate(spread.longYield, 2)} and the {shortLabel} was{" "}
						{rate(spread.shortYield, 2)}, a {spread.name} spread of {bp(spread.bp)}.
						That is {bp(spread.changes.day)} on the day and {bp(spread.changes.month)}{" "}
						over the past month.
					</p>
					<p>
						{spread.bp < 0
							? `The curve is inverted here: the ${shortLabel} yields more than the ${longLabel}. `
							: ""}
						Today's spread is at or above its level on {Math.round(spread.percentile)}
						% of the {spread.days.toLocaleString("en-US")} business days since{" "}
						{monthYear(spread.since)}.
					</p>
				</div>
			) : (
				<p className="mt-5 max-w-3xl text-lg text-slate-600">
					Today's spread could not be read just now. Try again shortly.
				</p>
			)}

			<StrategyDisclaimer
				trackLabel="Explore the curve"
				trackTo={`/sign-in?next=${encodeURIComponent("/dashboard/curves")}`}
			/>

			{spread ? (
				<>
					<section className="mt-12">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<h2 className="text-xl font-semibold tracking-tight text-neutral-900">
								{spread.name} history
							</h2>
							<div aria-label="Chart range" className="flex gap-1" role="group">
								{WINDOWS.map((w) => (
									<button
										aria-pressed={w.key === chosen.key}
										className={`rounded-full px-3 py-1 text-xs font-semibold ${
											w.key === chosen.key
												? "bg-primary text-primary-foreground"
												: "text-slate-600 hover:bg-slate-100"
										}`}
										key={w.key}
										onClick={() => setRange(w.key)}
										type="button"
									>
										{w.key}
									</button>
								))}
							</div>
						</div>
						<div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
							<LineChart
								format={(v) => `${Math.round(v)} bp`}
								series={[
									{
										label: `${spread.name}, Safe Rate fitted par curve`,
										className: "stroke-primary",
										points: drawn.map((p) => ({ date: p.date, value: p.bp })),
									},
									...(drawn.some((p) => p.h15 !== null)
										? [
												{
													label: "H.15 constant maturity (Federal Reserve)",
													className: "stroke-slate-400",
													points: drawn.map((p) => ({
														date: p.date,
														value: p.h15,
													})),
												},
											]
										: []),
								]}
							/>
						</div>
					</section>

					<section className="mt-12">
						<h2 className="text-xl font-semibold tracking-tight text-neutral-900">
							The numbers
						</h2>
						<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
							<table className="w-full min-w-[28rem] border-collapse text-sm">
								<tbody>
									{[
										["Today", bp(spread.bp), longDate(spread.asOf)],
										["Change on the day", bp(spread.changes.day), ""],
										["Change over a week", bp(spread.changes.week), ""],
										["Change over a month", bp(spread.changes.month), ""],
										["Change over a year", bp(spread.changes.year), ""],
										[
											`Low since ${monthYear(spread.since)}`,
											bp(spread.min.bp),
											longDate(spread.min.date),
										],
										[
											`High since ${monthYear(spread.since)}`,
											bp(spread.max.bp),
											longDate(spread.max.date),
										],
										[
											"Days at or below today's level",
											`${Math.round(spread.percentile)}%`,
											`of ${spread.days.toLocaleString("en-US")}`,
										],
										...(spread.h15
											? [
													[
														"H.15 constant-maturity spread",
														bp(spread.h15.bp),
														longDate(spread.h15.date),
													],
												]
											: []),
										[`${spread.longYears}-year par yield`, rate(spread.longYield, 3), ""],
										[
											`${spread.shortYears}-year par yield`,
											rate(spread.shortYield, 3),
											"",
										],
									].map(([label, value, note]) => (
										<tr
											className="border-t border-slate-100 first:border-t-0"
											key={label}
										>
											<td className="px-4 py-2 text-neutral-900">{label}</td>
											<td className="px-4 py-2 text-right font-medium tabular-nums">
												{value}
											</td>
											<td className="px-4 py-2 text-right text-xs text-slate-500">
												{note}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</section>
				</>
			) : null}

			<section className="mt-12">
				<h2 className="text-xl font-semibold tracking-tight text-neutral-900">
					Related
				</h2>
				<ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
					{RELATED.filter((r) => r.key !== spread?.key && r.path !== path).map(
						(r) => (
							<li key={r.path}>
								<Link className="text-primary underline underline-offset-4" to={r.path}>
									{r.label}
								</Link>
							</li>
						),
					)}
				</ul>
			</section>

			<section className="mt-12">
				<h2 className="text-xl font-semibold tracking-tight text-neutral-900">
					Sources
				</h2>
				<ul className="mt-3 max-w-3xl list-disc space-y-1 pl-5 text-sm text-slate-600">
					<li>
						Par yields from Safe Rate's fitted Treasury curve, built each business day
						from Treasury's end-of-day prices (FedInvest), a U.S. government
						publication.{" "}
						<Link
							className="text-primary underline underline-offset-4"
							to="/methodology/treasury-curve"
						>
							How the curve is built, and how closely it tracks the Federal Reserve's
						</Link>
						.
					</li>
					<li>
						This spread uses Safe Rate's fitted curve.
						{spread?.h15
							? " The grey line is Treasury's constant-maturity spread from the Federal Reserve's H.15 release (FRED series DGS2, DGS5, DGS10 and DGS30), which uses a different method and time of day."
							: " Treasury's constant-maturity yields from the Federal Reserve's H.15 release use a different method and time of day."}
						{spread && H15_AGREEMENT[spread.key]
							? ` Over the past year the two ${spread.name} spreads differed by ${H15_AGREEMENT[spread.key].rmse} basis points root mean square.`
							: ""}
					</li>
				</ul>
			</section>
		</main>
	);
};
