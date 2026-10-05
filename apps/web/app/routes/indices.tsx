import { readDailyLevelsOn, readLatestLevels } from "@markets/mcp-tools";
import { CONTACT_ADDRESS, PRODUCT_NAME } from "@markets/schema";
import { INDEX_META, INDEX_SLUG } from "@saferate/treasury-client/types";
import { JsonLd } from "@/components/JsonLd";
import { datasetJsonLd } from "@/lib/jsonLd";
import type { Route } from "./+types/indices";

export const meta: Route.MetaFunction = () => [
	{ title: `Indices | ${PRODUCT_NAME}` },
	{
		name: "description",
		content:
			"Eleven total-return indices of the U.S. Treasury market for benchmarking, custom indices built to your rules, and independent calculation and verification of a Treasury index or benchmark, every number rebuilt from primary sources.",
	},
];

/**
 * Indices for an institutional reader: benchmarks, custom indices, and the
 * calculation layer as an independent check. /docs/indices stays the
 * developer's guide (endpoints, dates, units); the construction rules are
 * quoted from saferate.com/treasury/indices, read 2026-10-05, and linked
 * rather than restated at length, so there is one version of the methodology.
 *
 * LICENSING, as saferate.com states it and Dylan confirmed (2026-10-05):
 * benchmarking is free, naming an index in a prospectus included; a product
 * built to TRACK an index (an ETF, an index fund, a product whose payout
 * references a level) needs an index license. The same wording is in
 * /docs/indices, the terms, plans.ts and legal.ts.
 *
 * The live table is optional: a failed read drops it, never the page.
 */
export const loader = async ({ context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	try {
		const [daily, monthEnds] = await Promise.all([
			readDailyLevelsOn(env),
			readLatestLevels(env),
		]);
		const monthEnd = new Map(monthEnds.map((row) => [row.code, row]));
		return {
			rows: daily.map((row) => ({
				code: row.code,
				date: row.date,
				level: row.level,
				sinceRebalance: row.returnSinceRebalancePercent,
				rebalanceDate: row.rebalanceDate,
				lastMonth: monthEnd.get(row.code)?.monthReturnPercent ?? null,
				holds: monthEnd.get(row.code)?.constituentCount ?? null,
			})),
		};
	} catch {
		return { rows: null };
	}
};

const signed = (value: number | null, digits = 2) =>
	value === null
		? "—"
		: `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`;
const shortDate = (iso: string) =>
	new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});

type TMeta = { name: string; ticker: string; covers: string };
const metaOf = (code: string) =>
	(INDEX_META as Record<string, TMeta>)[code] ?? {
		name: code,
		ticker: "",
		covers: "",
	};

const RULES = [
	[
		"Weighting",
		"Market value, on float par: amount outstanding less Federal Reserve holdings and buybacks, what an investor can own.",
	],
	[
		"Rebalancing",
		"Monthly, on the last trading day; the constituents and weights are struck at each month-end and held through the next.",
	],
	[
		"Pricing",
		"Treasury's own end-of-day file, the END OF DAY column, every business day. No evaluated pricing service.",
	],
	[
		"Levels",
		"Total return, chained from 100 at each index's base date, so a level reads as what $100 became.",
	],
	[
		"History",
		"Daily since the September 2008 base; the floating-rate index from December 2014, when floaters began.",
	],
];

const CUSTOM = [
	[
		"Universe",
		"Any slice of the marketable Treasury market: maturity bands, bills, nominal coupons, TIPS or floaters, on- or off-the-run, issue size or age.",
	],
	[
		"Weighting",
		"Market value or float-adjusted, as the published indices are, or the scheme your mandate specifies.",
	],
	[
		"Rebalancing",
		"Monthly, quarterly or on your calendar, with your own eligibility and holding rules.",
	],
	[
		"Delivery",
		"Daily levels, returns, analytics and full constituents, over the REST API and MCP and in the dashboard, with the history back-calculated on the same rules.",
	],
];

const VERIFY = [
	[
		"Recompute",
		"Rebuild an index, a fund benchmark or a model portfolio from Treasury's end-of-day prices and the published rules, security by security.",
	],
	[
		"Reconcile",
		"Every difference traced to its cause: a price, an accrual, a weight, a cash rule or a date convention, rather than a total that does not tie.",
	],
	[
		"Audit trail",
		"Constituents, prices, accrued interest and weights for every day, so a reviewer can follow any number back to its source.",
	],
];

const Pairs = ({ items }: { items: string[][] }) => (
	<dl className="mt-4 space-y-3">
		{items.map(([term, text]) => (
			<div className="grid grid-cols-1 gap-1 sm:grid-cols-[9rem_1fr]" key={term}>
				<dt className="text-sm font-semibold text-neutral-900">{term}</dt>
				<dd className="text-sm leading-relaxed text-slate-600">{text}</dd>
			</div>
		))}
	</dl>
);

export default function Indices({ loaderData }: Route.ComponentProps) {
	const { rows } = loaderData;
	const asOf = rows?.[0]?.date ?? null;
	return (
		<main className="mx-auto max-w-6xl px-6 py-16">
			<JsonLd
				data={datasetJsonLd({
					id: "https://saferate.markets/indices#dataset",
					name: "Safe Rate U.S. Treasury Total Return Indices",
					description:
						"Eleven total-return indices of the U.S. Treasury market (broad, maturity bands, bills, TIPS, floating-rate and aggregate), valued every business day from Treasury's end-of-day prices, market-value weighted on float par and rebalanced monthly: daily levels, returns, analytics and constituents.",
					url: "https://saferate.markets/indices",
					temporalStart: "2008-09-30",
					keywords: [
						"U.S. Treasury index",
						"bond index",
						"total return",
						"benchmark",
					],
					apiPaths: ["/v1/indices"],
				})}
			/>
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				Indices
			</p>
			<h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-neutral-900">
				Treasury indices you can rebuild, number by number.
			</h1>
			<p className="mt-4 max-w-3xl text-lg leading-relaxed text-slate-600">
				Eleven total-return indices of the U.S. Treasury market, valued every
				business day from Treasury's own end-of-day prices. Benchmark against them,
				have one built to your rules, or use the same calculation layer to check an
				index or benchmark you already rely on.
			</p>

			{rows && rows.length > 0 ? (
				<section className="mt-10 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
					<table className="w-full text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className="px-4 py-2.5 font-semibold">Index</th>
								<th className="px-4 py-2.5 font-semibold">Covers</th>
								<th className="px-4 py-2.5 text-right font-semibold">Level</th>
								<th className="px-4 py-2.5 text-right font-semibold">Month to date</th>
								<th className="px-4 py-2.5 text-right font-semibold">Last month</th>
								<th className="px-4 py-2.5 text-right font-semibold">Holds</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => {
								const meta = metaOf(row.code);
								const slug = (INDEX_SLUG as Record<string, string>)[row.code];
								return (
									<tr className="border-t border-slate-100" key={row.code}>
										<td className="px-4 py-2.5">
											{slug ? (
												<a
													className="font-medium text-primary underline-offset-4 hover:underline"
													href={`https://saferate.com/treasury/indices/${slug}`}
													rel="noopener"
													target="_blank"
												>
													{meta.name}
												</a>
											) : (
												<span className="font-medium">{meta.name}</span>
											)}
											<div className="font-mono text-[11px] text-slate-500">
												{meta.ticker}
											</div>
										</td>
										<td className="px-4 py-2.5 text-slate-600">{meta.covers}</td>
										<td className="tabular px-4 py-2.5 text-right">
											{row.level.toFixed(2)}
										</td>
										<td className="tabular px-4 py-2.5 text-right">
											{signed(row.sinceRebalance)}
										</td>
										<td className="tabular px-4 py-2.5 text-right">
											{signed(row.lastMonth)}
										</td>
										<td className="tabular px-4 py-2.5 text-right">{row.holds ?? "—"}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
					<p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
						{asOf ? `Levels at the ${shortDate(asOf)} close. ` : ""}Month to date runs
						from the last rebalance; last month is the completed month's total return.
						Each name opens its page on saferate.com.
					</p>
				</section>
			) : null}

			<section className="mt-16 grid grid-cols-1 gap-10 lg:grid-cols-2">
				<div>
					<h2 className="text-2xl font-semibold tracking-tight text-neutral-900">
						How they are built
					</h2>
					<Pairs items={RULES} />
					<p className="mt-4 text-sm">
						<a
							className="text-primary underline underline-offset-4"
							href="https://saferate.com/treasury/indices"
							rel="noopener"
							target="_blank"
						>
							Full methodology and history on saferate.com
						</a>
					</p>
				</div>
				<div className="rounded-2xl border border-slate-200 bg-slate-50 p-6">
					<h2 className="text-lg font-semibold text-neutral-900">
						Benchmark with them
					</h2>
					<ul className="mt-3 space-y-2 text-sm leading-relaxed text-slate-700">
						<li>
							Measure a Treasury portfolio against the index that matches its mandate,
							with return attribution in the dashboard that splits the difference into
							carry, roll-down, curve and selection.
						</li>
						<li>
							Read each index's yield, duration, convexity and key-rate durations, and
							every month's constituents, to see exactly what the benchmark holds.
						</li>
						<li>
							Take levels, returns, analytics and constituents into your own systems
							over the REST API, or ask for them in plain language over MCP.
						</li>
					</ul>
					<p className="mt-4 text-sm">
						<a
							className="text-primary underline underline-offset-4"
							href="/docs/indices"
						>
							Indices in the API
						</a>
					</p>
				</div>
			</section>

			<section className="mt-16 grid grid-cols-1 gap-6 lg:grid-cols-2">
				<div className="rounded-2xl border border-primary/20 bg-white p-6 shadow-sm">
					<p className="text-[11px] font-bold uppercase tracking-[0.16em] text-primary">
						Custom indices
					</p>
					<h2 className="mt-2 text-xl font-semibold text-neutral-900">
						An index built to your rules
					</h2>
					<p className="mt-2 text-sm leading-relaxed text-slate-600">
						A custom index is built the way the eleven published ones are: the same
						prices, the same total-return arithmetic and the same delivery, to the
						rules your mandate or product needs.
					</p>
					<Pairs items={CUSTOM} />
				</div>
				<div className="rounded-2xl border border-primary/20 bg-white p-6 shadow-sm">
					<p className="text-[11px] font-bold uppercase tracking-[0.16em] text-primary">
						Independent verification
					</p>
					<h2 className="mt-2 text-xl font-semibold text-neutral-900">
						A second calculation you can trust
					</h2>
					<p className="mt-2 text-sm leading-relaxed text-slate-600">
						Our calculation layer prices every Treasury, accrues every coupon and
						values every portfolio from primary sources alone. Use it to check an
						index, a benchmark or a valuation you take from elsewhere.
					</p>
					<Pairs items={VERIFY} />
				</div>
			</section>

			<section className="mt-16 rounded-2xl bg-slate-950 p-8 text-slate-100">
				<h2 className="text-2xl font-semibold tracking-tight text-white">
					Talk to us about an index
				</h2>
				<p className="mt-2 max-w-3xl text-slate-300">
					Benchmarking against the indices is free, naming one as a fund's benchmark
					in a prospectus included. An ETF, index fund or other product built to
					track one needs an{" "}
					<a className="text-sky-300 underline underline-offset-4" href="/pricing">
						index license
					</a>
					. For that, a custom index or independent verification, write to{" "}
					<span className="font-medium text-white">{CONTACT_ADDRESS}</span>.
				</p>
			</section>
		</main>
	);
}
