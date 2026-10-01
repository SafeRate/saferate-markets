import { PRODUCT_NAME } from "@markets/schema";
import { Link } from "react-router";
import { LineChart } from "@/components/LineChart";
import { number, percent, rate, signClass } from "@/lib/format";
import { requireOrganization } from "@/lib/session.server";
import {
	bidderShares,
	clearingRate,
	loadAuctions,
	type TAuction,
} from "@/services/auctions.server";
import type { Route } from "./+types/dashboard.auctions";

export const meta: Route.MetaFunction = () => [
	{ title: `Treasury Auctions — ${PRODUCT_NAME}` },
];

/**
 * Auction results by term: the latest of each against that term's recent
 * record, what has been auctioned and not yet settled, what is announced, and
 * one term's history. From services/auctions.server.ts, which says what the
 * treasury service cannot yet show.
 */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	await requireOrganization(request, env);
	const loaded = await loadAuctions(env);
	const asked = new URL(request.url).searchParams.get("term");
	const selected =
		loaded.terms.find((t) => t.key === asked)?.key ??
		loaded.terms.find((t) => t.key === "Note 10-Year")?.key ??
		loaded.terms[0]?.key ??
		null;
	const describe = (a: TAuction) => ({
		...a,
		rate: clearingRate(a),
		shares: bidderShares(a),
	});
	return {
		on: loaded.on,
		terms: loaded.terms,
		latestByTerm: loaded.latestByTerm.map((row) => ({
			...row,
			auction: describe(row.auction),
		})),
		announced: loaded.announced.map(describe),
		settling: loaded.settling.map(describe),
		selected,
		history: selected === null ? [] : loaded.historyOf(selected).map(describe),
	};
};

type TLoader = Route.ComponentProps["loaderData"];
type TShown = TLoader["history"][number];

const th = "px-3 py-2 font-semibold";
const td = "tabular px-3 py-2";

const billions = (value: number | null) =>
	value === null ? "—" : `$${(value / 1e9).toFixed(value >= 1e10 ? 0 : 1)}B`;

const shortDate = (iso: string) => {
	const d = new Date(`${iso}T00:00:00Z`);
	return d.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
};

/** Signed, with no sign on a figure that rounds to zero ("0.00", not "−0.00"). */
const signed = (value: number | null, format: (v: number) => string) => {
	if (value === null) return "—";
	const text = format(Math.abs(value));
	if (Number(text.replace(/[^0-9.]/g, "")) === 0) return text;
	return `${value > 0 ? "+" : "−"}${text}`;
};

const security = (a: TShown) =>
	a.kind === "Bill"
		? `Bill due ${shortDate(a.maturityDate)}`
		: a.kind === "FRN"
			? `FRN ${shortDate(a.maturityDate)}${a.spreadPercent === null ? "" : `, index + ${a.spreadPercent}%`}`
			: `${a.couponPercent === null ? "" : `${a.couponPercent}% `}${shortDate(a.maturityDate)}`;

const Rate = ({ a }: { a: TShown }) => (
	<>
		{a.rate.value === null ? "—" : rate(a.rate.value)}
		<span className="ml-1 text-xs text-slate-500">{a.rate.label}</span>
	</>
);

const Section = ({
	title,
	children,
	note,
}: {
	title: string;
	children: React.ReactNode;
	note?: React.ReactNode;
}) => (
	<section className="mt-8">
		<h2 className="font-semibold text-neutral-900">{title}</h2>
		<div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
			{children}
		</div>
		{note ? <p className="mt-2 text-xs text-slate-500">{note}</p> : null}
	</section>
);

const Pending = ({
	rows,
	when,
}: {
	rows: TShown[];
	when: "auction" | "settle";
}) => (
	<table className="w-full text-sm">
		<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
			<tr>
				<th className={th}>Term</th>
				<th className={th}>Security</th>
				<th className={th}>{when === "auction" ? "Auction" : "Auctioned"}</th>
				<th className={th}>Settles</th>
				<th className={`${th} text-right`}>Offering</th>
				{when === "settle" ? (
					<th className={`${th} text-right`}>Cleared at</th>
				) : null}
			</tr>
		</thead>
		<tbody>
			{rows.map((a) => (
				<tr
					className="border-t border-slate-100"
					key={`${a.cusip}${a.auctionDate}`}
				>
					<td className="px-3 py-2">
						{a.kind} {a.kind === "Bill" ? (a.securityTerm ?? a.term) : a.term}
						{a.isReopening && a.kind !== "Bill" ? (
							<span className="ml-1 text-xs text-slate-500">reopening</span>
						) : null}
					</td>
					<td className="px-3 py-2">
						{security(a)} <span className="text-xs text-slate-500">{a.cusip}</span>
					</td>
					<td className={td}>{shortDate(a.auctionDate)}</td>
					<td className={td}>{shortDate(a.issueDate)}</td>
					<td className={`${td} text-right`}>{billions(a.offeringAmount)}</td>
					{when === "settle" ? (
						<td className={`${td} text-right`}>
							<Rate a={a} />
						</td>
					) : null}
				</tr>
			))}
		</tbody>
	</table>
);

export default function Auctions({ loaderData }: Route.ComponentProps) {
	const d = loaderData;
	const history = [...d.history].reverse();
	return (
		<main className="max-w-6xl">
			<h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
				Treasury Auctions
			</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				Results as Treasury publishes them, for each term Safe Rate tracks, as of{" "}
				{shortDate(d.on)}.
			</p>

			{d.announced.length > 0 ? (
				<Section
					note="Reopenings of securities already outstanding, announced and not yet held."
					title="Announced"
				>
					<Pending rows={d.announced} when="auction" />
				</Section>
			) : null}

			{d.settling.length > 0 ? (
				<Section title="Auctioned, not yet settled">
					<Pending rows={d.settling} when="settle" />
				</Section>
			) : null}

			<Section
				note={
					<>
						Bidder shares are of the competitive award: dealers, direct and indirect
						bidders, leaving out the Fed's SOMA rollover and non-competitive bids,
						which do not bid on price. Changes are against the average of that term's
						previous six auctions. Dealers take what others do not, so a higher dealer
						share is weaker demand at the price; indirect bidders are the usual proxy
						for foreign and real-money buyers. High less median is how far the stop
						sat above the middle of the accepted bids; it is not the tail, which is
						measured against the when-issued yield Safe Rate does not hold.
					</>
				}
				title="Latest result, by term"
			>
				<table className="w-full text-sm">
					<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
						<tr>
							<th className={th}>Term</th>
							<th className={th}>Auctioned</th>
							<th className={`${th} text-right`}>Offering</th>
							<th className={`${th} text-right`}>Cleared at</th>
							<th className={`${th} text-right`}>High less median</th>
							<th className={`${th} text-right`}>Bid-to-cover</th>
							<th className={`${th} text-right`}>Dealers</th>
							<th className={`${th} text-right`}>Indirect</th>
							<th className={`${th} text-right`}>Direct</th>
						</tr>
					</thead>
					<tbody>
						{d.latestByTerm.map((row) => {
							const a = row.auction;
							return (
								<tr className="border-t border-slate-100" key={row.key}>
									<td className="px-3 py-2">
										<Link
											className="font-medium text-primary underline-offset-4 hover:underline"
											to={`?term=${encodeURIComponent(row.key)}`}
										>
											{row.key}
										</Link>
										{a.isReopening && a.kind !== "Bill" ? (
											<span className="ml-1 text-xs text-slate-500">reopening</span>
										) : null}
										<div className="text-xs text-slate-500">
											{security(a)} · {a.cusip}
										</div>
									</td>
									<td className={td}>{shortDate(a.auctionDate)}</td>
									<td className={`${td} text-right`}>{billions(a.offeringAmount)}</td>
									<td className={`${td} text-right`}>
										<Rate a={a} />
									</td>
									<td className={`${td} text-right`}>
										{row.highLessMedianBp === null
											? "—"
											: `${row.highLessMedianBp.toFixed(1)} bp`}
									</td>
									<td className={`${td} text-right`}>
										{number(a.bidToCoverRatio)}
										<div className={`text-xs ${signClass(row.coverVsPrior)}`}>
											{signed(row.coverVsPrior, (v) => v.toFixed(2))}
										</div>
									</td>
									<td className={`${td} text-right`}>
										{percent(a.shares?.dealers ?? null, 1)}
										<div className={`text-xs ${signClass(-(row.dealersVsPrior ?? 0))}`}>
											{signed(row.dealersVsPrior, (v) => `${(v * 100).toFixed(1)} pt`)}
										</div>
									</td>
									<td className={`${td} text-right`}>
										{percent(a.shares?.indirect ?? null, 1)}
									</td>
									<td className={`${td} text-right`}>
										{percent(a.shares?.direct ?? null, 1)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</Section>

			{d.selected !== null ? (
				<section className="mt-10">
					<div className="flex flex-wrap items-baseline justify-between gap-3">
						<h2 className="font-semibold text-neutral-900">History: {d.selected}</h2>
						<div className="flex flex-wrap gap-2 text-xs">
							{d.terms.map((t) => (
								<Link
									className={`rounded-full border px-2.5 py-1 ${
										t.key === d.selected
											? "border-primary bg-primary/10 text-primary"
											: "border-slate-200 text-slate-600 hover:border-slate-400"
									}`}
									key={t.key}
									to={`?term=${encodeURIComponent(t.key)}`}
								>
									{t.key}
								</Link>
							))}
						</div>
					</div>
					<div className="mt-3 grid gap-4 lg:grid-cols-2">
						<div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
							<p className="text-xs uppercase tracking-wide text-slate-500">
								Bid-to-cover
							</p>
							<LineChart
								format={(v) => v.toFixed(2)}
								height={160}
								series={[
									{
										label: "Bid-to-cover",
										className: "stroke-primary",
										points: history.map((a) => ({
											date: a.auctionDate,
											value: a.bidToCoverRatio,
										})),
									},
								]}
							/>
						</div>
						<div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
							<p className="text-xs uppercase tracking-wide text-slate-500">
								Dealers and indirect bidders, share of the competitive award
							</p>
							<LineChart
								format={(v) => `${(v * 100).toFixed(0)}%`}
								height={160}
								series={[
									{
										label: "Indirect",
										className: "stroke-primary",
										points: history.map((a) => ({
											date: a.auctionDate,
											value: a.shares?.indirect ?? null,
										})),
									},
									{
										label: "Dealers",
										className: "stroke-slate-400",
										points: history.map((a) => ({
											date: a.auctionDate,
											value: a.shares?.dealers ?? null,
										})),
									},
								]}
							/>
						</div>
					</div>
					<div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
						<table className="w-full text-sm">
							<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
								<tr>
									<th className={th}>Auctioned</th>
									<th className={th}>Security</th>
									<th className={`${th} text-right`}>Offering</th>
									<th className={`${th} text-right`}>Tendered</th>
									<th className={`${th} text-right`}>Cleared at</th>
									<th className={`${th} text-right`}>Bid-to-cover</th>
									<th className={`${th} text-right`}>Dealers</th>
									<th className={`${th} text-right`}>Indirect</th>
									<th className={`${th} text-right`}>Direct</th>
									<th className={`${th} text-right`}>SOMA</th>
									<th className={`${th} text-right`}>At the stop</th>
								</tr>
							</thead>
							<tbody>
								{d.history.map((a) => (
									<tr
										className="border-t border-slate-100"
										key={`${a.cusip}${a.auctionDate}`}
									>
										<td className={td}>
											{shortDate(a.auctionDate)}
											{a.isReopening && a.kind !== "Bill" ? (
												<span className="ml-1 text-xs text-slate-500">reopening</span>
											) : null}
										</td>
										<td className="px-3 py-2">
											{security(a)}{" "}
											<span className="text-xs text-slate-500">{a.cusip}</span>
										</td>
										<td className={`${td} text-right`}>{billions(a.offeringAmount)}</td>
										<td className={`${td} text-right`}>{billions(a.totalTendered)}</td>
										<td className={`${td} text-right`}>
											<Rate a={a} />
										</td>
										<td className={`${td} text-right`}>{number(a.bidToCoverRatio)}</td>
										<td className={`${td} text-right`}>
											{percent(a.shares?.dealers ?? null, 1)}
										</td>
										<td className={`${td} text-right`}>
											{percent(a.shares?.indirect ?? null, 1)}
										</td>
										<td className={`${td} text-right`}>
											{percent(a.shares?.direct ?? null, 1)}
										</td>
										<td className={`${td} text-right`}>{billions(a.somaAccepted)}</td>
										<td className={`${td} text-right`}>
											{a.allocationPercentage === null
												? "—"
												: `${a.allocationPercentage.toFixed(1)}%`}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<p className="mt-2 text-xs text-slate-500">
						At the stop: the share of bids at the highest accepted rate that were
						filled. Low means the stop was crowded.
					</p>
				</section>
			) : null}

			<p className="mt-10 rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
				Not shown yet: a new security's auction before the day it is held (Treasury
				announces each 1 to 8 days ahead), and any short bill that is not a
				reopening of a 17-, 26- or 52-week bill. Both need a read of auctions by
				date from Safe Rate's treasury service, which is planned. Reopenings of
				securities already outstanding appear as soon as they are announced. Bills
				are grouped by the term offered, so a 4-week reopening of a 17-week bill is
				a 4-week auction.
			</p>
		</main>
	);
}
