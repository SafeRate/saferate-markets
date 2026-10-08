import { PRODUCT_NAME, SITE_HOSTS } from "@markets/schema";
import { Link } from "react-router";
import { JsonLd } from "@/components/JsonLd";
import { breadcrumbJsonLd, ORGANIZATION_REF } from "@/lib/jsonLd";
import type { Route } from "./+types/methodology.treasury-curve";

const PATH = "/methodology/treasury-curve";
const TITLE = "Treasury Curve Methodology";

export const meta: Route.MetaFunction = () => [
	{ title: `${TITLE}: How Safe Rate Fits the Yield Curve | ${PRODUCT_NAME}` },
	{
		name: "description",
		content:
			"How Safe Rate fits the U.S. Treasury yield curve every business day since 2008: the securities used, the Svensson model, the weighting, and how closely its par and zero rates track the Federal Reserve's published curve.",
	},
];

/**
 * How the fitted Treasury curve is built, for the pages that use it (the
 * spread pages and the ladders) to link to.
 *
 * EVERY FIGURE HERE IS MEASURED, AND DATED. The accuracy table is treasury's
 * `verify-vs-fed` gate as run on 2026-10-08 (pooled across every stored tenor
 * and date), sent by the treasury session; the build fails when any of these
 * drifts past its tolerance. The construction facts are from
 * packages/utils zeroCurve.ts, curveFitting.ts and fedInvestPrices.ts
 * (selectSecuritiesForFitting) in saferate-treasury. When the gate is re-run,
 * update MEASURED_ON and the table together.
 *
 * The H.15 comparison is described, not quantified: the gap between this curve
 * and Treasury's constant-maturity yields is being measured and is not stated
 * until it is.
 */
const MEASURED_ON = "October 8, 2026";

const ACCURACY = [
	{
		what: "Par yield",
		against: "SVENPY",
		n: "31,521",
		mean: "0.01",
		meanAbs: "1.28",
		rmse: "2.28",
		gate: "6",
	},
	{
		what: "Zero rate",
		against: "SVENY",
		n: "31,521",
		mean: "−0.15",
		meanAbs: "1.68",
		rmse: "3.44",
		gate: "6",
	},
	{
		what: "Real zero rate (TIPS curve)",
		against: "TIPSY",
		n: "27,018",
		mean: "0.00",
		meanAbs: "1.73",
		rmse: "2.81",
		gate: "12",
	},
];

const Section = ({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) => (
	<section className="mt-12 max-w-3xl">
		<h2 className="text-xl font-semibold tracking-tight text-neutral-900">
			{title}
		</h2>
		<div className="mt-3 space-y-3 leading-relaxed text-slate-700">
			{children}
		</div>
	</section>
);

export default function TreasuryCurveMethodology() {
	const web = SITE_HOSTS.production.web;
	return (
		<main className="mx-auto max-w-6xl px-6 py-16">
			<JsonLd
				data={{
					"@context": "https://schema.org",
					"@type": "TechArticle",
					"@id": `${web}${PATH}#article`,
					url: `${web}${PATH}`,
					headline: TITLE,
					about: "Fitting the U.S. Treasury yield curve",
					author: ORGANIZATION_REF,
					publisher: ORGANIZATION_REF,
					dateModified: "2026-10-08",
					inLanguage: "en-US",
				}}
			/>
			<JsonLd
				data={breadcrumbJsonLd([
					{ name: PRODUCT_NAME, path: "/" },
					{ name: TITLE, path: PATH },
				])}
			/>
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				Methodology
			</p>
			<h1 className="mt-3 text-4xl font-semibold tracking-tight text-neutral-900">
				{TITLE}
			</h1>
			<p className="mt-5 max-w-3xl text-lg leading-relaxed text-slate-700">
				Safe Rate fits one discount curve to Treasury's end-of-day prices for every
				fixed-rate note and bond, every business day since September 2008. Across
				31,521 tenor-days, its par yields differ from the Federal Reserve's
				published curve by 2.28 basis points root mean square, with an average
				difference of 0.01 basis points.
			</p>

			<Section title="What goes in">
				<p>
					Treasury's end-of-day prices (FedInvest) for every marketable Treasury,
					every business day. The coupon curve is fitted to fixed-rate, non-callable
					notes and bonds with at least three months to maturity.
				</p>
				<p>
					Held out, each for a stated reason: TIPS, whose yields are real rather than
					nominal (they get their own real curve); floating-rate notes, which have no
					fixed coupon to discount; callable bonds, whose redemption date is
					uncertain; and anything inside three months, where money-market effects
					dominate. Bills go to a separate money-market curve on their own day-count
					basis.
				</p>
			</Section>

			<Section title="The model">
				<p>
					A Nelson-Siegel-Svensson curve, fitted as a zero-coupon discount curve
					against each security's observed dirty price, the same object the Federal
					Reserve publishes. Every cashflow is discounted at its own zero rate, so
					zero rates, par yields and forward rates all come from one discount
					function and agree with each other.
				</p>
				<p>
					Price errors are weighted by inverse modified duration, so they behave like
					yield errors and long bonds do not dominate simply because their prices
					move more. A penalty on the roughness of the forward curve, with its
					strength chosen by held-out cross validation, keeps the curve smooth
					between securities, and the fourth Svensson factor is used only when the
					data clearly calls for it.
				</p>
			</Section>

			<Section title="What comes out">
				<p>
					For each business day, at 1, 2, 3, 5, 7, 10, 15, 20, 25 and 30 years: the
					continuously compounded zero rate, the par yield on a semiannual coupon
					basis, and the instantaneous forward rate.
				</p>
				<p>
					<strong className="text-neutral-900">Par or zero?</strong> A par yield is
					the coupon that prices a new bond at 100, and it is what the market quotes.
					Spreads such as 2s10s and 5s30s are differences in par yields, so the{" "}
					<Link
						className="text-primary underline underline-offset-4"
						to="/curve/2s10s"
					>
						2s10s
					</Link>{" "}
					and{" "}
					<Link
						className="text-primary underline underline-offset-4"
						to="/curve/5s30s"
					>
						5s30s
					</Link>{" "}
					pages use par. Zero rates are the discount rates themselves, for pricing
					cashflows and building forwards.
				</p>
			</Section>

			<Section title="How closely it tracks the Federal Reserve's curve">
				<p>
					The comparison is with the Gürkaynak, Sack and Wright curve the Federal
					Reserve publishes, matched on every date and tenor both cover. Measured{" "}
					{MEASURED_ON}, in basis points:
				</p>
			</Section>
			<div className="mt-4 max-w-4xl overflow-x-auto rounded-xl border border-slate-200">
				<table className="w-full min-w-[40rem] border-collapse text-sm">
					<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
						<tr>
							<th className="px-4 py-2 font-semibold">Series</th>
							<th className="px-4 py-2 font-semibold">Fed series</th>
							<th className="px-4 py-2 text-right font-semibold">Points</th>
							<th className="px-4 py-2 text-right font-semibold">Mean</th>
							<th className="px-4 py-2 text-right font-semibold">Mean abs</th>
							<th className="px-4 py-2 text-right font-semibold">RMSE</th>
							<th className="px-4 py-2 text-right font-semibold">Tolerance</th>
						</tr>
					</thead>
					<tbody>
						{ACCURACY.map((row) => (
							<tr className="border-t border-slate-100" key={row.against}>
								<td className="px-4 py-2 text-neutral-900">{row.what}</td>
								<td className="px-4 py-2 font-mono text-xs text-slate-600">
									{row.against}
								</td>
								<td className="px-4 py-2 text-right tabular-nums">{row.n}</td>
								<td className="px-4 py-2 text-right tabular-nums">{row.mean}</td>
								<td className="px-4 py-2 text-right tabular-nums">{row.meanAbs}</td>
								<td className="px-4 py-2 text-right tabular-nums">{row.rmse}</td>
								<td className="px-4 py-2 text-right tabular-nums">{row.gate}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<div className="max-w-3xl space-y-3 leading-relaxed text-slate-700">
				<p className="mt-3">
					The mean difference is close to zero in each case: the curve is scattered
					around the Federal Reserve's, not biased against it. The tolerance is a
					gate in the build: if any of these drifts past it, the daily run fails
					rather than publishing.
				</p>
				<p>
					The 30-year instantaneous forward is the exception, at 60.85 basis points
					RMSE. No traded cashflow pins a forward rate thirty years out, and the
					authors of the Federal Reserve's curve disclaim that region themselves. It
					is published with that limit stated, not as a figure to rely on.
				</p>
			</div>

			<Section title="How it differs from Treasury's constant-maturity yields">
				<p>
					Treasury's official constant-maturity yields, republished by the Federal
					Reserve in its H.15 release and on FRED (for example DGS2 and DGS10), are a
					third curve with its own method: a par curve built from bid-side quotes for
					the most recently auctioned securities, taken in the afternoon rather than
					at the end of the day. This curve is fitted to end-of-day prices for all
					eligible notes and bonds, and the Federal Reserve's research curve to
					off-the-run securities.
				</p>
				<p>
					Three methods and three times of day mean the curves differ from day to day
					without any of them being wrong. The spread pages show the H.15
					constant-maturity spread as a labeled reference line beside this one.
				</p>
			</Section>

			<Section title="Sources">
				<ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
					<li>
						Prices: U.S. Department of the Treasury, FedInvest end-of-day prices, a
						U.S. government publication.
					</li>
					<li>
						Comparison: Gürkaynak, Sack and Wright (2007), "The U.S. Treasury Yield
						Curve: 1961 to the Present," and the Federal Reserve Board's published
						data (feds200628).
					</li>
					<li>
						Model: Svensson (1994); calibration after Gilli, Grosse and Schumann
						(2010); roughness penalty after Fisher, Nychka and Zervos (1995).
					</li>
				</ul>
			</Section>
		</main>
	);
}
