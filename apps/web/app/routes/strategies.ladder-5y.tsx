import { PRODUCT_NAME, SITE_HOSTS, TRIAL } from "@markets/schema";
import { Form, Link } from "react-router";
import { JsonLd } from "@/components/JsonLd";
import { StrategyDisclaimer } from "@/components/StrategyDisclaimer";
import { breadcrumbJsonLd, ORGANIZATION_REF } from "@/lib/jsonLd";
import { describeSecurity, money, number, price, rate } from "@/lib/format";
import { NY_FED_NOTICE } from "@/lib/sourceNotices";
import { amountFrom, DEFAULT_AMOUNT } from "@/lib/ladderAmount";
import { loadLadderPage, type TLadderPage } from "@/services/ladderPage.server";
import type { Route } from "./+types/strategies.ladder-5y";

const YEARS = 5;
const PATH = "/strategies/ladder-5y";
const TITLE = "5-Year Treasury Ladder";

export const meta: Route.MetaFunction = () => [
	{ title: `${TITLE}: Today's Rungs, Yield and Income | ${PRODUCT_NAME}` },
	{
		name: "description",
		content:
			"A 5-year U.S. Treasury ladder rebuilt every business day from end-of-day prices: the five notes it holds, their yields, the ladder's yield, duration and DV01, the income calendar, and what rate moves do to its value.",
	},
];

/**
 * The 5-year ladder, a published rule rather than a recommendation: the same
 * securities for every visitor, chosen by the rule stated on the page from the
 * day's end-of-day prices (services/ladderPage.server.ts). The amount is the
 * only input and lives in the query string; the canonical stays on the bare
 * path (root.tsx), so `?amount=` never becomes a second page.
 *
 * A failed read renders the page's rule and an "unavailable" line rather
 * than an error: the rule is still true when today's prices cannot be read.
 */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const amount = amountFrom(new URL(request.url).searchParams.get("amount"));
	try {
		return {
			amount,
			ladder: await loadLadderPage(context.cloudflare.env, {
				years: YEARS,
				amount,
			}),
		};
	} catch (error) {
		console.error("[ladder-5y] could not build today's ladder:", error);
		return { amount, ladder: null };
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
const signedRate = (value: number, digits = 2) =>
	`${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`;

const RULE = [
	"One rung for each year from one to five years after settlement, five rungs in all.",
	"Each rung is the Treasury note or bond, excluding TIPS and floating-rate notes, whose maturity is nearest to that year.",
	"Equal dollar amounts in each rung, bought in $1,000 face steps at the day's end-of-day price.",
	"The basket is rebuilt from the day's prices every business day. Held over time, a ladder reinvests each maturing rung at the five-year end, which keeps its shape.",
];

const Answer = ({ ladder }: { ladder: TLadderPage }) => {
	const first = ladder.rungs[0];
	const last = ladder.rungs.at(-1);
	return (
		<p className="mt-5 max-w-3xl text-lg leading-relaxed text-slate-700">
			On {longDate(ladder.asOf)}, a 5-year Treasury ladder of{" "}
			{money(ladder.amount)} yields {rate(ladder.yieldPercent, 2)} across{" "}
			{ladder.rungs.length} notes maturing from{" "}
			{first ? longDate(first.maturityDate) : "next year"} to{" "}
			{last ? longDate(last.maturityDate) : "five years out"}, with a modified
			duration of {number(ladder.duration, 2)} years. A 1 basis point rise in rates
			lowers its value by about {money(ladder.dv01, 0)}.
		</p>
	);
};

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

const Stat = ({
	label,
	value,
	note,
}: {
	label: string;
	value: string;
	note?: string;
}) => (
	<div className="rounded-xl border border-slate-200 bg-white p-4">
		<dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
			{label}
		</dt>
		<dd className="mt-1 text-2xl font-semibold text-neutral-900">{value}</dd>
		{note ? <dd className="mt-1 text-xs text-slate-500">{note}</dd> : null}
	</div>
);

export default function LadderFiveYear({ loaderData }: Route.ComponentProps) {
	const { ladder, amount } = loaderData;
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
					...(ladder ? { dateModified: ladder.asOf } : {}),
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
					{ name: TITLE, path: PATH },
				])}
			/>
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				Strategy
			</p>
			<h1 className="mt-3 text-4xl font-semibold tracking-tight text-neutral-900">
				{TITLE}
				{ladder ? ` (${longDate(ladder.asOf)})` : ""}
			</h1>
			{ladder ? (
				<Answer ladder={ladder} />
			) : (
				<p className="mt-5 max-w-3xl text-lg text-slate-600">
					Today's ladder could not be built just now. The rule below is unchanged;
					try again shortly.
				</p>
			)}
			<StrategyDisclaimer
				trackLabel="Track this ladder"
				trackTo={`/sign-in?next=${encodeURIComponent(`/dashboard/builder?mode=strategy&strategy=ladder&horizon=${YEARS}&budget=${amount}`)}`}
			/>

			<Section title="The rule">
				<ol className="mt-4 max-w-3xl list-decimal space-y-2 pl-5 text-slate-700 marker:text-primary">
					{RULE.map((line) => (
						<li key={line}>{line}</li>
					))}
				</ol>
				<p className="mt-3 max-w-3xl text-sm text-slate-500">
					A published rule applied to public prices, the same for every reader.
				</p>
			</Section>

			{ladder ? (
				<>
					<Section title={`Today's rungs, for ${money(ladder.amount)}`}>
						<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
							<table className="w-full min-w-[44rem] border-collapse text-sm">
								<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
									<tr>
										<th className="px-4 py-2 font-semibold">Security</th>
										<th className="px-4 py-2 font-semibold">CUSIP</th>
										<th className="px-4 py-2 text-right font-semibold">Price</th>
										<th className="px-4 py-2 text-right font-semibold">Yield</th>
										<th className="px-4 py-2 text-right font-semibold">Face</th>
										<th className="px-4 py-2 text-right font-semibold">Cost</th>
										<th className="px-4 py-2 text-right font-semibold">Weight</th>
									</tr>
								</thead>
								<tbody>
									{ladder.rungs.map((r) => (
										<tr className="border-t border-slate-100" key={r.cusip}>
											<td className="px-4 py-2 font-medium text-neutral-900">
												{describeSecurity(r)}
											</td>
											<td className="px-4 py-2 font-mono text-xs text-slate-600">
												{r.cusip}
											</td>
											<td className="px-4 py-2 text-right tabular-nums">
												{price(r.price)}
											</td>
											<td className="px-4 py-2 text-right tabular-nums">
												{rate(r.yieldPercent, 3)}
											</td>
											<td className="px-4 py-2 text-right tabular-nums">
												{money(r.faceAmount)}
											</td>
											<td className="px-4 py-2 text-right tabular-nums">
												{money(r.cost)}
											</td>
											<td className="px-4 py-2 text-right tabular-nums">
												{number(r.weightPercent, 1)}%
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<p className="mt-2 text-xs text-slate-500">
							Prices are Treasury's end-of-day prices for {longDate(ladder.asOf)}; cost
							includes accrued interest to settlement on{" "}
							{longDate(ladder.settlementDate)}.
							{ladder.leftover !== null && ladder.leftover > 0
								? ` ${money(ladder.leftover)} is left over after rounding to $1,000 steps.`
								: ""}
							{ladder.notes.length > 0 ? ` ${ladder.notes.join(" ")}` : ""}
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
							<span className="text-xs text-slate-500">
								$10,000 to $10,000,000. Changes the face amounts, not the securities.
							</span>
						</Form>
					</Section>

					<Section title="What the ladder holds">
						<dl className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
							<Stat
								label="Yield"
								note="Yield to maturity of the whole basket"
								value={rate(ladder.yieldPercent, 2)}
							/>
							<Stat
								label="Modified duration"
								note="Years"
								value={number(ladder.duration, 2)}
							/>
							<Stat
								label="DV01"
								note="Value change for a 1 bp move"
								value={money(ladder.dv01, 0)}
							/>
							<Stat
								label="Financed carry"
								note={
									ladder.sofr
										? `Yield minus SOFR of ${rate(ladder.sofr.percent, 2)} on ${longDate(ladder.sofr.date)}`
										: "SOFR unavailable today"
								}
								value={
									ladder.financedCarryPercent === null
										? "—"
										: signedRate(ladder.financedCarryPercent)
								}
							/>
						</dl>
						<p className="mt-3 max-w-3xl text-sm text-slate-600">
							If the curve does not move, the ladder returns{" "}
							{signedRate(ladder.threeMonthPercent, 2)} over the next three months from
							coupons and from rolling down the curve, valued on Safe Rate's fitted
							curve for {longDate(ladder.curveDate)}.
						</p>
					</Section>

					<Section title="If rates move">
						<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
							<table className="w-full min-w-[28rem] border-collapse text-sm">
								<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
									<tr>
										<th className="px-4 py-2 font-semibold">Move</th>
										<th className="px-4 py-2 text-right font-semibold">Value change</th>
										<th className="px-4 py-2 text-right font-semibold">Percent</th>
									</tr>
								</thead>
								<tbody>
									{ladder.scenarios.map((s) => (
										<tr className="border-t border-slate-100" key={s.name}>
											<td className="px-4 py-2 text-neutral-900">{s.name}</td>
											<td className="px-4 py-2 text-right tabular-nums">
												{signedMoney(s.change)}
											</td>
											<td className="px-4 py-2 text-right tabular-nums">
												{signedRate(s.changePercent)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<p className="mt-2 max-w-3xl text-xs text-slate-500">
							Every cashflow repriced off the fitted curve after an immediate, one-time
							shift. A steepening moves the 2-year down and the 10-year up by half the
							amount each, linearly between. These are sensitivities, not forecasts.
						</p>
					</Section>

					<Section title="Income calendar">
						<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
							<table className="w-full min-w-[20rem] border-collapse text-sm">
								<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
									<tr>
										<th className="px-4 py-2 font-semibold">Year</th>
										<th className="px-4 py-2 text-right font-semibold">
											Coupons and maturities
										</th>
									</tr>
								</thead>
								<tbody>
									{ladder.byYear.map((y) => (
										<tr className="border-t border-slate-100" key={y.year}>
											<td className="px-4 py-2 text-neutral-900">{y.year}</td>
											<td className="px-4 py-2 text-right tabular-nums">
												{money(y.income)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</Section>
				</>
			) : null}

			<Section title="Sources">
				<ul className="mt-3 max-w-3xl list-disc space-y-1 pl-5 text-sm text-slate-600">
					<li>
						Prices: Treasury's end-of-day prices (FedInvest), a U.S. government
						publication{ladder ? `, for ${longDate(ladder.asOf)}` : ""}.
					</li>
					<li>
						Curve, duration and scenarios: Safe Rate's fitted Treasury curve. How it
						is built and how closely it tracks the Federal Reserve's:{" "}
						<Link
							className="text-primary underline underline-offset-4"
							to="/methodology/treasury-curve"
						>
							Treasury curve methodology
						</Link>
						.
					</li>
					{ladder?.sofr ? (
						<li>
							SOFR: Federal Reserve Bank of New York, {longDate(ladder.sofr.date)}.{" "}
							{NY_FED_NOTICE}
						</li>
					) : null}
				</ul>
			</Section>
		</main>
	);
}
