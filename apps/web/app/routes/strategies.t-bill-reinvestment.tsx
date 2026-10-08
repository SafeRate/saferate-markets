import { PRODUCT_NAME, SITE_HOSTS, TRIAL } from "@markets/schema";
import { useState } from "react";
import { Form, Link } from "react-router";
import { JsonLd } from "@/components/JsonLd";
import { StrategyDisclaimer } from "@/components/StrategyDisclaimer";
import { StepChart } from "@/components/StepChart";
import { breadcrumbJsonLd, ORGANIZATION_REF } from "@/lib/jsonLd";
import { money, rate } from "@/lib/format";
import {
	loadBillReinvestment,
	type TBillReinvestment,
} from "@/services/billReinvestment.server";
import type { Route } from "./+types/strategies.t-bill-reinvestment";

const PATH = "/strategies/t-bill-reinvestment";
const TITLE = "T-Bill Reinvestment: Roll or Lock In a Year?";
const DEFAULT_AMOUNT = 10_000;

export const meta: Route.MetaFunction = () => [
	{ title: `${TITLE} | ${PRODUCT_NAME}` },
	{
		name: "description",
		content:
			"Should you keep rolling short Treasury bills or lock in a 52-week bill? What the bill market is pricing for 3-month rates over the next year, the rate rolling needs to catch up, and who comes out ahead if rates rise, stay flat or fall. Updated every business day.",
	},
];

/** $100 to $10 million, as TreasuryDirect sells bills in $100 steps. */
const amountFrom = (raw: string | null) => {
	const value = Number((raw ?? "").replace(/[,$\s]/g, ""));
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_AMOUNT;
	return Math.min(10_000_000, Math.max(100, Math.round(value)));
};

/**
 * T-bill reinvestment, the question people meet when a bill matures: roll it,
 * or lock in a year? Answered with today's bill curve and its implied forward
 * rates, never a forecast (services/billReinvestment.server.ts). No historical
 * performance figure appears; every number is today's curve or a stated
 * what-if on it. The amount lives in the query string and the canonical stays
 * on the bare path.
 */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const amount = amountFrom(new URL(request.url).searchParams.get("amount"));
	try {
		return {
			amount,
			bills: await loadBillReinvestment(context.cloudflare.env, amount),
		};
	} catch (error) {
		console.error("[t-bill-reinvestment] could not read the bill curve:", error);
		return { amount, bills: null };
	}
};

const longDate = (iso: string) =>
	new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});

const Section = ({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) => (
	<section className="mt-12">
		<h2 className="text-xl font-semibold tracking-tight text-neutral-900">
			{title}
		</h2>
		{children}
	</section>
);

const th = "px-4 py-2 font-semibold";
const td = "px-4 py-2 text-right tabular-nums";

const monthYear = (iso: string) =>
	new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});

/**
 * The page's answer, in the order a reader asks it: which way the market is
 * pricing rates, what that means for rolling against locking in, and who wins
 * otherwise. The direction is computed from the day's curve (`directionOf`),
 * so the sentence stays true when the curve flips.
 */
const Answer = ({ bills }: { bills: TBillReinvestment }) => {
	const thirteen = bills.terms.find((t) => t.key === "13w");
	const flat = thirteen?.outcomes.find((o) => o.key === "flat");
	const later = bills.pricedLater;
	if (!thirteen || !flat || !later) return null;
	const gap = bills.yearIncome - flat.income;
	const pricing =
		bills.direction === "stay about the same"
			? `The bill market is pricing 3-month rates to stay about where they are, near ${rate(thirteen.todayRate, 2)}, through ${monthYear(later.date)}.`
			: `The bill market is pricing 3-month rates to ${bills.direction} from ${rate(thirteen.todayRate, 2)} today to about ${rate(later.rate, 2)} by ${monthYear(later.date)}.`;
	return (
		<div className="mt-5 max-w-3xl space-y-3 text-lg leading-relaxed text-slate-700">
			<p>
				{pricing} If that happens, rolling 13-week bills and locking in today's
				52-week bill at {rate(bills.yearRate, 2)} earn the same over the year.
			</p>
			<p>
				Locking in earns more if rates come in below that path: if they stay where
				they are, the 52-week bill earns {money(Math.abs(gap))}{" "}
				{gap >= 0 ? "more" : "less"} on {money(bills.amount)}. Rolling earns more
				only if rates climb faster than the market prices.
			</p>
		</div>
	);
};

/** A return for the year, with the interest in dollars after it. */
const ReturnCell = ({
	income,
	percent,
}: {
	income: number;
	percent: number;
}) => (
	<>
		{percent.toFixed(2)}%{" "}
		<span className="text-xs text-slate-500">({money(income)})</span>
	</>
);

/** The Builder's bill-roll template, filled in, after sign-in. */
const trackLink = (amount: number) =>
	`/sign-in?next=${encodeURIComponent(`/dashboard/builder?mode=strategy&strategy=billRoll&budget=${Math.max(amount, 1000)}`)}`;

const winnerOf = (roll: number, hold: number) =>
	Math.abs(roll - hold) < 1 ? "Same" : roll > hold ? "Rolling" : "52-week bill";

const shortDate = (iso: string) =>
	new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});

/**
 * One tab per way of holding cash for the year: roll 4-, 13- or 26-week bills,
 * or hold the 52-week bill. Each shows the bills it buys as steps (the x axis
 * is the purchase dates), the rate priced in for each, and who comes out
 * ahead in each case. The 13-week tab is the server-rendered default, so the
 * page reads completely without script.
 */
const TermTabs = ({ bills }: { bills: TBillReinvestment }) => {
	const [selected, setSelected] = useState("13w");
	const term = bills.terms.find((t) => t.key === selected) ?? bills.terms[0];
	const isHeld = term.key === "52w";
	const first = term.schedule[0];
	const last = term.schedule.at(-1) ?? first;
	return (
		<div className="mt-4">
			<div
				aria-label="How the cash is held"
				className="flex flex-wrap gap-2"
				role="tablist"
			>
				{bills.terms.map((t) => (
					<button
						aria-controls="term-panel"
						aria-selected={t.key === term.key}
						className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors ${
							t.key === term.key
								? "border-primary bg-primary text-primary-foreground"
								: "border-slate-300 text-slate-700 hover:border-primary/50"
						}`}
						key={t.key}
						onClick={() => setSelected(t.key)}
						role="tab"
						type="button"
					>
						{t.key === "52w" ? "Hold 52-week" : `Roll ${t.label}`}
					</button>
				))}
			</div>
			<div className="mt-4" id="term-panel" role="tabpanel">
				<p className="max-w-3xl text-slate-700">
					{isHeld
						? `One bill, bought today at ${rate(term.todayRate, 2)} and held for the year. Nothing is reinvested, so the rate is fixed whatever happens.`
						: `${term.rolls} bills over the year, each held until it matures and then rolled into the next. The first is bought today at ${rate(first.rate, 2)}; the market prices the last, bought around ${shortDate(last.date)}, at ${rate(last.rate, 2)}.`}
				</p>
				<div className="mt-4 max-w-4xl rounded-xl border border-slate-200 bg-white p-4">
					<StepChart
						format={(v) => `${v.toFixed(2)}%`}
						reference={{
							rate: bills.yearRate,
							label: `52-week bill locked in today, ${rate(bills.yearRate, 2)}`,
						}}
						steps={term.schedule.map((s, i) => ({
							startYears: s.startYears,
							endYears: s.endYears,
							rate: s.rate,
							label: i === 0 ? "Today" : shortDate(s.date),
						}))}
					/>
				</div>
				{isHeld ? null : (
					<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
						<table className="w-full min-w-[36rem] border-collapse text-sm">
							<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
								<tr>
									<th className={th}>Over the next year</th>
									<th className={`${th} text-right`}>Roll {term.label}</th>
									<th className={`${th} text-right`}>Lock in 52-week</th>
									<th className={`${th} text-right`}>Earns more</th>
								</tr>
							</thead>
							<tbody>
								{bills.scenarios.map((s) => {
									const roll = term.outcomes.find((o) => o.key === s.key);
									if (!roll) return null;
									return (
										<tr className="border-t border-slate-100" key={s.key}>
											<td className="px-4 py-2 text-neutral-900">{s.label}</td>
											<td className={td}>
												<ReturnCell income={roll.income} percent={roll.returnPercent} />
											</td>
											<td className={td}>
												<ReturnCell
													income={bills.yearIncome}
													percent={bills.yearReturnPercent}
												/>
											</td>
											<td className={`${td} font-medium text-neutral-900`}>
												{winnerOf(roll.income, bills.yearIncome)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
				<details className="mt-3 max-w-3xl text-sm text-slate-600">
					<summary className="cursor-pointer font-medium text-slate-700">
						Each purchase and the rate priced in
					</summary>
					<ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
						{term.schedule.map((s, i) => (
							<li className="tabular-nums" key={s.date}>
								{i === 0 ? "Today" : shortDate(s.date)}: {rate(s.rate, 2)}
							</li>
						))}
					</ul>
				</details>
				<Link
					className="mt-4 inline-block rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
					to={trackLink(bills.amount)}
				>
					Track a bill roll
				</Link>
				<p className="mt-3 max-w-3xl text-xs text-slate-500">
					Return for the year on {money(bills.amount)}, with the interest in
					brackets, every maturing bill reinvested in full, before taxes. The return
					is the interest divided by the amount, so it sits slightly above the quoted
					investment rate, which is stated with semiannual compounding. Treasury bill
					interest is exempt from state and local income tax. Rates priced in are
					what today's bill prices imply, not a forecast by Safe Rate.¹
				</p>
			</div>
		</div>
	);
};

export default function TBillReinvestmentPage({
	loaderData,
}: Route.ComponentProps) {
	const { bills, amount } = loaderData;
	const web = SITE_HOSTS.production.web;
	return (
		<main className="mx-auto max-w-6xl px-6 py-16">
			<JsonLd
				data={{
					"@context": "https://schema.org",
					"@type": "WebPage",
					"@id": `${web}${PATH}#page`,
					url: `${web}${PATH}`,
					name: TITLE,
					...(bills ? { dateModified: bills.asOf } : {}),
					publisher: ORGANIZATION_REF,
					isPartOf: {
						"@type": "WebSite",
						"@id": `${web}/#website`,
						name: PRODUCT_NAME,
					},
				}}
			/>
			<JsonLd
				data={breadcrumbJsonLd([
					{ name: PRODUCT_NAME, path: "/" },
					{ name: "Strategies", path: "/strategies" },
					{ name: "T-Bill Reinvestment", path: PATH },
				])}
			/>
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				Strategy
			</p>
			<h1 className="mt-3 text-4xl font-semibold tracking-tight text-neutral-900">
				{TITLE}
				{bills ? ` (${longDate(bills.asOf)})` : ""}
			</h1>
			{bills ? (
				<Answer bills={bills} />
			) : (
				<p className="mt-5 max-w-3xl text-lg text-slate-600">
					Today's bill curve could not be read just now. Try again shortly.
				</p>
			)}
			<StrategyDisclaimer
				trackLabel="Track a bill roll"
				trackTo={trackLink(amount)}
			/>

			{bills ? (
				<>
					<Section title="Roll or lock in, one bill at a time">
						<TermTabs bills={bills} />
						<Form className="mt-6 flex flex-wrap items-end gap-3" method="get">
							<label className="text-sm text-slate-700" htmlFor="amount">
								Amount
								<input
									className="mt-1 block w-40 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
									defaultValue={amount === DEFAULT_AMOUNT ? "" : String(amount)}
									id="amount"
									inputMode="numeric"
									name="amount"
									placeholder={DEFAULT_AMOUNT.toLocaleString("en-US")}
								/>
							</label>
							<button
								className="rounded-full border border-primary px-4 py-1.5 text-sm font-semibold text-primary hover:bg-primary/5"
								type="submit"
							>
								Recalculate
							</button>
							<span className="text-xs text-slate-500">$100 to $10,000,000.</span>
						</Form>
					</Section>

					<Section title="The rate rolling needs to catch up">
						<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
							<table className="w-full min-w-[36rem] border-collapse text-sm">
								<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
									<tr>
										<th className={th}>Keep rolling</th>
										<th className={`${th} text-right`}>Rate today</th>
										<th className={`${th} text-right`}>Later bills need to average</th>
									</tr>
								</thead>
								<tbody>
									{bills.terms
										.filter((t) => t.breakeven !== null)
										.map((t) => (
											<tr className="border-t border-slate-100" key={t.key}>
												<td className="px-4 py-2 text-neutral-900">{t.label} bills</td>
												<td className={td}>{rate(t.todayRate, 2)}</td>
												<td className={td}>{rate(t.breakeven, 2)}</td>
											</tr>
										))}
								</tbody>
							</table>
						</div>
						<p className="mt-2 max-w-3xl text-sm text-slate-600">
							To match locking in the 52-week bill at {rate(bills.yearRate, 2)}, the
							bills bought after today's must average at least this much over the rest
							of the year.
						</p>
					</Section>
				</>
			) : null}

			<Section title="How reinvestment works">
				<div className="mt-3 max-w-3xl space-y-3 leading-relaxed text-slate-700">
					<p>
						A Treasury bill pays its face value at maturity. Rolling means buying a
						new bill with the proceeds, at whatever rate that week's auction sets.
						TreasuryDirect and many brokers can do this automatically, reinvesting a
						maturing bill into the same term.
					</p>
					<p>
						Rolling short bills keeps money available sooner and follows rates as they
						move, up or down. Holding a 52-week bill fixes the rate for the year.
						Which earns more depends only on where bill rates go, and the catch-up
						rate above is the line between the two.
					</p>
				</div>
			</Section>

			<Section title="Sources">
				<ul className="mt-3 max-w-3xl list-disc space-y-1 pl-5 text-sm text-slate-600">
					<li>
						Rates: Safe Rate's bill curve, a Nelson-Siegel curve fitted each business
						day to Treasury's end-of-day prices for every bill with at least two weeks
						to maturity
						{bills ? `, for ${longDate(bills.asOf)}` : ""}. Prices are a U.S.
						government publication.
					</li>
					<li>
						¹ The rates priced in are implied forward rates, calculated from the bill
						curve's discount factors on a bond-equivalent basis, the basis
						TreasuryDirect calls the investment rate. Bill prices also reflect how
						many bills Treasury is selling and what investors pay for shorter
						maturities, so they are the market's price for later rates rather than a
						pure prediction. Futures on SOFR and fed funds price the same question
						more directly. How the coupon curve is fitted:{" "}
						<Link
							className="text-primary underline underline-offset-4"
							to="/methodology/treasury-curve"
						>
							Treasury curve methodology
						</Link>
						.
					</li>
				</ul>
			</Section>
		</main>
	);
}
