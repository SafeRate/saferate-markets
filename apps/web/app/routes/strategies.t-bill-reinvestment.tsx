import { PRODUCT_NAME, SITE_HOSTS, TRIAL } from "@markets/schema";
import { Form, Link } from "react-router";
import { JsonLd } from "@/components/JsonLd";
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
			"What rolling 4-, 13- or 26-week Treasury bills has to earn to match today's 52-week bill: the breakeven reinvestment rate, the rates the bill curve prices for each reinvestment, and what a roll earns if rates fall or rise. Updated every business day.",
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
const signedMoney = (value: number) =>
	`${value > 0 ? "+" : value < 0 ? "−" : ""}${money(Math.abs(value))}`;

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

const Answer = ({ bills }: { bills: TBillReinvestment }) => {
	const thirteen = bills.terms.find((t) => t.key === "13w");
	const flat = thirteen?.outcomes.find((o) => o.key === "flat");
	if (!thirteen || !flat) return null;
	const gap = flat.income - bills.yearIncome;
	return (
		<p className="mt-5 max-w-3xl text-lg leading-relaxed text-slate-700">
			On {longDate(bills.asOf)}, the 52-week Treasury bill yields{" "}
			{rate(bills.yearRate, 2)}. Rolling 13-week bills for a year earns the same
			only if the next three 13-week bills average {rate(thirteen.breakeven, 2)} or
			more; today's 13-week bill yields {rate(thirteen.todayRate, 2)}. If bill
			rates stay where they are, rolling earns {rate(flat.ratePercent, 2)}, which
			on {money(bills.amount)} is {signedMoney(gap)} against the 52-week bill.
		</p>
	);
};

export default function TBillReinvestment({
	loaderData,
}: Route.ComponentProps) {
	const { bills, amount } = loaderData;
	const web = SITE_HOSTS.production.web;
	const thirteen = bills?.terms.find((t) => t.key === "13w");
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

			{bills ? (
				<>
					<Section title="What each roll has to beat">
						<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
							<table className="w-full min-w-[36rem] border-collapse text-sm">
								<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
									<tr>
										<th className={th}>Roll</th>
										<th className={`${th} text-right`}>Today's rate</th>
										<th className={`${th} text-right`}>Bills in a year</th>
										<th className={`${th} text-right`}>Breakeven reinvestment rate</th>
									</tr>
								</thead>
								<tbody>
									{bills.terms.map((t) => (
										<tr className="border-t border-slate-100" key={t.key}>
											<td className="px-4 py-2 text-neutral-900">{t.label} bills</td>
											<td className={td}>{rate(t.todayRate, 2)}</td>
											<td className={td}>{t.rolls}</td>
											<td className={td}>{rate(t.breakeven, 2)}</td>
										</tr>
									))}
									<tr className="border-t border-slate-100 bg-slate-50/60">
										<td className="px-4 py-2 font-medium text-neutral-900">
											52-week bill, held
										</td>
										<td className={td}>{rate(bills.yearRate, 2)}</td>
										<td className={td}>1</td>
										<td className={td}>None needed</td>
									</tr>
								</tbody>
							</table>
						</div>
						<p className="mt-2 max-w-3xl text-sm text-slate-600">
							The breakeven is the average rate the bills after the first must earn for
							the roll to match the 52-week bill over the same year. The first bill is
							bought today at today's rate.
						</p>
					</Section>

					{thirteen ? (
						<Section title="The rate the curve prices for each 13-week reinvestment">
							<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
								<table className="w-full min-w-[24rem] border-collapse text-sm">
									<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
										<tr>
											<th className={th}>Bill bought around</th>
											<th className={`${th} text-right`}>Rate</th>
										</tr>
									</thead>
									<tbody>
										{thirteen.schedule.map((s, i) => (
											<tr className="border-t border-slate-100" key={s.date}>
												<td className="px-4 py-2 text-neutral-900">
													{longDate(s.date)}
													{i === 0 ? " (today)" : ""}
												</td>
												<td className={td}>{rate(s.rate, 2)}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							<p className="mt-2 max-w-3xl text-sm text-slate-600">
								These are implied forward rates: what today's bill prices already imply
								for each future 13-week bill. They are the market's pricing, read off
								Safe Rate's fitted bill curve, not a forecast by Safe Rate.
							</p>
						</Section>
					) : null}

					<Section title={`One year on ${money(bills.amount)}`}>
						<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
							<table className="w-full min-w-[44rem] border-collapse text-sm">
								<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
									<tr>
										<th className={th}>If reinvestment rates are</th>
										{bills.terms.map((t) => (
											<th className={`${th} text-right`} key={t.key}>
												Roll {t.label}
											</th>
										))}
										<th className={`${th} text-right`}>Hold 52-week</th>
									</tr>
								</thead>
								<tbody>
									{bills.scenarios.map((s) => (
										<tr className="border-t border-slate-100" key={s.key}>
											<td className="px-4 py-2 text-neutral-900">{s.label}</td>
											{bills.terms.map((t) => {
												const o = t.outcomes.find((x) => x.key === s.key);
												return (
													<td className={td} key={t.key}>
														{o ? (
															<>
																{money(o.income)}{" "}
																<span className="text-xs text-slate-500">
																	{rate(o.ratePercent, 2)}
																</span>
															</>
														) : (
															"—"
														)}
													</td>
												);
											})}
											<td className={td}>
												{money(bills.yearIncome)}{" "}
												<span className="text-xs text-slate-500">
													{rate(bills.yearRate, 2)}
												</span>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<p className="mt-2 max-w-3xl text-xs text-slate-500">
							Interest earned over one year, with each maturing bill reinvested in
							full. The 52-week bill's income is fixed when it is bought; a roll's
							depends on the rates at each reinvestment. "Stay where they are" holds
							each roll at today's rate for its term. Rates are bond-equivalent yields,
							the basis TreasuryDirect calls the investment rate. Before taxes;
							Treasury bill interest is exempt from state and local income tax.
						</p>
						<Form className="mt-4 flex flex-wrap items-end gap-3" method="get">
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
						Rolling short bills keeps money available and follows rates as they move,
						up or down. Holding a 52-week bill fixes the rate for the year. Which
						earns more depends only on where bill rates go, and the breakeven above is
						the line between the two.
					</p>
					<p>
						When the bill curve slopes up, as it does today, the 52-week bill pays
						more than a short bill, and the curve prices later short bills higher too.
						Rolling comes out ahead only if those later bills beat what the curve
						prices.
					</p>
				</div>
			</Section>

			<Section title="Hold bills in a portfolio">
				<p className="mt-3 max-w-3xl text-slate-700">
					Track a bill roll in Safe Rate Markets, valued every day on the same
					end-of-day prices. New accounts start with a free {TRIAL.days}-day trial,
					no card required.
				</p>
				<Link
					className="mt-4 inline-block rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
					to={`/sign-in?next=${encodeURIComponent(`/dashboard/builder?mode=strategy&strategy=billRoll&budget=${Math.max(amount, 1000)}`)}`}
				>
					Track a bill roll
				</Link>
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
						Implied forwards are calculated from that curve's discount factors on a
						bond-equivalent basis. How the coupon curve is fitted:{" "}
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
