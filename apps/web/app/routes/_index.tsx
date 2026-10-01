import { PLANS, PRODUCT_NAME } from "@markets/schema";
import { TREASURY_COVERAGE_START } from "@saferate/treasury-client/types";
import type { Route } from "./+types/_index";

export const meta: Route.MetaFunction = () => [
	{ title: `${PRODUCT_NAME} — Portfolio management for U.S. Treasuries` },
	{
		name: "description",
		content:
			"Track, build, stress-test, backtest and trade U.S. Treasury portfolios, on every bill, note, bond, TIPS and floater priced daily since September 2008, from primary sources with no data licence to buy. Also over a REST API and an MCP server.",
	},
];

/**
 * Plan copy and prices are READ from @markets/schema, never typed here: a price
 * in prose is a price that goes stale the first time it changes. The coverage
 * date is the client's TREASURY_COVERAGE_START (2008-09-02, the first trading
 * day after Labor Day; checked against production by treasury-integration,
 * 2026-10-01), not a date in prose. Provenance wording follows saferate.com's
 * index pages; it says the inputs are free primary sources, which is a claim
 * about availability, and deliberately not "public domain", which is a
 * copyright claim nobody has checked.
 */

const coverage = new Date(
	`${TREASURY_COVERAGE_START}T00:00:00Z`,
).toLocaleDateString("en-US", {
	month: "long",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

const SUITE: { title: string; body: string }[] = [
	{
		title: "Portfolio tracking",
		body:
			"Enter trades by hand or import a broker blotter. Value, income, and time- and money-weighted returns against a Safe Rate index, with FIFO lots, cash or reinvested coupons, and attribution to carry, roll-down, the curve's level, slope and curvature, and selection.",
	},
	{
		title: "Portfolio construction",
		body:
			"Fund a stream of liabilities by cash-flow matching, immunisation or horizon matching; track an index; or start from a ladder, barbell, bullet or bill roll. Lot sizes for retail brokers, Apex and TreasuryDirect, or institutional blocks.",
	},
	{
		title: "Risk and stress testing",
		body:
			"Key-rate DV01, standard and custom curve shocks, and replays of past market events on today's holdings. Value at risk and expected shortfall from filtered historical simulation with extreme-value tails, and fat-tail diagnostics.",
	},
	{
		title: "Backtesting",
		body:
			"Run the strategy templates through real history since 2008: rebalanced monthly to yearly, with trading costs, turnover and drawdowns, against the Safe Rate indices.",
	},
	{
		title: "Trade execution",
		body:
			"Turn a plan into an order sheet with limit prices, split between what TreasuryDirect can fill at auction and what goes to the secondary market, ready for your broker as CSV.",
	},
	{
		title: "Market analytics",
		body:
			"Look up any security; fitted nominal, real, breakeven and money-market curves; auction results with who bought them; on-the-run premiums; rich/cheap to the curve; and eleven total-return indices.",
	},
	{
		title: "API and MCP",
		body:
			"The same data and analytics over a REST API and an MCP server, so your systems and your AI agents read the numbers the dashboard shows.",
	},
];

const FACTS = [
	["Since", coverage],
	["Coverage", "Bills, notes, bonds, TIPS, FRNs"],
	["Updated", "Every business day"],
	["Data licence", "None needed"],
] as const;

export default function Home() {
	return (
		<main className="mx-auto max-w-5xl px-6 py-20">
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				Portfolio management for U.S. Treasuries
			</p>
			<h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.05] tracking-tight text-neutral-900 md:text-5xl">
				Track, build, stress-test and trade Treasury portfolios, on the whole market
				since 2008.
			</h1>
			<p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-600">
				One suite for the whole workflow, on every bill, note, bond, TIPS and
				floating-rate note, priced every business day since {coverage}. Built
				entirely on primary sources Treasury and the Federal Reserve publish free,
				so there is no market-data licence to buy.
			</p>
			<div className="mt-8 flex flex-wrap gap-3">
				<a
					className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
					href="/sign-in"
				>
					Tour the live demo
				</a>
				<a
					className="rounded-full border border-slate-200 px-5 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-primary/40 hover:text-primary"
					href="/docs"
				>
					Read the docs
				</a>
			</div>

			<section className="mt-20">
				<h2 className="text-2xl font-semibold tracking-tight text-neutral-900">
					The whole workflow, in one place
				</h2>
				<div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{SUITE.map((item) => (
						<div
							className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
							key={item.title}
						>
							<h3 className="font-semibold text-neutral-900">{item.title}</h3>
							<p className="mt-2 text-sm leading-relaxed text-slate-600">
								{item.body}
							</p>
						</div>
					))}
				</div>
			</section>

			<section className="mt-20 grid gap-8 md:grid-cols-2">
				<div>
					<h2 className="text-2xl font-semibold tracking-tight text-neutral-900">
						The whole market, from primary sources
					</h2>
					<p className="mt-4 text-sm leading-relaxed text-slate-600">
						Every marketable Treasury, every business day since {coverage}: prices,
						yields, durations and key-rate risk, rich/cheap to Safe Rate's fitted
						curves, auction results, amounts outstanding and STRIPS, and total-return
						indices built from them.
					</p>
					<p className="mt-3 text-sm leading-relaxed text-slate-600">
						Every input is a primary source, published by its issuer and free to
						anyone. Prices come from the end-of-day file Treasury publishes daily
						through TreasuryDirect, the statutory prices federal agencies use to value
						the securities they hold. Amounts outstanding come from the Monthly
						Statement of the Public Debt, auction results and buybacks from Treasury's
						Fiscal Data, and Federal Reserve holdings from the New York Fed. No
						evaluated pricing service, no vendor marks and no licensed data, so anyone
						can rebuild every number.
					</p>
					<p className="mt-3 text-xs leading-relaxed text-slate-500">
						What that leaves is a timing difference rather than a data one: Treasury's
						mark is struck near 3:30 PM, where much of the industry has marked at 4:00
						PM since 2021. Safe Rate's indices and analytics are its own construction,
						not official U.S. Treasury statistics.
					</p>
				</div>
				<div className="grid content-start gap-3 sm:grid-cols-2">
					{FACTS.map(([label, value]) => (
						<div
							className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
							key={label}
						>
							<p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
							<p className="mt-1 font-semibold text-neutral-900">{value}</p>
						</div>
					))}
				</div>
			</section>

			<section className="mt-20">
				<h2 className="text-2xl font-semibold tracking-tight text-neutral-900">
					Plans
				</h2>
				<p className="mt-2 text-sm text-slate-600">
					Sign in free to tour the live demo: sample portfolios, a liability stream
					and a plan, on today's market. Every plan then includes the full dashboard
					for your own portfolios; plans differ in API and MCP limits and in who may
					use them.
				</p>
				<div className="mt-6 grid gap-6 md:grid-cols-3">
					{PLANS.map((plan) => (
						<div
							className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
							key={plan.id}
						>
							<h3 className="font-semibold text-neutral-900">{plan.name}</h3>
							<p className="mt-1 text-sm text-slate-600">{plan.summary}</p>
							<p className="mt-3 font-semibold text-neutral-900">
								{plan.sale.kind === "checkout"
									? `$${plan.sale.priceUsdMonthly}/month`
									: "Custom"}
							</p>
						</div>
					))}
				</div>
				<p className="mt-6 text-sm">
					<a className="text-primary underline underline-offset-4" href="/pricing">
						Compare plans
					</a>
				</p>
			</section>
		</main>
	);
}
