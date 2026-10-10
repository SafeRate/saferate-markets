import { getAlertPreferences } from "@markets/persistence";
import { PRODUCT_NAME, SITE_HOSTS } from "@markets/schema";
import { data, Link } from "react-router";
import { JsonLd } from "@/components/JsonLd";
import { StrategyDisclaimer } from "@/components/StrategyDisclaimer";
import { rankedAgainst, unrankedCaption } from "@/lib/demandCaption";
import { breadcrumbJsonLd, ORGANIZATION_REF } from "@/lib/jsonLd";
import {
	auctionName,
	billions,
	clearingText,
	longDate,
	pct,
	RUNDOWN_PATH,
	rundownPath,
	rundownSummary,
	shortDate,
	signedBp,
	sinceText,
} from "@/lib/rundownText";
import { getServerSession } from "@/services/auth.server";
import {
	editionOf,
	latestRundownDate,
	loadRundown,
	priceDateFor,
} from "@/services/dailyRundown.server";
import type { Route } from "./+types/daily-rundown.treasury.$date";

/**
 * One business day's Treasury rundown, public: the closing par curve, that
 * day's auction results with demand, and the week's schedule. The email sends
 * the same content and links here (services/dailyRundown.server.ts).
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether the visitor already gets the rundown: a signed-in account with it
 * on and not paused. Anonymous, or any failure, is "not signed in"; this only
 * changes the button, so it must never cost the page.
 */
const readerOf = async (request: Request, env: Env) => {
	try {
		const session = await getServerSession({ env, request });
		if (!session?.user?.id) return "anonymous" as const;
		const p = await getAlertPreferences({ db: env.DB, idUser: session.user.id });
		return p.rundown && !p.paused
			? ("subscribed" as const)
			: ("signedIn" as const);
	} catch {
		return "anonymous" as const;
	}
};

export const loader = async ({
	params,
	context,
	request,
}: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	// The URL carries the edition: the morning the rundown went out.
	const edition = params.date;
	if (!ISO.test(edition)) throw data("Not a date", { status: 404 });
	const [date, latestClose, reader] = await Promise.all([
		priceDateFor(env, edition),
		latestRundownDate(env),
		readerOf(request, env),
	]);
	const latest = latestClose ? editionOf(latestClose) : null;
	const rundown = date === null ? null : await loadRundown(env, date);
	if (rundown === null)
		throw data(
			{ date: edition, latest },
			{
				status: 404,
				// A day not yet published may be published later; never cache it.
				headers: { "Cache-Control": "no-store" },
			},
		);
	return { rundown, latest, reader };
};

export const meta: Route.MetaFunction = ({ data: loaded, params }) => {
	if (!loaded) return [{ title: `Treasury Daily Rundown | ${PRODUCT_NAME}` }];
	const { rundown } = loaded;
	return [
		{
			title: `Treasury Daily Rundown, ${longDate(rundown.edition)}: Yields and Auctions | ${PRODUCT_NAME}`,
		},
		{ name: "description", content: rundownSummary(rundown) },
		{
			tagName: "link",
			rel: "canonical",
			href: `${SITE_HOSTS.production.web}${rundownPath(params.date)}`,
		},
	];
};

const th = "px-3 py-2 text-left font-semibold";

type TChanges = {
	changeBp: number | null;
	weekBp: number | null;
	monthBp: number | null;
};
/** Changes on the day, the week and the month, in both tables. */
const pastRows: [string, (c: TChanges) => string][] = [
	["1 day", (c) => signedBp(c.changeBp)],
	["1 week", (c) => signedBp(c.weekBp)],
	["1 month", (c) => signedBp(c.monthBp)],
];
const td = "px-3 py-2 tabular-nums";

const Verdict = ({
	demand,
}: {
	demand: Route.ComponentProps["loaderData"]["rundown"]["results"][number]["demand"];
}) => {
	if (demand === null) return <span className="text-slate-400">—</span>;
	const caption = unrankedCaption(demand);
	if (caption) return <span className="text-xs text-slate-500">{caption}</span>;
	if (demand.verdict === null) return <span className="text-slate-400">—</span>;
	const tone =
		demand.verdict === "strong"
			? "bg-emerald-50 text-emerald-700"
			: demand.verdict === "weak"
				? "bg-rose-50 text-rose-700"
				: "bg-slate-100 text-slate-600";
	return (
		<>
			<span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
				{demand.verdict}
			</span>
			<span className="ml-2 text-xs text-slate-500">{rankedAgainst(demand)}</span>
		</>
	);
};

export default function DailyRundown({ loaderData }: Route.ComponentProps) {
	const { rundown: r, latest, reader } = loaderData;
	const web = SITE_HOSTS.production.web;
	const path = rundownPath(r.edition);
	return (
		<main className="mx-auto max-w-6xl px-6 py-16">
			<JsonLd
				data={{
					"@context": "https://schema.org",
					"@type": "Report",
					"@id": `${web}${path}#report`,
					url: `${web}${path}`,
					name: `Treasury Daily Rundown, ${longDate(r.edition)}`,
					description: rundownSummary(r),
					datePublished: r.edition,
					publisher: ORGANIZATION_REF,
				}}
			/>
			<JsonLd
				data={breadcrumbJsonLd([
					{ name: PRODUCT_NAME, path: "/" },
					{ name: "Treasury Daily Rundown", path: RUNDOWN_PATH },
					{ name: longDate(r.edition), path },
				])}
			/>
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				Treasury daily rundown
			</p>
			<h1 className="mt-3 text-4xl font-semibold tracking-tight text-neutral-900">
				{longDate(r.edition)}
			</h1>
			<p className="mt-5 max-w-3xl text-lg leading-relaxed text-slate-700">
				{rundownSummary(r)}
			</p>
			<nav className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
				{r.previousEdition ? (
					<Link
						className="text-primary underline underline-offset-4"
						to={rundownPath(r.previousEdition)}
					>
						← {shortDate(r.previousEdition)}
					</Link>
				) : null}
				{latest && latest !== r.edition ? (
					<Link
						className="text-primary underline underline-offset-4"
						to={rundownPath(latest)}
					>
						Latest: {shortDate(latest)} →
					</Link>
				) : null}
			</nav>

			<StrategyDisclaimer
				note={
					reader === "subscribed"
						? "You get this by email"
						: "Free, every business day"
				}
				trackLabel={
					reader === "subscribed" ? "Manage email alerts" : "Get it by email"
				}
				trackTo={
					reader === "anonymous"
						? `/sign-in?next=${encodeURIComponent("/dashboard/alerts")}`
						: "/dashboard/alerts"
				}
			/>

			<section className="mt-12">
				<h2 className="text-xl font-semibold tracking-tight text-neutral-900">
					The curve at the close, {shortDate(r.date)}
				</h2>
				<p className="mt-1 text-sm text-slate-500">
					Safe Rate's fitted Treasury curves. Par yields are bond-equivalent;{" "}
					{sinceText(r)}. Zero and real (TIPS) rates are continuously compounded.
				</p>
				<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
					<table className="w-full min-w-[32rem] text-sm">
						<thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className={th}>Tenor</th>
								{r.tenors.map((t) => (
									<th className={`${th} text-right`} key={t.years}>
										{t.years}y
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							<tr className="border-t border-slate-100">
								<td className={td}>Par yield</td>
								{r.tenors.map((t) => (
									<td className={`${td} text-right font-medium`} key={t.years}>
										{pct(t.parYield)}
									</td>
								))}
							</tr>
							{pastRows.map(([label, pick]) => (
								<tr className="border-t border-slate-100" key={label}>
									<td className={`${td} text-slate-600`}>{label}</td>
									{r.tenors.map((t) => (
										<td className={`${td} text-right text-slate-600`} key={t.years}>
											{pick(t)}
										</td>
									))}
								</tr>
							))}
							<tr className="border-t border-slate-100">
								<td className={td}>Zero</td>
								{r.tenors.map((t) => (
									<td className={`${td} text-right`} key={t.years}>
										{t.zeroRate === null ? "—" : pct(t.zeroRate)}
									</td>
								))}
							</tr>
							<tr className="border-t border-slate-100">
								<td className={td}>Real (TIPS)</td>
								{r.tenors.map((t) => (
									<td className={`${td} text-right`} key={t.years}>
										{t.realRate === null ? "—" : pct(t.realRate)}
									</td>
								))}
							</tr>
						</tbody>
					</table>
				</div>
				<p className="mt-2 text-xs text-slate-500">
					{r.real
						? `Real rates fitted to ${r.real.tipsCount} TIPS; the TIPS curve starts at 2 years.`
						: "The real (TIPS) curve is not available for this date."}
					{r.hasZero ? "" : " The zero curve is not available for this date."}
				</p>
				<ul className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
					{r.spreads.map((s) => (
						<li key={s.name}>
							<Link
								className="font-semibold text-primary underline underline-offset-4"
								to={s.path}
							>
								{s.name}
							</Link>{" "}
							{signedBp(s.bp).replace(/^\+/, "")}{" "}
							<span className="text-slate-500">({signedBp(s.changeBp)})</span>
						</li>
					))}
				</ul>
			</section>

			<section className="mt-12">
				<h2 className="text-xl font-semibold tracking-tight text-neutral-900">
					Money market at the close, {shortDate(r.date)}
				</h2>
				{r.moneyMarket ? (
					<>
						<p className="mt-1 text-sm text-slate-500">
							Under a year, fitted to {r.moneyMarket.billCount} bills,{" "}
							{r.moneyMarket.convention}.
						</p>
						<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
							<table className="w-full min-w-[32rem] text-sm">
								<thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
									<tr>
										<th className={th}>Tenor</th>
										{r.moneyMarket.rates.map((m) => (
											<th className={`${th} text-right`} key={m.label}>
												{m.label}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									<tr className="border-t border-slate-100">
										<td className={td}>Yield</td>
										{r.moneyMarket.rates.map((m) => (
											<td className={`${td} text-right font-medium`} key={m.label}>
												{pct(m.rate)}
											</td>
										))}
									</tr>
									{pastRows.map(([label, pick]) => (
										<tr className="border-t border-slate-100" key={label}>
											<td className={`${td} text-slate-600`}>{label}</td>
											{r.moneyMarket?.rates.map((m) => (
												<td className={`${td} text-right text-slate-600`} key={m.label}>
													{pick(m)}
												</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</>
				) : (
					<p className="mt-3 text-slate-600">
						The money market curve is not available for this date.
					</p>
				)}
			</section>

			<section className="mt-12">
				<h2 className="text-xl font-semibold tracking-tight text-neutral-900">
					Auction results, {shortDate(r.date)}
				</h2>
				{r.results.length === 0 ? (
					<p className="mt-3 text-slate-600">
						No Treasury auction results on {shortDate(r.date)}.
					</p>
				) : (
					<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
						<table className="w-full min-w-[48rem] text-sm">
							<thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
								<tr>
									<th className={th}>Auction</th>
									<th className={th}>Clearing rate</th>
									<th className={`${th} text-right`}>Bid to cover</th>
									<th className={`${th} text-right`}>Indirect</th>
									<th className={`${th} text-right`}>Dealers</th>
									<th className={th}>Demand</th>
								</tr>
							</thead>
							<tbody>
								{r.results.map(({ auction: a, demand }) => (
									<tr className="border-t border-slate-100" key={a.cusip}>
										<td className={td}>
											<div className="font-medium text-neutral-900">{auctionName(a)}</div>
											<div className="text-xs text-slate-500">
												{a.cusip} · {billions(a.offering_amount)}
											</div>
										</td>
										<td className={td}>{clearingText(a)}</td>
										<td className={`${td} text-right`}>
											{a.bid_to_cover_ratio?.toFixed(2) ?? "—"}
										</td>
										<td className={`${td} text-right`}>
											{pct(a.bidders?.indirect_percent ?? null, 1)}
										</td>
										<td className={`${td} text-right`}>
											{pct(a.bidders?.primary_dealer_percent ?? null, 1)}
										</td>
										<td className={td}>
											<Verdict demand={demand} />
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<p className="mt-3 max-w-3xl text-xs text-slate-500">
					Bidder shares are of the competitive award. Demand ranks bid-to-cover,
					indirect share, dealer share and high-less-median against the same term's
					auctions over the window shown, and counts how many sit in the top or
					bottom third.
				</p>
			</section>

			<section className="mt-12">
				<h2 className="text-xl font-semibold tracking-tight text-neutral-900">
					Announced for the next {r.aheadDays} days
				</h2>
				{r.ahead.length === 0 ? (
					<p className="mt-3 text-slate-600">None announced yet.</p>
				) : (
					<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
						<table className="w-full min-w-[32rem] text-sm">
							<thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
								<tr>
									<th className={th}>Date</th>
									<th className={th}>Auction</th>
									<th className={`${th} text-right`}>Offering</th>
								</tr>
							</thead>
							<tbody>
								{r.ahead.map((a) => (
									<tr className="border-t border-slate-100" key={a.cusip}>
										<td className={td}>{shortDate(a.auction_date)}</td>
										<td className={td}>
											{auctionName(a)}
											<span className="ml-2 text-xs text-slate-500">{a.cusip}</span>
										</td>
										<td className={`${td} text-right`}>{billions(a.offering_amount)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>

			<section className="mt-12">
				<h2 className="text-xl font-semibold tracking-tight text-neutral-900">
					Sources
				</h2>
				<p className="mt-3 max-w-3xl text-sm text-slate-600">
					Par yields from Safe Rate's fitted Treasury curve, built from Treasury's
					end-of-day prices (
					<Link
						className="text-primary underline underline-offset-4"
						to="/methodology/treasury-curve"
					>
						methodology
					</Link>
					). Auction results and schedules from the U.S. Treasury. A day's rundown is
					published the next business morning, once its close is in.
				</p>
			</section>
		</main>
	);
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
	const latest =
		error && typeof error === "object" && "data" in error
			? ((error.data as { latest?: string | null })?.latest ?? null)
			: null;
	return (
		<main className="mx-auto max-w-3xl px-6 py-16">
			<h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
				No rundown for this date
			</h1>
			<p className="mt-4 text-slate-600">
				There is a rundown for each business day, published the next business
				morning once that day's close is in. Weekends and market holidays have none.
			</p>
			<p className="mt-4">
				<Link
					className="text-primary underline underline-offset-4"
					to={latest ? rundownPath(latest) : RUNDOWN_PATH}
				>
					See the latest rundown
				</Link>
			</p>
		</main>
	);
}
