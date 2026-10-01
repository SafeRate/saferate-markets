import { readDailyLevelsOn } from "@markets/mcp-tools";
import { periodStart } from "@markets/portfolio";
import { PRODUCT_NAME } from "@markets/schema";
import { INDEX_META, isIndexCode } from "@saferate/treasury-client/types";
import { Link } from "react-router";
import { percent, signClass } from "@/lib/format";
import { requireOrganization } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.indices";

export const meta: Route.MetaFunction = () => [
	{ title: `Indices — ${PRODUCT_NAME}` },
];

/**
 * The eleven Safe Rate Treasury total-return indices and their trailing
 * returns, ENDED ON THE NEWEST DAILY VALUATION (not the last month-end; see
 * packages/portfolio indexReturns.ts). One read of every index's level per
 * anchor date, rather than eleven whole histories. Since inception is on each
 * index's page, which reads its full series and chains from its base.
 */
const PERIODS = ["mtd", "qtd", "ytd", "1y", "3y", "5y"] as const;

export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	await requireOrganization(request, env);
	const now = await readDailyLevelsOn(env);
	const end =
		now
			.map((l) => l.date)
			.sort()
			.at(-1) ?? null;
	if (end === null) return { end: null, rows: [] };
	const asOf: string = end;

	/** Every index's level on the last valuation day on or before `date`. */
	const levelsAtOrBefore = async (date: string) => {
		const day = new Date(`${date}T00:00:00Z`);
		for (let i = 0; i < 8; i++) {
			const iso = day.toISOString().slice(0, 10);
			const rows = await readDailyLevelsOn(env, iso);
			if (rows.length > 0)
				return { date: iso, levels: new Map(rows.map((r) => [r.code, r.level])) };
			day.setUTCDate(day.getUTCDate() - 1);
		}
		return null;
	};
	const anchors = await Promise.all(
		PERIODS.map(async (key) => {
			const start = periodStart(key, asOf);
			return { key, at: start === null ? null : await levelsAtOrBefore(start) };
		}),
	);
	const years = (from: string) =>
		(Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
		(365.25 * 86_400_000);

	return {
		end,
		rows: now
			.filter((l) => isIndexCode(l.code))
			.map((l) => {
				const meta = INDEX_META[l.code as keyof typeof INDEX_META];
				return {
					code: l.code,
					name: meta.name,
					ticker: meta.ticker,
					covers: meta.covers,
					level: l.level,
					date: l.date,
					isProvisional: l.isProvisional,
					returns: anchors.map(({ key, at }) => {
						const start = at?.levels.get(l.code);
						if (at === null || start === undefined) return { key, value: null };
						const cumulative = l.level / start - 1;
						const y = years(at.date);
						return {
							key,
							// Three and five years are annualised, as index providers quote them.
							value:
								key === "3y" || key === "5y"
									? (1 + cumulative) ** (1 / y) - 1
									: cumulative,
						};
					}),
				};
			}),
	};
};

const th = "px-3 py-2 font-semibold";
const td = "tabular px-3 py-2";
const HEADINGS: Record<(typeof PERIODS)[number], string> = {
	mtd: "MTD",
	qtd: "QTD",
	ytd: "YTD",
	"1y": "1 year",
	"3y": "3 years, a year",
	"5y": "5 years, a year",
};

export default function Indices({ loaderData }: Route.ComponentProps) {
	const { end, rows } = loaderData;
	return (
		<main className="max-w-6xl">
			<h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
				Indices
			</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				Safe Rate's U.S. Treasury total-return indices
				{end ? `, valued on ${end}` : ""}. Returns end on that day's close, not the
				last month-end.
			</p>
			<section className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
				<table className="w-full text-sm">
					<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
						<tr>
							<th className={th}>Index</th>
							<th className={`${th} text-right`}>Level</th>
							{PERIODS.map((p) => (
								<th className={`${th} text-right`} key={p}>
									{HEADINGS[p]}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr className="border-t border-slate-100" key={r.code}>
								<td className="px-3 py-2">
									<Link
										className="font-medium text-primary underline-offset-4 hover:underline"
										to={`/dashboard/indices/${r.code}`}
									>
										{r.name}
									</Link>
									<div className="text-xs text-slate-500">
										{r.ticker} · {r.covers}
									</div>
								</td>
								<td className={`${td} text-right`}>
									{r.level.toFixed(2)}
									{r.isProvisional ? (
										<div className="text-[10px] text-slate-400">provisional</div>
									) : null}
								</td>
								{r.returns.map((ret) => (
									<td
										className={`${td} text-right ${signClass(ret.value)}`}
										key={ret.key}
									>
										{percent(ret.value)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</section>
			<p className="mt-3 text-xs text-slate-500">
				Each period starts at the last valuation on or before its boundary (the last
				day of the previous month, quarter or year; the same date one, three or five
				years back). A dash is a period the index does not reach back to: the bill,
				inflation-linked and floating-rate indices start later than the rest. A
				level is provisional while its holding period is open and its prices can
				still be restated. Indices are constructed by Safe Rate and are not official
				U.S. Treasury statistics.
			</p>
		</main>
	);
}
