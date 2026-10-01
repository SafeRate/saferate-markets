import { PRODUCT_NAME } from "@markets/schema";
import { Form, Link } from "react-router";
import { price } from "@/lib/format";
import { requireOrganization } from "@/lib/session.server";
import { searchSecurities } from "@/services/securitySearch.server";
import type { Route } from "./+types/dashboard.securities";

export const meta: Route.MetaFunction = () => [
	{ title: `Security Lookup — ${PRODUCT_NAME}` },
];

/** Find any Treasury by CUSIP, coupon, maturity or kind; each opens its own page. */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	await requireOrganization(request, env);
	const q = new URL(request.url).searchParams.get("q") ?? "";
	return {
		q,
		results: q.trim().length >= 2 ? await searchSecurities(env, q, 50) : null,
	};
};

export default function SecurityLookup({ loaderData }: Route.ComponentProps) {
	const { q, results } = loaderData;
	return (
		<main className="max-w-5xl">
			<h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
				Security Lookup
			</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				Any U.S. Treasury bill, note, bond, TIPS or floating-rate note: its terms,
				prices, analytics and auction history.
			</p>
			<Form className="mt-4 flex flex-wrap gap-2" method="get">
				<input
					className="w-full max-w-md rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
					defaultValue={q}
					name="q"
					placeholder='A CUSIP, or words: "4.625 2035", "note feb 2030", "tips 2034"'
				/>
				<button
					className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90"
					type="submit"
				>
					Search
				</button>
			</Form>
			{results === null ? (
				<p className="mt-4 text-xs text-slate-500">
					Every word must match: a CUSIP or its start, a coupon (4.625), a maturity
					year (2035) or month (feb), or a kind (bill, note, bond, tips, frn).
				</p>
			) : results.length === 0 ? (
				<p className="mt-6 text-sm text-slate-600">
					Nothing priced today matches "{q}".
				</p>
			) : (
				<section className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
					<table className="w-full text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className="px-3 py-2 font-semibold">Security</th>
								<th className="px-3 py-2 font-semibold">CUSIP</th>
								<th className="px-3 py-2 text-right font-semibold">Close</th>
							</tr>
						</thead>
						<tbody>
							{results.map((r) => (
								<tr className="border-t border-slate-100" key={r.cusip}>
									<td className="px-3 py-2">
										<Link
											className="text-primary underline-offset-4 hover:underline"
											to={`/dashboard/securities/${r.cusip}`}
										>
											{r.label}
										</Link>
									</td>
									<td className="px-3 py-2 font-mono text-xs">{r.cusip}</td>
									<td className="tabular px-3 py-2 text-right">
										{r.close === null ? "—" : price(r.close)}
										{r.closeDate ? (
											<div className="text-[10px] text-slate-400">{r.closeDate}</div>
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			)}
		</main>
	);
}
