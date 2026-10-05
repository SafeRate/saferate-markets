import { TREASURY_URLS } from "@markets/mcp-tools";
import { API_SURFACES, PRODUCT_NAME, SITE_HOSTS } from "@markets/schema";
import { TREASURY_COVERAGE_START } from "@saferate/treasury-client/types";
import type { Route } from "./+types/data";

export const meta: Route.MetaFunction = () => [
	{ title: `Data — ${PRODUCT_NAME}` },
	{
		name: "description",
		content:
			"Every dataset in Safe Rate Markets: daily prices for every marketable Treasury, fitted yield curves, analytics, rich/cheap, auctions, eleven total-return indices, the public debt and savings bonds. From primary sources, daily since September 2008.",
	},
];

/**
 * What data Markets holds, where each set comes from, and where to get it: the
 * dashboard page, the REST routes and the MCP tool. The routes and tools are
 * read from API_SURFACES (the same list the docs page renders and
 * tests/surfaces.test.ts holds to the published spec), so a dataset here can
 * never point at an endpoint that does not exist. Coverage dates are stated
 * only where the data fixes them (TREASURY_COVERAGE_START); nothing here
 * claims a start date that has not been checked.
 */

const coverage = new Date(
	`${TREASURY_COVERAGE_START}T00:00:00Z`,
).toLocaleDateString("en-US", {
	month: "long",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

type TDataset = {
	title: string;
	what: string;
	source: string;
	since?: string;
	/** Dashboard pages, signed in. */
	pages: { label: string; to: string }[];
	/** API_SURFACES group names whose routes and tools serve this set. */
	surfaces: string[];
	/** A methodology page beyond the API reference. */
	more?: { label: string; to: string };
	/** The public, interactive view of this data on saferate.com/treasury
	 *  (each checked to answer 200, 2026-10-05). */
	interactive: { label: string; href: string }[];
};

const DATASETS: TDataset[] = [
	{
		title: "Prices and securities",
		what:
			"Every marketable Treasury bill, note, bond, TIPS and floating-rate note, priced at the end of every business day, with its terms, amount outstanding and on-the-run status.",
		source:
			"Treasury's end-of-day prices published through TreasuryDirect; amounts outstanding from the Monthly Statement of the Public Debt.",
		since: coverage,
		pages: [
			{ label: "Security Lookup", to: "/dashboard/securities" },
			{ label: "On / Off the Run", to: "/dashboard/on-the-run" },
		],
		surfaces: ["Securities", "Calculators"],
		interactive: [
			{ label: "Security lookup", href: TREASURY_URLS.securities },
			{ label: "On the run", href: TREASURY_URLS.onTheRun },
			{ label: "Calculator", href: TREASURY_URLS.calculator },
		],
	},
	{
		title: "Yield curves",
		what:
			"Safe Rate's fitted curves, every business day: the nominal zero, par and forward curves (Nelson-Siegel-Svensson, fitted to every note and bond), the TIPS real curve, breakeven inflation, and the bill (money-market) curve.",
		source: "Fitted by Safe Rate to Treasury's end-of-day prices.",
		since: coverage,
		pages: [
			{ label: "Treasury Rates", to: "/dashboard/rates" },
			{ label: "Curves", to: "/dashboard/curves" },
		],
		surfaces: ["Curves"],
		interactive: [
			{ label: "Treasury rates today", href: TREASURY_URLS.rates },
			{ label: "Yield curves", href: TREASURY_URLS.curves },
			{ label: "Curve methodology", href: TREASURY_URLS.methodology },
		],
	},
	{
		title: "Analytics and rich/cheap",
		what:
			"Each security's yield, duration, convexity and DV01, its distance from the fitted curve, and how unusual that distance is against its own history (a z-score), for relative value.",
		source: "Computed by Safe Rate from the prices and curves above.",
		pages: [{ label: "Rich / Cheap", to: "/dashboard/rich-cheap" }],
		surfaces: ["Rich/cheap"],
		interactive: [],
	},
	{
		title: "Auctions",
		what:
			"The auction schedule and results: what is announced (new issues included, before they are issued), what has been auctioned and not yet settled, and each result's rates, bid-to-cover, and dealer, direct and indirect shares.",
		source: "Treasury's auction data, through Fiscal Data.",
		pages: [{ label: "Treasury Auctions", to: "/dashboard/auctions" }],
		surfaces: ["Auctions"],
		interactive: [
			{ label: "Auction schedule and results", href: TREASURY_URLS.auctions },
		],
	},
	{
		title: "Indices",
		what:
			"Eleven Safe Rate total-return indices of the Treasury market, from the broad index to maturity bands, bills, TIPS and floaters: daily levels, returns, analytics and the constituents of every month.",
		source:
			"Constructed by Safe Rate from the prices above, rebalanced at each month-end; float par excludes Federal Reserve holdings and buybacks.",
		pages: [{ label: "Indices", to: "/dashboard/indices" }],
		surfaces: ["Indices"],
		interactive: [{ label: "Total return indices", href: TREASURY_URLS.indices }],
		more: { label: "Index methodology", to: "/docs/indices" },
	},
	{
		title: "The public debt",
		what:
			"Federal debt outstanding, marketable and non-marketable, from the monthly statement, and how much of each security is held as STRIPS.",
		source: "The Monthly Statement of the Public Debt.",
		pages: [],
		surfaces: ["Debt"],
		interactive: [
			{ label: "Market statistics", href: TREASURY_URLS.marketStatistics },
		],
	},
	{
		title: "Savings bonds",
		what: "Series I and EE rates, and the value of a bond bought on any date.",
		source: "TreasuryDirect's published rates.",
		pages: [],
		surfaces: ["Savings bonds"],
		interactive: [
			{ label: "Savings bond calculator", href: TREASURY_URLS.savingsBonds },
		],
	},
];

const surfacesOf = (names: string[]) =>
	API_SURFACES.filter((s) => names.includes(s.group));

export default function Data() {
	const api = SITE_HOSTS.production.api;
	return (
		<main className="mx-auto max-w-6xl px-6 py-16">
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				Data
			</p>
			<h1 className="mt-3 text-4xl font-semibold tracking-tight text-neutral-900">
				The whole U.S. Treasury market, daily.
			</h1>
			<p className="mt-4 max-w-3xl text-lg text-slate-600">
				Every dataset Safe Rate Markets holds, where it comes from, and where to get
				it: in the dashboard, over the REST API at{" "}
				<code className="font-mono text-base">{api}</code>, and to AI agents over
				MCP. Daily since {coverage}, from primary sources, with no data license to
				pay for. Most of it can also be explored, free and interactive, on{" "}
				<a
					className="text-primary underline underline-offset-4"
					href={TREASURY_URLS.home}
					rel="noopener"
					target="_blank"
				>
					saferate.com/treasury
				</a>
				.
			</p>

			<div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-2">
				{DATASETS.map((d) => {
					const surfaces = surfacesOf(d.surfaces);
					const tools = surfaces
						.flatMap((s) => (s.tool ?? "").split(", "))
						.filter(Boolean);
					return (
						<section
							className="flex flex-col rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
							id={d.title.toLowerCase().replace(/[^a-z]+/g, "-")}
							key={d.title}
						>
							<div className="flex flex-wrap items-baseline justify-between gap-2">
								<h2 className="text-lg font-semibold text-neutral-900">{d.title}</h2>
								{d.since ? (
									<span className="text-xs text-slate-500">Daily since {d.since}</span>
								) : null}
							</div>
							<p className="mt-2 text-sm leading-relaxed text-slate-700">{d.what}</p>
							<p className="mt-2 text-xs leading-relaxed text-slate-500">
								<span className="font-semibold text-slate-600">Source.</span> {d.source}
							</p>
							<div className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm">
								{d.pages.length > 0 || d.more ? (
									<p>
										<span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
											Dashboard
										</span>{" "}
										{d.pages.map((p, i) => (
											<span key={p.to}>
												{i > 0 ? " · " : ""}
												<a
													className="text-primary underline underline-offset-4"
													href={p.to}
												>
													{p.label}
												</a>
											</span>
										))}
										{d.more ? (
											<>
												{d.pages.length > 0 ? " · " : ""}
												<a
													className="text-primary underline underline-offset-4"
													href={d.more.to}
												>
													{d.more.label}
												</a>
											</>
										) : null}
									</p>
								) : null}
								{d.interactive.length > 0 ? (
									<p>
										<span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
											See it on saferate.com
										</span>{" "}
										{d.interactive.map((v, i) => (
											<span key={v.href}>
												{i > 0 ? " · " : ""}
												<a
													className="text-primary underline underline-offset-4"
													href={v.href}
													rel="noopener"
													target="_blank"
												>
													{v.label}
												</a>
											</span>
										))}
									</p>
								) : null}
								<div>
									<p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
										API
									</p>
									<ul className="mt-1 space-y-0.5">
										{surfaces
											.flatMap((s) => s.routes)
											.map((r) => (
												<li className="text-xs text-slate-600" key={r.path}>
													<code className="font-mono text-[12px] text-slate-800">
														{r.path}
													</code>{" "}
													<span className="text-slate-500">{r.what}</span>
												</li>
											))}
									</ul>
								</div>
								{tools.length > 0 ? (
									<p className="text-xs text-slate-600">
										<span className="font-semibold uppercase tracking-wide text-slate-500">
											MCP
										</span>{" "}
										{tools.map((t, i) => (
											<span key={t}>
												{i > 0 ? ", " : ""}
												<code className="font-mono text-[12px] text-slate-800">{t}</code>
											</span>
										))}
									</p>
								) : null}
							</div>
						</section>
					);
				})}
			</div>

			<section className="mt-12 rounded-xl border border-slate-200 bg-slate-50 p-6">
				<h2 className="font-semibold text-neutral-900">From primary sources</h2>
				<p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">
					Every input is published by its issuer and free to anyone: Treasury's
					end-of-day prices through TreasuryDirect, the Monthly Statement of the
					Public Debt, auction results and buybacks from Treasury's Fiscal Data, and
					Federal Reserve holdings from the New York Fed. No evaluated pricing
					service and no licensed data, so anyone can rebuild every number. Safe
					Rate's curves, analytics and indices are its own construction, not official
					U.S. Treasury statistics.
				</p>
				<p className="mt-4 text-sm">
					<a className="text-primary underline underline-offset-4" href="/docs">
						API and MCP documentation
					</a>
				</p>
			</section>
		</main>
	);
}
