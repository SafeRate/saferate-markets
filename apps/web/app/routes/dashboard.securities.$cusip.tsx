import { PRODUCT_NAME } from "@markets/schema";
import {
	getSecurity,
	getSecurityOutstanding,
} from "@saferate/treasury-client/client";
import { data, Link } from "react-router";
import { LineChart } from "@/components/LineChart";
import { describeSecurity, money, price } from "@/lib/format";
import { requireOrganization } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.securities.$cusip";

export const meta: Route.MetaFunction = ({ data: d }) => [
	{ title: `${d?.cusip ?? "Security"} | ${PRODUCT_NAME}` },
];

/**
 * One security: terms, the latest close and analytics for ITS family
 * (nominal yield and key rates; a TIPS's real yield; a floater's discount
 * margin, whose "coupon" is a spread over the index), price and rich/cheap
 * history, every auction of it with who bought it, and the amount outstanding
 * at the statement in force. Convexity arrives divided by 100 from the client,
 * as index providers quote it; DV01 is per 100 of face, shown per $1M.
 */
const RANGES = { "1y": 365, "5y": 1826, all: null } as const;

export const loader = async ({
	request,
	params,
	context,
}: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	await requireOrganization(request, env);
	const cusip = (params.cusip ?? "").toUpperCase();
	if (!/^[0-9A-Z]{9}$/.test(cusip)) throw data("Not a CUSIP.", { status: 404 });
	const security = await getSecurity({ env, cusip });
	if (security === null)
		throw data(`No Treasury security ${cusip}.`, { status: 404 });
	const asked = new URL(request.url).searchParams.get("range") ?? "1y";
	const range = (asked in RANGES ? asked : "1y") as keyof typeof RANGES;
	const days = RANGES[range];
	const end = security.pricedThrough;
	const from =
		days === null || end === null
			? null
			: new Date(Date.parse(`${end}T00:00:00Z`) - days * 86_400_000)
					.toISOString()
					.slice(0, 10);
	const inRange = <T extends { date: string }>(xs: T[]) => {
		const kept = xs.filter((x) => from === null || x.date >= from);
		const step = Math.max(1, Math.floor(kept.length / 260));
		return kept.filter((_, i) => i % step === 0 || i === kept.length - 1);
	};
	const outstanding =
		end === null
			? null
			: await getSecurityOutstanding({ env, cusip, on: end }).catch(() => null);

	const d = security.detail;
	return {
		cusip,
		family: security.family,
		label: describeSecurity({
			couponPercent: d.couponPercent ?? 0,
			maturityDate: d.maturityDate,
			family: security.family,
			spreadPercent: d.spread,
		}),
		terms: {
			type: d.detailSecurityType,
			originalTerm: d.originalSecurityTerm,
			couponPercent: d.couponPercent,
			spreadPercent: d.spread,
			maturityDate: d.maturityDate,
			datedDate: d.datedDate,
			firstInterestPaymentDate: d.firstInterestPaymentDate,
			paymentFrequency: d.paymentFrequency,
			isCallable: d.isCallable,
		},
		range,
		latestPrice: security.latestPrice,
		pricedThrough: security.pricedThrough,
		nominal: security.latestAnalytics,
		tips: security.latestTipsAnalytics,
		frn: security.latestFrnAnalytics,
		analysedThrough:
			security.family === "tips"
				? security.tipsAnalysedThrough
				: security.family === "frn"
					? security.frnAnalysedThrough
					: security.analysedThrough,
		prices: inRange(security.prices).map((p) => ({
			date: p.date,
			value: p.close,
		})),
		// The distance from the family's own curve; a floater has none, so its
		// discount margin over the index takes the place.
		residuals: inRange(
			security.family === "tips"
				? security.tipsAnalytics.map((a) => ({
						date: a.date,
						value: a.residualBasisPoints,
					}))
				: security.family === "frn"
					? security.frnAnalytics.map((a) => ({
							date: a.date,
							value: a.discountMarginBp,
						}))
					: security.analytics.map((a) => ({
							date: a.date,
							value: a.residualBasisPoints,
						})),
		),
		auctions: [...d.auctions].sort((a, b) =>
			b.auctionDate.localeCompare(a.auctionDate),
		),
		outstanding,
		isPriceHistoryTruncated: security.isPriceHistoryTruncated,
	};
};

const Fact = ({ label, value }: { label: string; value: string }) => (
	<div>
		<dt className="text-[11px] uppercase tracking-wide text-slate-500">
			{label}
		</dt>
		<dd className="tabular mt-0.5 text-sm font-medium text-neutral-900">
			{value}
		</dd>
	</div>
);

const th = "px-2.5 py-1.5 font-semibold";
const td = "tabular px-2.5 py-1.5";
const pct = (v: number | null | undefined, digits = 3) =>
	v === null || v === undefined ? "—" : `${v.toFixed(digits)}%`;
const share = (
	part: number | null,
	a: {
		primaryDealerAccepted: number | null;
		directBidderAccepted: number | null;
		indirectBidderAccepted: number | null;
	},
) => {
	const total =
		(a.primaryDealerAccepted ?? Number.NaN) +
		(a.directBidderAccepted ?? Number.NaN) +
		(a.indirectBidderAccepted ?? Number.NaN);
	return part === null || !(total > 0)
		? "—"
		: `${((part / total) * 100).toFixed(1)}%`;
};

export default function SecurityPage({ loaderData }: Route.ComponentProps) {
	const s = loaderData;
	const t = s.terms;
	return (
		<main className="max-w-6xl">
			<p className="text-sm">
				<Link
					className="text-primary underline underline-offset-4"
					to="/dashboard/securities"
				>
					Security Lookup
				</Link>
			</p>
			<h1 className="mt-2 text-3xl font-semibold tracking-tight text-neutral-900">
				{s.label}
			</h1>
			<p className="mt-1 font-mono text-sm text-slate-500">{s.cusip}</p>

			<section className="mt-6 grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-3 lg:grid-cols-6">
				<Fact
					label="Type"
					value={
						s.family === "tips" || s.family === "frn"
							? `${t.type} (${s.family.toUpperCase()})`
							: t.type
					}
				/>
				<Fact label="Original term" value={t.originalTerm} />
				<Fact
					label={s.family === "frn" ? "Spread over index" : "Coupon"}
					value={s.family === "frn" ? pct(t.spreadPercent) : pct(t.couponPercent)}
				/>
				<Fact label="Maturity" value={t.maturityDate} />
				<Fact label="Dated" value={t.datedDate ?? "—"} />
				<Fact label="Pays" value={t.paymentFrequency ?? "—"} />
			</section>

			<section className="mt-4 grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-3 lg:grid-cols-6">
				<Fact
					label={`Close, ${s.pricedThrough ?? "—"}`}
					value={s.latestPrice ? price(s.latestPrice.close) : "—"}
				/>
				{s.family === "tips" && s.tips ? (
					<>
						<Fact label="Real yield" value={pct(s.tips.realYield)} />
						<Fact label="Index ratio" value={s.tips.indexRatio.toFixed(5)} />
						<Fact label="Real duration" value={s.tips.modifiedDuration.toFixed(2)} />
						<Fact
							label="vs real curve"
							value={
								s.tips.residualBasisPoints === null
									? "—"
									: `${s.tips.residualBasisPoints.toFixed(1)} bp`
							}
						/>
						<Fact
							label="z"
							value={
								s.tips.residualZScore === null ? "—" : s.tips.residualZScore.toFixed(2)
							}
						/>
					</>
				) : s.family === "frn" && s.frn ? (
					<>
						<Fact
							label="Discount margin"
							value={`${s.frn.discountMarginBp.toFixed(1)} bp`}
						/>
						<Fact label="Index rate" value={pct(s.frn.indexRatePercent)} />
						<Fact
							label="Spread duration"
							value={s.frn.spreadDurationYears.toFixed(2)}
						/>
						<Fact label="Rate duration" value={s.frn.rateDurationYears.toFixed(4)} />
						<Fact
							label="Margin z"
							value={s.frn.marginZScore === null ? "—" : s.frn.marginZScore.toFixed(2)}
						/>
					</>
				) : s.nominal ? (
					<>
						<Fact label="Yield" value={pct(s.nominal.ytm)} />
						<Fact
							label="Modified duration"
							value={s.nominal.modifiedDuration.toFixed(2)}
						/>
						<Fact label="DV01 per $1M" value={money(s.nominal.dv01 * 10_000)} />
						<Fact
							label="vs curve"
							value={
								s.nominal.residualBasisPoints === null
									? "—"
									: `${s.nominal.residualBasisPoints.toFixed(1)} bp`
							}
						/>
						<Fact
							label="z"
							value={
								s.nominal.residualZScore === null
									? "—"
									: s.nominal.residualZScore.toFixed(2)
							}
						/>
					</>
				) : (
					<Fact label="Analytics" value="None on file" />
				)}
			</section>
			{s.analysedThrough && s.analysedThrough !== s.pricedThrough ? (
				<p className="mt-1 text-xs text-slate-500">
					Analytics run to {s.analysedThrough}; prices to {s.pricedThrough}.
					Analytics stop about three months before maturity.
				</p>
			) : null}

			<div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
				<section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
					<div className="flex items-baseline justify-between">
						<p className="text-xs uppercase tracking-wide text-slate-500">
							Clean price
						</p>
						<div className="flex gap-2 text-xs">
							{(["1y", "5y", "all"] as const).map((r) => (
								<Link
									className={`rounded-full border px-2 py-0.5 ${r === s.range ? "border-primary bg-primary/10 text-primary" : "border-slate-200 text-slate-600"}`}
									key={r}
									to={`?range=${r}`}
								>
									{r === "all" ? "All" : r === "1y" ? "1 year" : "5 years"}
								</Link>
							))}
						</div>
					</div>
					<LineChart
						format={(v) => v.toFixed(2)}
						height={180}
						series={[
							{ label: "Close", className: "stroke-primary", points: s.prices },
						]}
					/>
				</section>
				<section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
					<p className="text-xs uppercase tracking-wide text-slate-500">
						{s.family === "frn"
							? "Discount margin over the index, bp"
							: "Distance from the fitted curve, bp (positive: cheap)"}
					</p>
					<LineChart
						format={(v) => v.toFixed(1)}
						height={180}
						series={[
							{
								label: "Residual",
								className: "stroke-amber-500",
								points: s.residuals,
							},
						]}
					/>
				</section>
			</div>

			{s.family !== "tips" && s.family !== "frn" && s.nominal ? (
				<section className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
					<h2 className="border-b border-slate-100 px-4 py-2.5 font-semibold text-neutral-900">
						Key-rate durations, {s.nominal.date}
					</h2>
					<table className="w-full text-sm">
						<thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
							<tr>
								{s.nominal.keyRateDurations.map((k) => (
									<th className={`${th} text-right`} key={k.label}>
										{k.label}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							<tr>
								{s.nominal.keyRateDurations.map((k) => (
									<td className={`${td} text-right`} key={k.label}>
										{k.value.toFixed(3)}
									</td>
								))}
							</tr>
						</tbody>
					</table>
				</section>
			) : null}

			<section className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
				<h2 className="border-b border-slate-100 px-4 py-2.5 font-semibold text-neutral-900">
					Auctions ({s.auctions.length})
				</h2>
				{s.auctions.length === 0 ? (
					<p className="px-4 py-3 text-sm text-slate-500">No auction on file.</p>
				) : (
					<table className="w-full text-xs">
						<thead className="text-left uppercase tracking-wide text-slate-500">
							<tr>
								<th className={th}>Auctioned</th>
								<th className={th}>Term offered</th>
								<th className={`${th} text-right`}>Offering</th>
								<th className={`${th} text-right`}>High rate</th>
								<th className={`${th} text-right`}>Bid-to-cover</th>
								<th className={`${th} text-right`}>Dealers</th>
								<th className={`${th} text-right`}>Indirect</th>
								<th className={`${th} text-right`}>Direct</th>
							</tr>
						</thead>
						<tbody>
							{s.auctions.map((a) => (
								<tr className="border-t border-slate-100" key={a.auctionDate}>
									<td className={td}>
										{a.auctionDate}
										{a.isReopening ? (
											<span className="ml-1 text-slate-500">reopening</span>
										) : null}
									</td>
									<td className="px-2.5 py-1.5">
										{a.securityTerm ?? a.originalSecurityTerm}
									</td>
									<td className={`${td} text-right`}>
										{a.offeringAmount === null
											? "—"
											: `$${(a.offeringAmount / 1e9).toFixed(1)}B`}
									</td>
									<td className={`${td} text-right`}>
										{s.family === "frn"
											? pct(a.highDiscountMargin)
											: a.highYield === null
												? pct(a.highDiscountRate)
												: pct(a.highYield)}
									</td>
									<td className={`${td} text-right`}>
										{a.bidToCoverRatio?.toFixed(2) ?? "—"}
									</td>
									<td className={`${td} text-right`}>
										{share(a.primaryDealerAccepted, a)}
									</td>
									<td className={`${td} text-right`}>
										{share(a.indirectBidderAccepted, a)}
									</td>
									<td className={`${td} text-right`}>
										{share(a.directBidderAccepted, a)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>

			{s.outstanding ? (
				<p className="mt-4 text-sm text-slate-600">
					Outstanding at the {s.outstanding.recordDate} statement:{" "}
					<span className="tabular font-medium">
						{money(s.outstanding.outstanding)}
					</span>
					{s.outstanding.stripped !== null &&
					s.outstanding.strippedSharePercent !== null
						? `, of which ${money(s.outstanding.stripped)} (${s.outstanding.strippedSharePercent.toFixed(2)}%) is held as STRIPS`
						: ""}
					.
				</p>
			) : null}
			{s.isPriceHistoryTruncated ? (
				<p className="mt-2 text-xs text-amber-700">
					The price history reached the service's 5,000-row ceiling; the oldest days
					may be missing.
				</p>
			) : null}
		</main>
	);
}
