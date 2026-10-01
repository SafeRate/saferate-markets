import {
	bandRichCheap,
	readLatestPriceDate,
	readRichCheap,
	type TRichCheapRow,
} from "@markets/mcp-tools";
import { parseDate } from "@markets/portfolio";
import { PRODUCT_NAME } from "@markets/schema";
import { Form } from "react-router";
import { requireOrganization } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.rich-cheap";

export const meta: Route.MetaFunction = () => [
	{ title: `Rich / Cheap — ${PRODUCT_NAME}` },
];

/**
 * One day's relative value: every note and bond against the fitted nominal
 * curve, banded on the index boundaries, the most unusually cheap and rich of
 * each ranked on z, and bills apart by price residual. The consumer site's
 * internal page (saferate.com/treasury/relative-value-private) behind
 * sign-in rather than a password; nothing on it is secret. Every date comes
 * from the data: with no date, the newest day that has analytics.
 */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	await requireOrganization(request, env);
	const asked = parseDate(new URL(request.url).searchParams.get("date") ?? "");
	const latest = await readLatestPriceDate(env);
	const day = await readRichCheap(env, {
		basis: "nominal",
		date: asked ?? undefined,
	});
	if (day === null)
		return {
			latest,
			asked,
			date: null,
			banded: null,
			unpriced: 0,
		};
	return {
		latest,
		asked,
		date: day.date,
		banded: bandRichCheap(day.rows),
		unpriced: day.unpriced,
	};
};

const th = "px-2.5 py-1.5 font-semibold";
const td = "tabular px-2.5 py-1.5";

const shortDate = (iso: string) =>
	new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});

/** Signed to `digits`, rounded first so a -0.04 reads 0.0 rather than "−0.0". */
const signed = (value: number | null, digits: number) => {
	if (value === null) return "—";
	const v = Number(value.toFixed(digits));
	return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;
};

const Rows = ({
	rows,
	tone,
	showZ = true,
}: {
	rows: TRichCheapRow[];
	tone: "cheap" | "rich";
	showZ?: boolean;
}) =>
	rows.length === 0 ? (
		<p className="px-2.5 py-3 text-xs text-slate-500">None today.</p>
	) : (
		<table className="w-full text-xs">
			<thead className="text-left uppercase tracking-wide text-slate-500">
				<tr>
					<th className={th}>Security</th>
					<th className={`${th} text-right`}>Yield</th>
					<th className={`${th} text-right`}>vs curve</th>
					<th className={`${th} text-right`}>Cents</th>
					{showZ ? <th className={`${th} text-right`}>z</th> : null}
				</tr>
			</thead>
			<tbody>
				{rows.map((r) => (
					<tr className="border-t border-slate-100" key={r.cusip}>
						<td className="px-2.5 py-1.5">
							{/* The price row's rate is a decimal times 100: 1.7500000000000002. */}
							{r.couponPercent > 0 ? `${Number(r.couponPercent.toFixed(4))}% ` : ""}
							{shortDate(r.maturityDate)}
							<div className="font-mono text-[10px] text-slate-500">{r.cusip}</div>
						</td>
						<td className={`${td} text-right`}>
							{r.yieldPercent === null ? "—" : `${r.yieldPercent.toFixed(3)}%`}
						</td>
						<td className={`${td} text-right`}>
							{r.residualBasisPoints === null
								? "—"
								: `${signed(r.residualBasisPoints, 1)} bp`}
						</td>
						<td className={`${td} text-right`}>{signed(r.priceResidualCents, 1)}</td>
						{showZ ? (
							<td
								className={`${td} text-right font-semibold ${tone === "cheap" ? "text-emerald-700" : "text-red-700"}`}
							>
								{signed(r.zScore, 2)}
							</td>
						) : null}
					</tr>
				))}
			</tbody>
		</table>
	);

const Pair = ({
	title,
	note,
	cheap,
	rich,
	showZ = true,
}: {
	title: string;
	note: string;
	cheap: TRichCheapRow[];
	rich: TRichCheapRow[];
	showZ?: boolean;
}) => (
	<section className="mt-6 rounded-xl border border-slate-200 bg-white shadow-sm">
		<div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
			<h2 className="font-semibold text-neutral-900">{title}</h2>
			<p className="text-xs text-slate-500">{note}</p>
		</div>
		<div className="grid grid-cols-1 gap-0 lg:grid-cols-2">
			<div className="overflow-x-auto lg:border-r lg:border-slate-100">
				<p className="px-2.5 pt-2 text-xs font-semibold text-emerald-800">
					{showZ ? "Unusually cheap" : "Cheapest to the curve"}
				</p>
				<Rows rows={cheap} showZ={showZ} tone="cheap" />
			</div>
			<div className="overflow-x-auto">
				<p className="px-2.5 pt-2 text-xs font-semibold text-red-800">
					{showZ ? "Unusually rich" : "Richest to the curve"}
				</p>
				<Rows rows={rich} showZ={showZ} tone="rich" />
			</div>
		</div>
	</section>
);

export default function RichCheap({ loaderData }: Route.ComponentProps) {
	const d = loaderData;
	return (
		<main className="max-w-6xl">
			<h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
				Rich / Cheap
			</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				Every Treasury note and bond against Safe Rate's fitted nominal curve
				{d.date ? ` on ${shortDate(d.date)}` : ""}, banded by maturity, and ranked
				by how unusual today's distance is for each security.
			</p>

			<Form className="mt-4 flex flex-wrap items-end gap-3" method="get">
				<label className="text-sm">
					Day
					<input
						className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
						defaultValue={d.date ?? d.latest}
						max={d.latest}
						name="date"
						type="date"
					/>
				</label>
				<button
					className="rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-white hover:bg-primary/90"
					type="submit"
				>
					Show
				</button>
			</Form>

			{d.banded === null ? (
				<p className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
					{d.asked
						? `No curve analytics for ${shortDate(d.asked)}: a weekend, a holiday, or a day not yet analyzed. The newest priced day is ${shortDate(d.latest)}.`
						: "No curve analytics in the last week."}
				</p>
			) : (
				<>
					{d.banded.bands.map((band) => (
						<Pair
							cheap={band.cheap}
							key={band.key}
							note={`${band.scoreable} of ${band.total} scoreable`}
							rich={band.rich}
							title={band.label}
						/>
					))}
					<Pair
						cheap={d.banded.bills.cheap}
						note={`${d.banded.bills.total} bills, by price residual`}
						rich={d.banded.bills.rich}
						showZ={false}
						title="Bills"
					/>
					<div className="mt-6 space-y-2 text-xs text-slate-500">
						<p>
							<strong>z</strong> is today's residual against the security's own
							history, in standard deviations: positive is cheaper than it usually is,
							negative richer. The lists are ranked on it, not on the size of the
							residual, because a security can sit a long way from the curve every day;
							that is structure, and z asks whether today is unusual. A security with
							no z yet (new, or inside a month of maturity) is counted but not ranked;
							a z of exactly 0, a security at its own average, is in neither list.
						</p>
						<p>
							<strong>vs curve</strong> is yield less the fitted curve, in basis
							points: positive is cheap. <strong>Cents</strong> is price less the model
							price, per 100: positive is RICH, the opposite sign for the same fact.
							The two questions can disagree: a bond that always trades rich can be
							rich today and still cheaper than usual.
						</p>
						<p>
							Under a year, the residuals are against the curve's extrapolation (its
							fitted range starts at one year) and annualized over a short horizon, so
							the z-scores there run larger and mean less. Bills have no z by
							construction and are ranked by price residual instead, which says how far
							from the curve, not how unusual. TIPS and floaters are priced off other
							curves and are not here.
							{d.unpriced > 0
								? ` ${d.unpriced} analyzed securit${d.unpriced === 1 ? "y has" : "ies have"} no price that day and ${d.unpriced === 1 ? "is" : "are"} left out.`
								: ""}
						</p>
					</div>
				</>
			)}
		</main>
	);
}
