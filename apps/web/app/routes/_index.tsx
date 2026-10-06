import { readPricesOn } from "@markets/mcp-tools";
import {
	FREE_TIER,
	PLANS,
	PRODUCT_NAME,
	SITE_HOSTS,
	TRIAL,
} from "@markets/schema";
import {
	getCurvesWithPriorOn,
	getDebtSummaryOn,
	getLatestCurve,
} from "@saferate/treasury-client/client";
import { TREASURY_COVERAGE_START } from "@saferate/treasury-client/types";
import type { Route } from "./+types/_index";

const TITLE = `Portfolio management for U.S. Treasuries | ${PRODUCT_NAME}`;
const DESCRIPTION =
	"Institutional-grade tools to track, build, stress-test, backtest and trade U.S. Treasury portfolios, on every Treasury priced daily since September 2008, from primary sources with no data license to pay for. With a REST API and an MCP server.";

export const meta: Route.MetaFunction = () => [
	{ title: TITLE },
	{ name: "description", content: DESCRIPTION },
	{ property: "og:title", content: TITLE },
	{ property: "og:description", content: DESCRIPTION },
	{ property: "og:url", content: `${SITE_HOSTS.production.web}/` },
];

/**
 * The landing page, with the market ON it: the day's fitted par curve, key
 * yields with their change, and how much is priced and outstanding, read
 * live from the treasury service. Every read is optional: a failed one drops
 * its figure, never the page.
 *
 * Claims kept to what is true and checkable (2026-10-01). "The world's
 * largest government bond market", not "largest asset class" (equities and
 * real estate are larger). "A fraction of what terminals and data feeds
 * cost", not "more cheaply than anyone", which nobody can substantiate.
 * Provenance in saferate.com's wording: free primary sources, never "public
 * domain" (an unchecked copyright claim). Plan prices come from
 * @markets/schema, coverage from TREASURY_COVERAGE_START.
 */
const KEY_TENORS = [2, 5, 10, 30] as const;

export const loader = async ({ context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	try {
		const latest = await getLatestCurve({ env });
		if (latest === null) return { live: null };
		const [withPrior, priced, debt] = await Promise.all([
			getCurvesWithPriorOn({ env, date: latest.date }).catch(() => null),
			readPricesOn(env, latest.date).catch(() => []),
			getDebtSummaryOn({ env, on: latest.date }).catch(() => null),
		]);
		const prior = new Map(
			(withPrior?.priorCurves?.zero ?? []).map((p) => [p.tenorYears, p.parYield]),
		);
		return {
			live: {
				date: latest.date,
				curve: latest.points.map((p) => ({
					tenor: p.tenorYears,
					rate: p.parYield,
				})),
				keys: KEY_TENORS.map((tenor) => {
					const now =
						latest.points.find((p) => p.tenorYears === tenor)?.parYield ?? null;
					const before = prior.get(tenor) ?? null;
					return {
						tenor,
						rate: now,
						changeBp: now === null || before === null ? null : (now - before) * 100,
					};
				}),
				securities: priced.length,
				marketable: debt?.marketableTotal?.total ?? null,
				recordDate: debt?.recordDate ?? null,
			},
		};
	} catch {
		return { live: null };
	}
};

const coverage = new Date(
	`${TREASURY_COVERAGE_START}T00:00:00Z`,
).toLocaleDateString("en-US", {
	month: "long",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});
const shortDate = (iso: string) =>
	new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
/** The debt summary is in dollars (checked against the ~$31.8T on the 2026-08 statement). */
const trillions = (dollars: number) =>
	`$${(dollars / 1e12).toFixed(1)} trillion`;

type TLive = NonNullable<Route.ComponentProps["loaderData"]["live"]>;

/** The par curve as a filled line, tenors on a square-root scale so the front end shows. */
const HeroCurve = ({ curve }: { curve: TLive["curve"] }) => {
	const W = 560;
	const H = 220;
	const pad = { l: 40, r: 16, t: 16, b: 28 };
	const rates = curve.map((p) => p.rate);
	const lo = Math.floor((Math.min(...rates) - 0.15) * 4) / 4;
	const hi = Math.ceil((Math.max(...rates) + 0.15) * 4) / 4;
	const maxT = Math.sqrt(Math.max(...curve.map((p) => p.tenor)));
	const x = (t: number) => pad.l + (Math.sqrt(t) / maxT) * (W - pad.l - pad.r);
	const y = (r: number) =>
		pad.t + (1 - (r - lo) / (hi - lo)) * (H - pad.t - pad.b);
	const line = curve
		.map(
			(p, i) =>
				`${i === 0 ? "M" : "L"}${x(p.tenor).toFixed(1)},${y(p.rate).toFixed(1)}`,
		)
		.join(" ");
	const area = `${line} L${x(curve.at(-1)?.tenor ?? 30).toFixed(1)},${H - pad.b} L${x(curve[0].tenor).toFixed(1)},${H - pad.b} Z`;
	const ticks = [lo, (lo + hi) / 2, hi];
	return (
		<svg
			aria-label="Treasury par yield curve"
			className="h-auto w-full"
			role="img"
			viewBox={`0 0 ${W} ${H}`}
		>
			<defs>
				<linearGradient id="curveFill" x1="0" x2="0" y1="0" y2="1">
					<stop offset="0%" stopColor="rgb(56 189 248)" stopOpacity="0.35" />
					<stop offset="100%" stopColor="rgb(56 189 248)" stopOpacity="0" />
				</linearGradient>
			</defs>
			{ticks.map((t) => (
				<g key={t}>
					<line
						stroke="rgb(51 65 85)"
						strokeDasharray="2 4"
						x1={pad.l}
						x2={W - pad.r}
						y1={y(t)}
						y2={y(t)}
					/>
					<text
						fill="rgb(148 163 184)"
						fontSize="11"
						textAnchor="end"
						x={pad.l - 6}
						y={y(t) + 4}
					>
						{t.toFixed(2)}%
					</text>
				</g>
			))}
			<path d={area} fill="url(#curveFill)" />
			<path
				d={line}
				fill="none"
				stroke="rgb(56 189 248)"
				strokeLinejoin="round"
				strokeWidth="2.5"
			/>
			{curve.map((p) => (
				<g key={p.tenor}>
					<circle
						cx={x(p.tenor)}
						cy={y(p.rate)}
						fill="rgb(15 23 42)"
						r="3.5"
						stroke="rgb(125 211 252)"
						strokeWidth="1.5"
					/>
					{[1, 2, 5, 10, 20, 30].includes(p.tenor) ? (
						<text
							fill="rgb(148 163 184)"
							fontSize="11"
							textAnchor="middle"
							x={x(p.tenor)}
							y={H - 8}
						>
							{p.tenor}Y
						</text>
					) : null}
				</g>
			))}
		</svg>
	);
};

const LiveCard = ({ live }: { live: TLive }) => (
	<div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 p-5 text-slate-100 shadow-2xl shadow-sky-900/20">
		<div className="flex items-center justify-between text-xs">
			<span className="flex items-center gap-2 font-semibold uppercase tracking-[0.14em] text-sky-300">
				<span className="relative flex h-2 w-2">
					<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
					<span className="relative inline-flex h-2 w-2 rounded-full bg-sky-400" />
				</span>
				U.S. Treasury par curve
			</span>
			<span className="text-slate-400">Close of {shortDate(live.date)}</span>
		</div>
		<div className="mt-3">
			<HeroCurve curve={live.curve} />
		</div>
		<div className="mt-2 grid grid-cols-4 gap-2">
			{live.keys.map((k) => (
				<div className="rounded-lg bg-slate-900 px-3 py-2" key={k.tenor}>
					<p className="text-[11px] text-slate-400">{k.tenor}-year</p>
					<p className="tabular text-lg font-semibold">
						{k.rate === null ? "—" : `${k.rate.toFixed(2)}%`}
					</p>
					<p
						className={`tabular text-[11px] ${k.changeBp === null ? "text-slate-500" : k.changeBp > 0 ? "text-rose-300" : k.changeBp < 0 ? "text-emerald-300" : "text-slate-400"}`}
					>
						{k.changeBp === null
							? "—"
							: `${k.changeBp > 0 ? "+" : k.changeBp < 0 ? "−" : ""}${Math.abs(k.changeBp).toFixed(1)} bp`}
					</p>
				</div>
			))}
		</div>
		<p className="mt-3 text-[11px] leading-relaxed text-slate-500">
			Fitted by Safe Rate to the end-of-day price of every Treasury note and bond
			{live.securities > 0
				? `; ${live.securities.toLocaleString("en-US")} securities priced that day`
				: ""}
			.
		</p>
	</div>
);

const ICONS: Record<string, string> = {
	track: "M3 17l6-6 4 4 8-8M14 7h7v7",
	build: "M4 20h16M6 16V9m4 7V5m4 11v-6m4 6V8",
	risk: "M12 3l8 4v5c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V7l8-4z",
	backtest: "M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2",
	trade: "M7 7h13l-3-3m3 13H4l3 3",
	market: "M4 19V5m0 14h16M8 15l3-4 3 2 5-6",
	api: "M8 9l-4 3 4 3m8-6l4 3-4 3M13 6l-2 12",
};
const Icon = ({ name }: { name: string }) => (
	<svg
		aria-hidden="true"
		className="h-5 w-5"
		fill="none"
		stroke="currentColor"
		strokeLinecap="round"
		strokeLinejoin="round"
		strokeWidth="1.8"
		viewBox="0 0 24 24"
	>
		<path d={ICONS[name]} />
	</svg>
);

const SUITE = [
	{
		icon: "track",
		title: "Portfolio tracking",
		body:
			"Trades by hand or from a broker blotter. Value, income, time- and money-weighted returns against a Safe Rate index, FIFO lots, and attribution to carry, roll-down, the curve's level, slope and curvature, and selection.",
	},
	{
		icon: "build",
		title: "Portfolio construction",
		body:
			"Fund liabilities by cash-flow matching, immunization or horizon matching; track an index; or start from a ladder, barbell, bullet or bill roll, with lot sizes for retail, Apex, TreasuryDirect or institutional blocks.",
	},
	{
		icon: "risk",
		title: "Risk and stress testing",
		body:
			"Key-rate DV01, standard and custom curve shocks, replays of past market events, value at risk and expected shortfall from filtered historical simulation with extreme-value tails, and fat-tail diagnostics.",
	},
	{
		icon: "backtest",
		title: "Backtesting",
		body:
			"Run the strategy templates through every market since 2008, rebalanced monthly to yearly, with trading costs, turnover and drawdowns, against the Safe Rate indices.",
	},
	{
		icon: "trade",
		title: "Trade execution",
		body:
			"Turn a plan into an order sheet with limit prices, split between what TreasuryDirect can fill at auction and what goes to the secondary market, ready for your broker.",
	},
	{
		icon: "market",
		title: "Market analytics",
		body:
			"Security lookup; nominal, real, breakeven and money-market curves; auctions and who bought them; on-the-run premiums; rich/cheap to the curve; eleven total-return indices.",
	},
];

const INSTITUTIONAL = [
	"Exact-repricing return attribution, linked across days",
	"Liability-driven construction: cash-flow matching and immunization",
	"Key-rate durations on twelve tenors, for every security and index",
	"Value at risk and expected shortfall, with extreme-value tails",
	"TIPS on real duration and index ratios; floaters on spread duration",
	"Total-return indices with constituents, float par and analytics by basis",
];

export default function Home({ loaderData }: Route.ComponentProps) {
	const { live } = loaderData;
	const api = SITE_HOSTS.production.api;
	return (
		<main>
			{/* ── Hero ─────────────────────────────────────────────────────── */}
			<section className="relative overflow-hidden border-b border-slate-200 bg-gradient-to-b from-sky-50/70 via-white to-white">
				<div
					aria-hidden="true"
					className="pointer-events-none absolute -right-40 -top-40 h-[28rem] w-[28rem] rounded-full bg-sky-200/40 blur-3xl"
				/>
				<div className="relative mx-auto grid grid-cols-1 max-w-6xl items-center gap-12 px-6 py-16 md:py-24 lg:grid-cols-[1.05fr_1fr]">
					<div>
						<h1 className="text-4xl font-semibold leading-[1.05] tracking-tight text-neutral-900 md:text-[3.4rem]">
							The full suite for your Treasury portfolio.
						</h1>
						<p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
							Institutional-grade tools for the world's largest government bond market:
							track, build, stress-test, backtest and trade, on every Treasury priced
							daily since {coverage}. Built on free primary sources, so there are no
							data licenses to pay for, at a fraction of what terminals and data feeds
							cost.
						</p>
						<div className="mt-8 flex flex-wrap items-center gap-3">
							<a
								className="rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition hover:-translate-y-0.5 hover:bg-primary/90"
								href="/sign-in"
							>
								Start a free {TRIAL.days}-day trial
							</a>
							<a
								className="rounded-full border border-slate-300 bg-white px-6 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-primary/40 hover:text-primary"
								href="/docs"
							>
								API and MCP docs
							</a>
						</div>
						<p className="mt-3 text-sm text-slate-500">
							{TRIAL.days} days of Team, starting with a tour of the live demo, with
							just your email.{" "}
							<span className="font-medium text-slate-700">
								No payment or credit card required.
							</span>
						</p>
					</div>
					{live ? <LiveCard live={live} /> : null}
				</div>
			</section>

			{/* ── Numbers ─────────────────────────────────────────────────── */}
			<section className="border-b border-slate-200 bg-white">
				<div className="mx-auto grid max-w-6xl grid-cols-2 gap-px bg-slate-200 md:grid-cols-4">
					{[
						["Daily since", coverage],
						[
							"Priced every business day",
							live && live.securities > 0
								? `${live.securities.toLocaleString("en-US")} securities`
								: "Every Treasury",
						],
						[
							live?.recordDate
								? `Marketable debt, ${shortDate(live.recordDate)}`
								: "Marketable debt",
							live?.marketable ? trillions(live.marketable) : "The whole market",
						],
						["Data license fees", "$0"],
					].map(([label, value]) => (
						<div className="bg-white px-6 py-6" key={label}>
							<p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
							<p className="tabular mt-1 text-2xl font-semibold text-neutral-900">
								{value}
							</p>
						</div>
					))}
				</div>
			</section>

			<div className="mx-auto max-w-6xl px-6">
				{/* ── Suite ───────────────────────────────────────────────── */}
				<section className="py-20">
					<h2 className="text-3xl font-semibold tracking-tight text-neutral-900">
						Every step of managing a Treasury portfolio
					</h2>
					<p className="mt-3 max-w-2xl text-slate-600">
						From the first trade to the order sheet, on one set of numbers.
					</p>
					<div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
						{SUITE.map((item) => (
							<div
								className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
								key={item.title}
							>
								<span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
									<Icon name={item.icon} />
								</span>
								<h3 className="mt-4 font-semibold text-neutral-900">{item.title}</h3>
								<p className="mt-2 text-sm leading-relaxed text-slate-600">
									{item.body}
								</p>
							</div>
						))}
					</div>
				</section>

				{/* ── Institutional, and the data ────────────────────────── */}
				<section className="grid grid-cols-1 gap-10 border-t border-slate-200 py-20 lg:grid-cols-2">
					<div>
						<h2 className="text-3xl font-semibold tracking-tight text-neutral-900">
							Institutional-grade, without the data bill
						</h2>
						<ul className="mt-6 space-y-3">
							{INSTITUTIONAL.map((line) => (
								<li className="flex gap-3 text-sm text-slate-700" key={line}>
									<svg
										aria-hidden="true"
										className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
										fill="none"
										stroke="currentColor"
										strokeWidth="2.5"
										viewBox="0 0 24 24"
									>
										<path
											d="M5 12l5 5L20 7"
											strokeLinecap="round"
											strokeLinejoin="round"
										/>
									</svg>
									{line}
								</li>
							))}
						</ul>
					</div>
					<div className="rounded-2xl border border-slate-200 bg-slate-50 p-6">
						<h3 className="font-semibold text-neutral-900">
							The whole market, from primary sources
						</h3>
						<p className="mt-3 text-sm leading-relaxed text-slate-600">
							Every input is a primary source, published by its issuer and free to
							anyone. Prices come from the end-of-day file Treasury publishes daily
							through TreasuryDirect, the statutory prices federal agencies use to
							value the securities they hold. Amounts outstanding come from the Monthly
							Statement of the Public Debt, auction results and buybacks from
							Treasury's Fiscal Data, and Federal Reserve holdings from the New York
							Fed. No evaluated pricing service, no vendor marks and no licensed data,
							so anyone can rebuild every number.
						</p>
						<p className="mt-3 text-xs leading-relaxed text-slate-500">
							What that leaves is a timing difference rather than a data one:
							Treasury's mark is struck near 3:30 PM, where much of the industry has
							marked at 4:00 PM since 2021. Safe Rate's indices and analytics are its
							own construction, not official U.S. Treasury statistics.
						</p>
					</div>
				</section>

				{/* ── API and MCP ─────────────────────────────────────────── */}
				<section className="grid grid-cols-1 items-center gap-10 border-t border-slate-200 py-20 lg:grid-cols-[1fr_1.1fr]">
					<div>
						<p className="text-[11px] font-bold uppercase tracking-[0.16em] text-primary">
							Integrate
						</p>
						<h2 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900">
							An API for your systems, MCP for your AI agents
						</h2>
						<p className="mt-4 text-slate-600">
							Curves, securities, analytics, rich/cheap, auctions and indices over a
							REST API with a published OpenAPI reference, and the same tools over an
							MCP server, so Claude and other agents read the numbers your dashboard
							shows. One key for both.
						</p>
						<a
							className="mt-6 inline-block text-sm font-semibold text-primary underline underline-offset-4"
							href="/docs"
						>
							Read the docs
						</a>
					</div>
					<div className="space-y-4">
						<pre className="overflow-x-auto rounded-2xl bg-slate-950 p-5 text-[13px] leading-relaxed text-slate-200 shadow-xl">
							<code>
								<span className="text-slate-500"># The day's fitted zero curve</span>
								{"\n"}curl {api}/v1/curves/zero \{"\n"}
								{"  "}-H{" "}
								<span className="text-emerald-300">
									"Authorization: Bearer $SAFERATE_MARKETS_KEY"
								</span>
							</code>
						</pre>
						<pre className="overflow-x-auto rounded-2xl bg-slate-950 p-5 text-[13px] leading-relaxed text-slate-200 shadow-xl">
							<code>
								<span className="text-slate-500">
									# Give Claude the whole Treasury market
								</span>
								{"\n"}claude mcp add --transport http saferate-markets {api}/mcp \{"\n"}
								{"  "}--header{" "}
								<span className="text-emerald-300">
									"Authorization: Bearer $SAFERATE_MARKETS_KEY"
								</span>
							</code>
						</pre>
					</div>
				</section>

				{/* ── Plans ───────────────────────────────────────────────── */}
				<section className="border-t border-slate-200 py-20">
					<h2 className="text-3xl font-semibold tracking-tight text-neutral-900">
						Plans
					</h2>
					<p className="mt-3 max-w-2xl text-slate-600">
						Every new account gets {TRIAL.days} days of Team, free, with no card.
						After that, stay free while your Treasuries are worth under $
						{FREE_TIER.maxValueUsd.toLocaleString("en-US")}. Paid plans add the REST
						API and MCP, and differ in limits and in who may use them.
					</p>
					<div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
						<div className="rounded-2xl border border-primary/30 bg-white p-6 shadow-sm">
							<h3 className="font-semibold text-neutral-900">{FREE_TIER.name}</h3>
							<p className="mt-1 text-sm text-slate-600">{FREE_TIER.summary}</p>
							<p className="mt-4 text-2xl font-semibold text-neutral-900">
								$0
								<span className="text-sm font-normal text-slate-500">/month</span>
							</p>
						</div>
						{PLANS.map((plan) => (
							<div
								className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
								key={plan.id}
							>
								<h3 className="font-semibold text-neutral-900">{plan.name}</h3>
								<p className="mt-1 text-sm text-slate-600">{plan.summary}</p>
								<p className="mt-4 text-2xl font-semibold text-neutral-900">
									{plan.sale.kind === "checkout"
										? `$${plan.sale.priceUsdMonthly}`
										: "Custom"}
									{plan.sale.kind === "checkout" ? (
										<span className="text-sm font-normal text-slate-500">/month</span>
									) : null}
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
			</div>

			{/* ── Closing call ─────────────────────────────────────────────── */}
			<section className="bg-slate-950">
				<div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-6 py-14 md:flex-row md:items-center">
					<div>
						<h2 className="text-2xl font-semibold tracking-tight text-white">
							See it on today's market.
						</h2>
						<p className="mt-2 text-slate-400">
							Sample portfolios, a liability stream and a plan, live, then {TRIAL.days}{" "}
							days of Team on your own. No payment or credit card required.
						</p>
					</div>
					<a
						className="rounded-full bg-white px-6 py-2.5 text-sm font-semibold text-slate-950 transition hover:-translate-y-0.5 hover:bg-sky-100"
						href="/sign-in"
					>
						Start a free trial
					</a>
				</div>
			</section>
		</main>
	);
}
