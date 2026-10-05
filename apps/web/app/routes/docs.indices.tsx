import { PRODUCT_NAME, resolveMarketsEnv, SITE_HOSTS } from "@markets/schema";
import {
	INDEX_DISPLAY_ORDER,
	INDEX_META,
	INDEX_SLUG,
} from "@saferate/treasury-client/types";
import type { Route } from "./+types/docs.indices";

export const meta: Route.MetaFunction = () => [
	{ title: `Indices — ${PRODUCT_NAME}` },
];

/**
 * The Indices guide. What each index is comes from the vendored client's
 * INDEX_META, the same source the API's /v1/indices serves, so the docs and the
 * API cannot name an index differently. Methodology is LINKED to the published
 * pages on saferate.com rather than restated here, so there is one version of it.
 *
 * Every claim about dates and units here was checked against production data on
 * 2026-09-28 (apps/api/tests/fixtures), not taken from comments.
 */
export const loader = ({ context }: Route.LoaderArgs) => ({
	api: SITE_HOSTS[resolveMarketsEnv(context.cloudflare.env.MARKETS_ENV)].api,
});

type TMeta = {
	covers: string;
	name: string;
	ticker: string;
	formerTicker?: string;
};

const INDICES = INDEX_DISPLAY_ORDER.map((code) => ({
	code,
	...(INDEX_META as Record<string, TMeta>)[code],
	page: `https://saferate.com/treasury/indices/${INDEX_SLUG[code]}`,
}));

const Code = ({ children }: { children: string }) => (
	<pre className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-relaxed">
		{children}
	</pre>
);

const H2 = ({ children }: { children: React.ReactNode }) => (
	<h2 className="mt-14 text-xl font-semibold tracking-tight text-neutral-900">
		{children}
	</h2>
);

const P = ({ children }: { children: React.ReactNode }) => (
	<p className="mt-3 leading-relaxed text-slate-600">{children}</p>
);

const ENDPOINTS: [string, string][] = [
	["GET /v1/indices", "Every index: latest daily level and last month-end"],
	["GET /v1/indices?date=YYYY-MM-DD", "Every index's daily level on one day"],
	["GET /v1/indices/{code}", "One index"],
	["GET /v1/indices/{code}/levels?from=&to=", "Daily total-return history"],
	["GET /v1/indices/{code}/returns", "Month-, quarter- and year-to-date"],
	["GET /v1/indices/{code}/analytics", "Yield, duration, convexity, key rates"],
	["GET /v1/indices/{code}/constituents", "Current (open-period) holdings"],
	["GET /v1/indices/{code}/constituents/{date}", "A completed month's holdings"],
];

export default function IndicesGuide({ loaderData }: Route.ComponentProps) {
	const { api } = loaderData;
	return (
		<main className="mx-auto max-w-3xl px-6 py-16">
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				<a className="hover:underline" href="/docs">
					Docs
				</a>{" "}
				/ Indices
			</p>
			<h1 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900">
				Treasury indices
			</h1>
			<P>
				Eleven total-return indices of the U.S. Treasury market, valued every
				business day and rebalanced at each month-end. They are constructed by Safe
				Rate from public Treasury data, not official U.S. Treasury statistics.
			</P>

			<H2>The indices</H2>
			<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
				<table className="w-full min-w-xl border-collapse text-sm">
					<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
						<tr>
							<th className="px-4 py-2 font-semibold">Code</th>
							<th className="px-4 py-2 font-semibold">Index</th>
							<th className="px-4 py-2 font-semibold">Covers</th>
							<th className="px-4 py-2 font-semibold">Ticker</th>
						</tr>
					</thead>
					<tbody>
						{INDICES.map((index) => (
							<tr className="border-t border-slate-100" key={index.code}>
								<td className="px-4 py-2 font-mono text-xs">{index.code}</td>
								<td className="px-4 py-2">
									<a
										className="text-primary underline-offset-4 hover:underline"
										href={index.page}
									>
										{index.name}
									</a>
								</td>
								<td className="px-4 py-2 text-slate-600">{index.covers}</td>
								<td className="px-4 py-2 font-mono text-xs text-slate-600">
									{index.ticker}
									{index.formerTicker ? (
										<span className="block text-slate-400">
											formerly {index.formerTicker}
										</span>
									) : null}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<H2>Reading the numbers</H2>
			<P>
				<strong className="text-neutral-900">
					A level is a total return, not a yield.
				</strong>{" "}
				It grows with coupon income and moves inversely with yields, so a rising
				level usually means yields fell. Compare levels as returns: the change from
				one level to another is the return over that span.
			</P>
			<P>
				<strong className="text-neutral-900">Latest versus month-end.</strong>{" "}
				<code className="font-mono text-sm">latest</code> is the most recent
				business day and can be{" "}
				<code className="font-mono text-sm">is_provisional</code> while that day's
				prices may still be revised.{" "}
				<code className="font-mono text-sm">last_month_end</code> is the last
				completed month, which is final. Use month-ends for performance reporting.
			</P>
			<P>
				<strong className="text-neutral-900">Units.</strong> Returns, weights,
				yields and coupon rates are in percent. Convexity follows the
				published-index convention, the textbook quantity divided by 100, so half of
				it approximates the price change in percent for a one-point yield move.
			</P>

			<H2>Dates: two conventions to know</H2>
			<P>
				The portfolio is struck at each month-end and held for the following month.
				Two kinds of data describe the same period from opposite ends:
			</P>
			<ul className="mt-3 list-disc space-y-2 pl-5 text-slate-600 marker:text-primary">
				<li>
					<strong className="text-neutral-900">Analytics</strong> carry{" "}
					<code className="font-mono text-sm">rebalance_date</code>, the period{" "}
					<em>start</em>. Analytics with rebalance_date 2026-08-31 describe the
					portfolio struck on 31 August and held through September.
				</li>
				<li>
					<strong className="text-neutral-900">Completed-period constituents</strong>{" "}
					are addressed by the period <em>end</em>.{" "}
					<code className="font-mono text-sm">/constituents/2026-08-31</code> is the
					portfolio struck at the end of July and held through August, with each
					security's August return.
				</li>
			</ul>
			<P>
				The current month is{" "}
				<code className="font-mono text-sm">/constituents</code> with no date: the
				portfolio struck at the last rebalance, with returns running to{" "}
				<code className="font-mono text-sm">as_of_date</code>.
			</P>

			<H2>Endpoints</H2>
			<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
				<table className="w-full min-w-xl border-collapse text-sm">
					<tbody>
						{ENDPOINTS.map(([route, what]) => (
							<tr className="border-t border-slate-100 first:border-t-0" key={route}>
								<td className="whitespace-nowrap px-4 py-2 font-mono text-xs">
									{route}
								</td>
								<td className="px-4 py-2 text-slate-600">{what}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<Code>{`curl "${api}/v1/indices/broad/levels?from=2026-01-01" \\
  -H "Authorization: Bearer $SAFERATE_MARKETS_KEY"`}</Code>
			<P>
				Every field, type and error is in the generated reference at{" "}
				<a
					className="text-primary underline underline-offset-4"
					href={`${api}/reference`}
				>
					{api}/reference
				</a>
				. Over MCP, the same data is the{" "}
				<code className="font-mono text-sm">get_treasury_index</code> tool.
			</P>

			<H2>Methodology and licensing</H2>
			<P>
				The construction rules, the published history and the per-index pages are on{" "}
				<a
					className="text-primary underline underline-offset-4"
					href="https://saferate.com/treasury/indices"
				>
					saferate.com/treasury/indices
				</a>
				. Benchmarking is free: using an index in your own analysis and client
				reporting, or naming one as a fund's benchmark, a prospectus included. A
				product built to track an index, such as an ETF or index fund, or one whose
				payout references an index level, needs an{" "}
				<a className="text-primary underline underline-offset-4" href="/pricing">
					index license
				</a>
				.
			</P>
		</main>
	);
}
