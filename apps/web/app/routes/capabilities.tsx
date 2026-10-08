import { PRODUCT_NAME } from "@markets/schema";
import type { Route } from "./+types/capabilities";

export const meta: Route.MetaFunction = () => [
	{ title: `Capabilities | ${PRODUCT_NAME}` },
	{
		name: "description",
		content:
			"What Safe Rate Markets does and how: portfolio construction (cash-flow matching, immunization, horizon matching, index tracking), stress testing by full repricing, value at risk from filtered historical simulation, backtesting, return attribution and order sheets for U.S. Treasury portfolios.",
	},
];

/**
 * Capabilities, with how each is implemented. Every "how" here is read from
 * the code it describes (packages/portfolio: build/cashflowMatching.ts,
 * build/immunisation.ts, builder.ts, risk/portfolioStress.ts,
 * risk/historicalSimulation.ts, risk/tsay.ts, backtest.ts, attribution.ts,
 * returns.ts; read 2026-10-05), and the measured figures (kurtosis, the
 * 18.2-sigma slope day, the barbell) are the ones those modules record. When a
 * module changes what it does, change its paragraph here.
 */

type TCapability = {
	id: string;
	kicker: string;
	title: string;
	what: string;
	how: string[];
	references?: string;
	page?: { label: string; to: string };
};

const CAPABILITIES: TCapability[] = [
	{
		id: "construction",
		kicker: "Portfolio construction",
		title: "Cash-flow matching: the cheapest portfolio that pays every liability",
		what:
			"Give it a liability stream (pension payments, a debt schedule, tuition, a defeasance) and it returns the cheapest set of Treasuries whose coupons and principal arrive in time to pay each one, with nothing left to forecast and nothing to trade again.",
		how: [
			"Solved as a mixed-integer program, not a linear one: a linear program happily returns forty positions of a few thousand dollars, which nobody can trade. Position counts and minimum lots are what make the answer a portfolio.",
			"Surplus rolls forward at a reinvestment rate, written as one cumulative constraint per date rather than a chain of variables: the same program, a third the size.",
			"The branch-and-bound bound on each position is set from the security's own cumulative cashflows against the cumulative liability, far tighter than the textbook choice, which is what lets real multi-year streams solve.",
			"Lots follow how you will actually buy: retail ($1,000 steps), Apex or TreasuryDirect ($100), institutional ($250k positions), or your own.",
		],
		references: "Ronn (1987), JFQA; Wolsey (1998), Integer Programming.",
		page: { label: "Portfolio Builder", to: "/dashboard/builder" },
	},
	{
		id: "immunization",
		kicker: "Portfolio construction",
		title: "Immunization: match the curve exposure, not the cashflows",
		what:
			"The cheaper, easier-to-trade way to fund liabilities: hold a handful of securities whose sensitivity to the curve equals the liability's, so the two move together and the funding ratio holds.",
		how: [
			"Exposure is measured as key-rate durations at twelve tenors (Ho's triangular key rates), so the match is to the shape of the curve, not a single duration number.",
			"Total duration is matched first and the shape only afterwards. Minimizing the twelve-element error alone can put a 10-year liability 99.6% into 2-year bonds; matching duration first returns the 71/29 barbell at exactly 10 years.",
			"What the match cannot cover is reported, not hidden: the residual key-rate exposure says how much steepening or flattening risk the portfolio still carries.",
			"Horizon matching combines the two: cash-match the liabilities inside your horizon, where timing matters most, and immunize the rest.",
		],
		references:
			"Redington (1952); Fisher and Weil (1971); Ho (1992), Key Rate Durations.",
		page: { label: "Portfolio Builder", to: "/dashboard/builder" },
	},
	{
		id: "templates",
		kicker: "Portfolio construction",
		title: "Strategy templates and index tracking",
		what:
			"Start from a ladder, a barbell, a bullet, a bill roll, or a short, intermediate or long-duration book, or track a Safe Rate index with a small number of positions.",
		how: [
			"Each template is built from the day's priced universe, sized to your amount, and turned into an order sheet in the same lots as above.",
			"Index tracking builds a sparse portfolio with the index's key-rate profile for your budget, holding at most fourteen securities (one per constraint), and reports the key-rate exposure it could not match.",
		],
		page: { label: "Portfolio Builder", to: "/dashboard/builder" },
	},
	{
		id: "stress",
		kicker: "Risk",
		title: "Stress testing by full repricing",
		what:
			"What today's holdings would lose in standard rate shocks, in every stored market episode since 2008 replayed on today's book, and in a shock of your own.",
		how: [
			"Every cashflow is discounted again at its own shocked zero rate: exact at any size and shape of move, where duration and convexity approximations break down, which is precisely in the scenarios worth asking about.",
			"A scenario is a shift at twelve key rates, interpolated to each cashflow with the same triangles the key-rate durations are defined by, so a scenario and its first-order approximation describe the same move; the gap between them is reported as the convexity term.",
			"Standard shocks run from parallel moves of ±50, ±100 and ±300bp to bull and bear steepeners and flatteners and a 5-year butterfly; historical episodes apply each event's actual key-rate move to what you hold now.",
			"TIPS move on real duration with breakevens held, floating-rate notes on their near-zero rate duration, both shown apart from the nominal book.",
		],
		page: { label: "Stress Testing", to: "/dashboard/stress" },
	},
	{
		id: "var",
		kicker: "Risk",
		title:
			"Value at risk and expected shortfall, without the normal distribution",
		what:
			"One-day and ten-day value at risk and expected shortfall at 95% and 99%, with the tail diagnostics that say how much to trust them.",
		how: [
			"Measured on this history, curve moves are nowhere near normal: the level factor has kurtosis 6.3 against the normal's 3.0, the slope factor 79.8, and the worst slope day sits 18.2 standard deviations out. So the scenarios are real days, not draws from a fitted bell curve.",
			"Filtered historical simulation: whole days are sampled at once, keeping the correlation between tenors, and each day is divided by the GARCH(1,1) volatility of its time and rescaled to today's, so a 2008 day contributes its shape while today's volatility sets its size. 50,000 paths.",
			"The far tail is read from a fitted generalized Pareto distribution (extreme value theory), beside the empirical figure and a Student-t fitted by maximum likelihood; where they disagree, the tail is the uncertain part, and the page says so.",
			"Tsay's diagnostics on the book's own history: skewness, excess kurtosis, Jarque-Bera, Ljung-Box on squared returns for volatility clustering, and Hill's tail index.",
		],
		references: "Tsay (2010), Analysis of Financial Time Series, 3rd ed.",
		page: { label: "Stress Testing", to: "/dashboard/stress" },
	},
	{
		id: "backtesting",
		kicker: "Research",
		title: "Backtesting through every market since 2008",
		what:
			"Run the strategy templates through history, rebalanced monthly, quarterly or yearly, with trading costs, turnover and drawdowns, against the Safe Rate indices.",
		how: [
			"On each rebalance date the template is rebuilt from that day's priced universe, at the book's own value, and the book trades to it: no look-ahead, no securities that did not exist yet.",
			"Self-financing: after the first purchase no money comes in. A rebuild that would cost more than the cash on hand is scaled down, and any shortfall is reported, so a leak is loud.",
			"Positions are held while they sit in a rung of the template and sold when they leave its range; maturities, coupons and sales buy the rungs that are short.",
			"Every trade crosses a spread you set, in 32nds. Between rebalances the book is valued by the same ledger that values a tracked portfolio, so a backtest and a real portfolio cannot disagree about what a position earned.",
		],
		page: { label: "Strategy Backtests", to: "/dashboard/backtest" },
	},
	{
		id: "attribution",
		kicker: "Performance",
		title: "Returns and attribution that add up",
		what:
			"Time-weighted and money-weighted returns, FIFO lots and realized gains, and every day's return split into carry, roll-down, the curve's level, slope and curvature, and selection.",
		how: [
			"Each security's value is walked from start to end price through exact repricings of its real cashflows, so the pieces sum to what happened with nothing to reconcile.",
			"The curve move is split by exact repricing into Diebold-Li level, slope and curvature on fixed loadings, not on the fitted curve's own parameters, which can swing by 150bp in a day while offsetting each other.",
			"Attribution runs daily on the book's own holdings and the days are linked (Carino), so a month or a year adds up across trades and cashflows.",
		],
		references: "Bolder (2015); Diebold and Li (2006); Carino (1999).",
		page: { label: "Portfolio Tracking", to: "/dashboard/portfolios" },
	},
	{
		id: "execution",
		kicker: "Orders",
		title: "From plan to order sheet",
		what:
			"Turn a plan into orders with limit prices, split between what TreasuryDirect can fill at auction and what goes to the secondary market, ready for any broker or custodian.",
		how: [
			"One BUY per position, limited at the plan's clean price, in the lot rules you chose, with the TreasuryDirect alternative alongside: the same term at its next auction, flagged where it would exceed TreasuryDirect's $10 million limit.",
			"Downloads as a CSV in common blotter columns, so it opens in a spreadsheet or maps onto a broker's basket upload; or track the plan as a portfolio. Safe Rate does not place or route orders: you submit them yourself, to your broker or TreasuryDirect.",
		],
		page: { label: "Order Sheets", to: "/dashboard/execution" },
	},
	{
		id: "analytics",
		kicker: "Market analytics",
		title: "Fitted curves and relative value",
		what:
			"Nominal, real, breakeven and money-market curves fitted every business day, every security's analytics, and rich/cheap ranked by how unusual each security's distance from the curve is.",
		how: [
			"The nominal curve is a Nelson-Siegel-Svensson fit to every note and bond's end-of-day price, published with its fit error in basis points and cents.",
			"Rich/cheap ranks on a z-score of each security's residual against its own history, not on the size of the residual, so a bond that always trades a little cheap does not crowd out one that has just moved.",
		],
		page: { label: "Curves", to: "/dashboard/curves" },
	},
];

export default function Capabilities() {
	return (
		<main className="mx-auto max-w-6xl px-6 py-16">
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				Capabilities
			</p>
			<h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-neutral-900">
				What it does, and how we built it.
			</h1>
			<p className="mt-4 max-w-3xl text-lg leading-relaxed text-slate-600">
				The tools a Treasury portfolio manager needs, built on published methods and
				explained here plainly: what each one does, how it is implemented, and what
				it reports when the answer is uncertain.
			</p>
			<nav className="mt-8 flex flex-wrap gap-2 text-sm">
				{CAPABILITIES.map((c) => (
					<a
						className="rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-700 hover:border-primary/40 hover:text-primary"
						href={`#${c.id}`}
						key={c.id}
					>
						{c.title.split(":")[0]}
					</a>
				))}
			</nav>

			<div className="mt-12 space-y-8">
				{CAPABILITIES.map((c) => (
					<section
						className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-8"
						id={c.id}
						key={c.id}
					>
						<p className="text-[11px] font-bold uppercase tracking-[0.16em] text-primary">
							{c.kicker}
						</p>
						<h2 className="mt-2 text-xl font-semibold tracking-tight text-neutral-900 md:text-2xl">
							{c.title}
						</h2>
						<p className="mt-3 max-w-3xl leading-relaxed text-slate-700">{c.what}</p>
						<h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500">
							How we implement it
						</h3>
						<ul className="mt-2 space-y-2">
							{c.how.map((line) => (
								<li
									className="flex gap-3 text-sm leading-relaxed text-slate-700"
									key={line}
								>
									<span
										aria-hidden="true"
										className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60"
									/>
									<span>{line}</span>
								</li>
							))}
						</ul>
						<div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 text-sm">
							{c.references ? (
								<p className="text-xs text-slate-500">
									<span className="font-semibold text-slate-600">References.</span>{" "}
									{c.references}
								</p>
							) : (
								<span />
							)}
							{c.page ? (
								<a
									className="font-semibold text-primary underline underline-offset-4"
									href={c.page.to}
								>
									{c.page.label} in the dashboard
								</a>
							) : null}
						</div>
					</section>
				))}
			</div>

			<section className="mt-12 rounded-2xl bg-slate-950 p-8 text-slate-100">
				<h2 className="text-2xl font-semibold tracking-tight text-white">
					See it on your own portfolio
				</h2>
				<p className="mt-2 max-w-3xl text-slate-300">
					Tour the live demo with sample portfolios, a liability stream and a plan;
					it needs just your email, no payment or credit card. The market data behind
					them (curves, securities, analytics, auctions and indices) is also
					available over the REST API and to AI agents over MCP.
				</p>
				<div className="mt-5 flex flex-wrap gap-3">
					<a
						className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-100"
						href="/sign-in"
					>
						Tour the live demo
					</a>
					<a
						className="rounded-full border border-slate-600 px-5 py-2 text-sm font-semibold text-white hover:border-slate-400"
						href="/docs"
					>
						API and MCP docs
					</a>
				</div>
			</section>
		</main>
	);
}
