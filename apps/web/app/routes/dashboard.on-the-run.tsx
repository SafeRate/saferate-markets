import { readLatestPriceDate, readPricesOn } from "@markets/mcp-tools";
import { parseDate } from "@markets/portfolio";
import { PRODUCT_NAME } from "@markets/schema";
import {
	getQueueYields,
	getRunStatusOn,
} from "@saferate/treasury-client/client";
import { TREASURY_COVERAGE_START } from "@saferate/treasury-client/types";
import { Form } from "react-router";
import { requireOrganization } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.on-the-run";

export const meta: Route.MetaFunction = () => [
	{ title: `On / Off the Run — ${PRODUCT_NAME}` },
];

/**
 * Every issuance queue on a day: the on-the-run security of each type and
 * original term and the issues before it, with the premium the benchmark
 * carries. The consumer site's /treasury/on-the-run, behind sign-in.
 *
 * THE PREMIUM IS STRUCK ON RESIDUALS, not yields (getQueueYields): the older
 * issues mature earlier, so on an upward-sloping curve they yield less and a
 * raw yield difference is mostly the maturity gap. A floater's discount
 * margin is already a spread, so its premium is the margin difference. And
 * families are never compared with each other: a real yield is not a nominal
 * one. Dates come from the data: no date means the newest priced day that has
 * a run record.
 */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	await requireOrganization(request, env);
	const params = new URL(request.url).searchParams;
	const asked = parseDate(params.get("date") ?? "");
	const basis = params.get("basis") === "auction" ? "auction" : "issue";
	const latest = await readLatestPriceDate(env);
	if (asked !== null && asked < TREASURY_COVERAGE_START)
		return {
			latest,
			basis,
			asked,
			outcome: {
				ok: false as const,
				message: `Coverage starts ${TREASURY_COVERAGE_START}.`,
			},
		};

	// The run record follows the prices: step back from the newest priced day.
	let date = asked ?? latest;
	let run = await getRunStatusOn({ env, date, basis });
	for (
		let step = 1;
		asked === null && (run?.queues.length ?? 0) === 0 && step < 7;
		step++
	) {
		date = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000)
			.toISOString()
			.slice(0, 10);
		run = await getRunStatusOn({ env, date, basis });
	}
	if (run === null || run.queues.length === 0)
		return {
			latest,
			basis,
			asked,
			outcome: {
				ok: false as const,
				message: asked
					? `No run record for ${asked}: a weekend, a holiday, or a day not yet published.`
					: "No run record in the last week.",
			},
		};

	const kinds = [...new Set(run.queues.map((q) => q[0].securityKind))];
	const [prices, ...yieldSets] = await Promise.all([
		readPricesOn(env, date),
		...kinds.map((kind) => getQueueYields({ env, date, kind })),
	]);
	const yieldsOf = new Map(kinds.map((kind, i) => [kind, yieldSets[i]]));
	const terms = new Map(prices.map((p) => [p.cusip, p]));

	const queues = run.queues.map((members) => {
		const kind = members[0].securityKind;
		const y = yieldsOf.get(kind);
		const benchmark = y?.residuals.get(members[0].cusip) ?? null;
		return {
			kind,
			term: members[0].originalSecurityTerm,
			unit: y?.unit ?? "percent",
			members: members.map((m) => {
				const residual = y?.residuals.get(m.cusip) ?? null;
				return {
					rank: m.runRank,
					cusip: m.cusip,
					couponPercent: terms.get(m.cusip)?.couponPercent ?? null,
					maturityDate: terms.get(m.cusip)?.maturityDate ?? null,
					outstanding: y?.outstanding.has(m.cusip) ?? false,
					yield: y?.yields.get(m.cusip) ?? null,
					residual,
					// Positive: this older issue sits cheaper than the benchmark once the
					// curve is taken out, i.e. the on-the-run carries that much premium.
					// For a floater both are discount margins, already spreads.
					premium:
						m.runRank === 0 || residual === null || benchmark === null
							? null
							: residual - benchmark,
				};
			}),
		};
	});
	return {
		latest,
		basis,
		asked,
		outcome: { ok: true as const, date, queues },
	};
};

const th = "px-2.5 py-1.5 font-semibold";
const td = "tabular px-2.5 py-1.5";

const shortDate = (iso: string | null) =>
	iso === null
		? "—"
		: new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
				timeZone: "UTC",
			});

const rankLabel = (rank: number) =>
	rank === 0
		? "On the run"
		: `${rank}${rank === 1 ? "st" : rank === 2 ? "nd" : rank === 3 ? "rd" : "th"} off`;

const unitLabel = (unit: string) =>
	unit === "marginBp"
		? "Discount margin"
		: unit === "realPercent"
			? "Real yield"
			: "Yield";

const shownYield = (value: number | null, unit: string) =>
	value === null
		? "—"
		: unit === "marginBp"
			? `${value.toFixed(1)} bp`
			: `${value.toFixed(3)}%`;

const bp = (value: number | null) => {
	if (value === null) return "—";
	// Rounded first, so a -0.04 reads 0.0 rather than "−0.0".
	const v = Number(value.toFixed(1));
	return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} bp`;
};

export default function OnTheRun({ loaderData }: Route.ComponentProps) {
	const { latest, basis, outcome } = loaderData;
	return (
		<main className="max-w-6xl">
			<h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
				On / Off the Run
			</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				Each issuance queue: the newest security of every type and original term,
				and the issues before it
				{outcome.ok ? `, on ${shortDate(outcome.date)}` : ""}.
			</p>
			<Form className="mt-4 flex flex-wrap items-end gap-3" method="get">
				<label className="text-sm">
					Day
					<input
						className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
						defaultValue={outcome.ok ? outcome.date : latest}
						max={latest}
						min={TREASURY_COVERAGE_START}
						name="date"
						type="date"
					/>
				</label>
				<label className="text-sm">
					Ranked by
					<select
						className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
						defaultValue={basis}
						name="basis"
					>
						<option value="issue">Issue date</option>
						<option value="auction">Auction date</option>
					</select>
				</label>
				<button
					className="rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-white hover:bg-primary/90"
					type="submit"
				>
					Show
				</button>
			</Form>

			{!outcome.ok ? (
				<p className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
					{outcome.message}
				</p>
			) : (
				<>
					<div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
						{outcome.queues.map((q) => (
							<section
								className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm"
								key={`${q.kind}${q.term}`}
							>
								<h2 className="border-b border-slate-100 px-4 py-2.5 font-semibold text-neutral-900">
									{q.kind} {q.term}
								</h2>
								<table className="w-full text-xs">
									<thead className="text-left uppercase tracking-wide text-slate-500">
										<tr>
											<th className={th}>Rank</th>
											<th className={th}>Security</th>
											<th className={`${th} text-right`}>{unitLabel(q.unit)}</th>
											<th className={`${th} text-right`}>
												{q.unit === "marginBp" ? "vs benchmark" : "Premium"}
											</th>
										</tr>
									</thead>
									<tbody>
										{q.members.map((m) => (
											<tr
												className={`border-t border-slate-100 ${m.rank === 0 ? "bg-primary/5 font-medium" : ""}`}
												key={m.cusip}
											>
												<td className="px-2.5 py-1.5">{rankLabel(m.rank)}</td>
												<td className="px-2.5 py-1.5">
													{/* A floater's price-row coupon is today's reset rate, not a fixed
													    coupon: show its maturity alone. */}
													{q.kind !== "FRN" &&
													m.couponPercent !== null &&
													m.couponPercent > 0
														? `${Number(m.couponPercent.toFixed(4))}% `
														: q.kind === "FRN"
															? "FRN "
															: ""}
													{shortDate(m.maturityDate)}
													<div className="font-mono text-[10px] text-slate-500">
														{m.cusip}
														{m.outstanding ? "" : " · not yet priced"}
													</div>
												</td>
												<td className={`${td} text-right`}>
													{shownYield(m.yield, q.unit)}
												</td>
												<td className={`${td} text-right`}>
													{m.rank === 0 ? "" : bp(m.premium)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</section>
						))}
					</div>
					<p className="mt-4 text-xs text-slate-500">
						Ranked by {basis === "issue" ? "issue" : "auction"} date: a security goes
						on the run when it is {basis === "issue" ? "issued" : "auctioned"}; the
						two can differ for a few days after each auction. The premium is each
						older issue's residual to the fitted curve less the benchmark's, in basis
						points: positive means the older issue is cheaper than the on-the-run once
						the maturity gap is taken out, which is the liquidity premium the
						benchmark carries. Raw yields would mislead: the older issues mature
						earlier, so on an upward-sloping curve they yield less anyway. For
						floaters the discount margin is already a spread, so the column is simply
						the margin against the benchmark's. Real yields (TIPS) and nominal yields
						are never compared with each other. A security auctioned but not yet
						issued has no price yet.
					</p>
				</>
			)}
		</main>
	);
}
