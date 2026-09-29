import {
	getLiabilityStream,
	listLiabilityStreams,
	saveBuilderPlan,
} from "@markets/persistence";
import { STRATEGIES, type TStrategyKey } from "@markets/portfolio";
import { PRODUCT_NAME } from "@markets/schema";
import {
	INDEX_META,
	isIndexCode,
	type TIndexCode,
} from "@saferate/treasury-client/types";
import { Form, Link, redirect, useLocation } from "react-router";
import {
	describeSecurity,
	face,
	money,
	number,
	price,
	rate,
} from "@/lib/format";
import { requireOrganization } from "@/lib/session.server";
import {
	BUILDER_MODES,
	LOT_PRESET_OPTIONS,
	lotsFrom,
	strategyByKey,
	type TBuilderInputs,
	type TBuilderMode,
	type TLotPreset,
	TRACKABLE_INDICES,
} from "@/lib/builderOptions";
import {
	describePlan,
	loadMarket,
	runBuilder,
} from "@/services/builder.server";
import type { Route } from "./+types/dashboard.builder";

export const meta: Route.MetaFunction = () => [
	{ title: `Portfolio Builder — ${PRODUCT_NAME}` },
];

const numberFrom = (raw: string | null, fallback: number | null) => {
	if (raw === null || raw.trim() === "") return fallback;
	const value = Number(raw.replace(/[,$\s]/g, ""));
	return Number.isFinite(value) ? value : fallback;
};

/** The Builder's inputs, from a query string or a form: one reader for both. */
const readInputs = (
	params: URLSearchParams,
): TBuilderInputs & { stream: string | null } => {
	const mode = (BUILDER_MODES.find((m) => m.mode === params.get("mode"))?.mode ??
		"match") as TBuilderMode;
	const strategy = (STRATEGIES.find((s) => s.key === params.get("strategy"))
		?.key ?? "ladder") as TStrategyKey;
	const index = params.get("index") ?? "broad";
	const lotPreset = (LOT_PRESET_OPTIONS.find((o) => o.key === params.get("lots"))
		?.key ?? "retail") as TLotPreset;
	const lots = lotsFrom(lotPreset, {
		increment:
			lotPreset === "custom" ? numberFrom(params.get("increment"), null) : null,
		minimumOrder:
			lotPreset === "custom" ? numberFrom(params.get("minorder"), null) : null,
		minimumPosition: numberFrom(params.get("minpos"), null),
	});
	const rows = (params.get("rows") ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [cusip, amount] = line.split(/[,\t;]\s*(?=[\d$])/);
			return {
				cusip: (cusip ?? "").trim().toUpperCase(),
				faceAmount: numberFrom(amount ?? "", 0) ?? 0,
			};
		})
		.filter((r) => /^[0-9A-Z]{9}$/.test(r.cusip) && r.faceAmount > 0);
	return {
		mode,
		stream: params.get("stream"),
		budget: numberFrom(params.get("budget"), null),
		markupTicks: Math.max(
			0,
			Math.min(64, numberFrom(params.get("ticks"), 4) ?? 4),
		),
		denomination: lots.increment,
		horizonYears: Math.max(
			1,
			Math.min(30, numberFrom(params.get("horizon"), 10) ?? 10),
		),
		strategy,
		indexCode: (isIndexCode(index) && TRACKABLE_INDICES.includes(index)
			? index
			: "broad") as TIndexCode,
		maxPositions: numberFrom(params.get("maxpos"), null),
		rows,
		lotPreset,
		lots,
	};
};

const plan = async (
	env: Env,
	idOrganization: string,
	params: URLSearchParams,
) => {
	const inputs = readInputs(params);
	const stream =
		inputs.stream === null
			? null
			: await getLiabilityStream({
					db: env.DB,
					idOrganization,
					idLiabilityStream: inputs.stream,
				});
	const liabilities = (stream?.cashflows ?? []).map((c) => ({
		date: c.dueDate,
		amount: c.amount,
	}));
	const market = await loadMarket(env, inputs.markupTicks);
	const built = await runBuilder({ env, inputs, liabilities, market });
	return { inputs, stream, market, built };
};

const hasRun = (params: URLSearchParams) => params.get("run") === "1";

export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const org = await requireOrganization(request, env);
	const params = new URL(request.url).searchParams;
	const streams = await listLiabilityStreams({
		db: env.DB,
		idOrganization: org.idOrganization,
	});
	const inputs = readInputs(params);
	if (!hasRun(params)) return { streams, inputs, result: null };
	const { stream, market, built } = await plan(env, org.idOrganization, params);
	return {
		streams,
		inputs,
		result:
			built.status === "planned"
				? {
						status: "planned" as const,
						streamName: stream?.nameLiabilityStream ?? null,
						...describePlan({
							plan: built.plan,
							liabilities: built.liabilities,
							market,
							budget: inputs.budget,
							roundLot: inputs.lots.roundLot,
						}),
					}
				: built.status === "failed"
					? { status: "failed" as const, message: built.message }
					: null,
	};
};

/** Save: re-run the plan server side from the same inputs and store that snapshot. */
export const action = async ({ request, context }: Route.ActionArgs) => {
	const env = context.cloudflare.env;
	const org = await requireOrganization(request, env);
	const form = await request.formData();
	const params = new URLSearchParams(String(form.get("query") ?? ""));
	const { inputs, stream, market, built } = await plan(
		env,
		org.idOrganization,
		params,
	);
	if (built.status !== "planned")
		return {
			error: built.status === "failed" ? built.message : "Nothing to save.",
		};
	const idPlan = await saveBuilderPlan({
		db: env.DB,
		idOrganization: org.idOrganization,
		idUser: org.idUser,
		namePlan: String(form.get("namePlan") ?? "").trim() || built.plan.method,
		method: inputs.mode,
		idLiabilityStream: stream?.idLiabilityStream ?? null,
		asOf: market.asOf,
		settleDate: market.settlementDate,
		inputs: Object.fromEntries(params),
		positions: built.plan.positions.map((p) => ({
			cusip: p.cusip,
			faceAmount: p.faceAmount,
			planPrice: p.security.planPrice,
			dirtyPrice: p.security.dirtyPrice,
			cost: p.cost,
			family: p.security.family,
			couponPercent: p.security.couponPercent,
			maturityDate: p.security.maturityDate,
			close: p.security.price,
		})),
	});
	return redirect(`/dashboard/plans/${idPlan}`);
};

const field =
	"mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm";
const label = "block text-sm font-medium text-slate-700";
const th = "px-3 py-2 font-semibold";
const td = "tabular px-3 py-2";

const Card = ({
	title,
	value,
	hint,
}: {
	title: string;
	value: string;
	hint?: string;
}) => (
	<div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
		<p className="text-xs uppercase tracking-wide text-slate-500">{title}</p>
		<p className="tabular mt-1.5 text-xl font-semibold text-neutral-900">
			{value}
		</p>
		{hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
	</div>
);

const MODE_HELP: Record<TBuilderMode, string> = {
	match:
		"The cheapest set of bills, notes and bonds whose coupons and principal arrive on or before every liability. Exact, with no reinvestment or rate risk for those dates, and usually the most expensive way to fund them.",
	immunise:
		"Match the liabilities' sensitivity to rates rather than their dates: a portfolio with the same value and the same exposure at twelve points on the curve, so a move in rates changes both by the same amount. Far fewer bonds and cheaper than cash-flow matching, but it must be rebalanced as time passes, and very large or oddly shaped moves leave a small mismatch.",
	horizon:
		"Cash-match the liabilities inside the horizon, where timing matters most, and immunise the rest: what most liability managers do.",
	strategy:
		"A rule-based portfolio for an amount to invest. Each comes with its trade-offs below.",
	index:
		"A sparse portfolio, at most fourteen securities, with a Safe Rate index's exposure at every key rate: index-like returns without buying hundreds of bonds.",
	custom:
		"Your own choice of securities and amounts, one per line as CUSIP, face amount. Use the CUSIP search in Portfolio Tracking, or start from a plan and edit it here.",
};

export default function Builder({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const { streams, inputs, result } = loaderData;
	const location = useLocation();
	const query = new URLSearchParams(location.search);
	const modeLink = (mode: TBuilderMode) => {
		const next = new URLSearchParams(query);
		next.set("mode", mode);
		next.delete("run");
		return `?${next.toString()}`;
	};
	const modeInfo = BUILDER_MODES.find((m) => m.mode === inputs.mode);
	const strategy = strategyByKey(inputs.strategy);
	const editLink =
		result?.status === "planned"
			? `?${new URLSearchParams({
					mode: "custom",
					ticks: String(inputs.markupTicks),
					lots: inputs.lotPreset,
					minpos: String(inputs.lots.minimumPosition),
					...(inputs.stream ? { stream: inputs.stream } : {}),
					rows: result.positions
						.map((p) => `${p.cusip}, ${p.faceAmount}`)
						.join("\n"),
				}).toString()}`
			: null;
	return (
		<main className="max-w-6xl">
			<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
				Portfolio Builder
			</h1>
			<p className="mt-2 text-sm text-slate-600">
				Fund a liability stream, follow a strategy, track an index, or build your
				own, from today's Treasury bills, notes and bonds. Save a plan to get its
				order sheet, or turn it into a tracked portfolio.
			</p>

			<nav className="mt-6 flex flex-wrap gap-2">
				{BUILDER_MODES.map((m) => (
					<Link
						className={`rounded-full border px-4 py-1.5 text-sm font-semibold ${m.mode === inputs.mode ? "border-primary bg-primary/10 text-primary" : "border-slate-300 text-slate-600 hover:border-primary/40"}`}
						key={m.mode}
						to={modeLink(m.mode)}
					>
						{m.label}
					</Link>
				))}
			</nav>
			<p className="mt-3 max-w-3xl text-sm text-slate-600">
				{MODE_HELP[inputs.mode]}
			</p>

			<Form
				className="mt-5 grid gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:grid-cols-4"
				method="get"
			>
				<input name="mode" type="hidden" value={inputs.mode} />
				<input name="run" type="hidden" value="1" />
				{modeInfo?.needs === "liabilities" ? (
					<label className={`${label} sm:col-span-2`}>
						Liability stream
						<select
							className={field}
							defaultValue={inputs.stream ?? ""}
							name="stream"
							required
						>
							<option disabled value="">
								Choose a saved stream
							</option>
							{streams.map((s) => (
								<option key={s.idLiabilityStream} value={s.idLiabilityStream}>
									{s.nameLiabilityStream} ({s.countCashflows} payments,{" "}
									{money(s.totalAmount ?? 0)})
								</option>
							))}
						</select>
						<Link
							className="mt-1 inline-block text-xs text-primary underline underline-offset-4"
							to="/dashboard/liabilities"
						>
							{streams.length === 0
								? "Create a liability stream first"
								: "Manage liability streams"}
						</Link>
					</label>
				) : null}
				{modeInfo?.needs === "budget" ? (
					<label className={label}>
						Amount to invest ($)
						<input
							className={field}
							defaultValue={inputs.budget ?? ""}
							inputMode="decimal"
							name="budget"
							placeholder="10,000,000"
							required
						/>
					</label>
				) : null}
				{inputs.mode === "strategy" ? (
					<label className={label}>
						Strategy
						<select className={field} defaultValue={inputs.strategy} name="strategy">
							{STRATEGIES.map((s) => (
								<option key={s.key} value={s.key}>
									{s.name}
								</option>
							))}
						</select>
					</label>
				) : null}
				{inputs.mode === "index" ? (
					<label className={label}>
						Index
						<select className={field} defaultValue={inputs.indexCode} name="index">
							{TRACKABLE_INDICES.map((code) => (
								<option key={code} value={code}>
									{INDEX_META[code].name}
								</option>
							))}
						</select>
					</label>
				) : null}
				{inputs.mode === "horizon" ||
				(inputs.mode === "strategy" &&
					(inputs.strategy === "ladder" || inputs.strategy === "bullet")) ? (
					<label className={label}>
						{inputs.mode === "horizon"
							? "Cash-match the first (years)"
							: inputs.strategy === "bullet"
								? "Target (years)"
								: "Ladder out to (years)"}
						<input
							className={field}
							defaultValue={
								inputs.mode === "horizon" && !query.get("horizon")
									? 5
									: inputs.horizonYears
							}
							max={30}
							min={1}
							name="horizon"
							type="number"
						/>
					</label>
				) : null}
				{inputs.mode === "custom" ? (
					<label className={`${label} sm:col-span-4`}>
						Securities: CUSIP, face amount, one per line
						<textarea
							className={`${field} font-mono`}
							defaultValue={query.get("rows") ?? ""}
							name="rows"
							placeholder={"91282CMM0, 1000000\n912797UJ4, 500000"}
							rows={6}
						/>
					</label>
				) : null}
				{inputs.mode === "custom" ? (
					<label className={`${label} sm:col-span-2`}>
						Liability stream to compare against (optional)
						<select
							className={field}
							defaultValue={inputs.stream ?? ""}
							name="stream"
						>
							<option value="">None</option>
							{streams.map((s) => (
								<option key={s.idLiabilityStream} value={s.idLiabilityStream}>
									{s.nameLiabilityStream}
								</option>
							))}
						</select>
					</label>
				) : null}
				<label className={label}>
					Price markup (32nds)
					<input
						className={field}
						defaultValue={inputs.markupTicks}
						max={64}
						min={0}
						name="ticks"
						type="number"
					/>
				</label>
				<label className={label}>
					Where it will trade
					<select className={field} defaultValue={inputs.lotPreset} name="lots">
						{LOT_PRESET_OPTIONS.map((o) => (
							<option key={o.key} value={o.key}>
								{o.label}
							</option>
						))}
					</select>
				</label>
				<label className={label}>
					Smallest position ($ face)
					<input
						className={field}
						defaultValue={inputs.lots.minimumPosition || ""}
						inputMode="decimal"
						name="minpos"
						placeholder={String(inputs.lots.minimumOrder)}
					/>
				</label>
				{inputs.lotPreset === "custom" ? (
					<>
						<label className={label}>
							Minimum order ($)
							<input
								className={field}
								defaultValue={inputs.lots.minimumOrder}
								inputMode="decimal"
								name="minorder"
							/>
						</label>
						<label className={label}>
							Increment ($)
							<input
								className={field}
								defaultValue={inputs.lots.increment}
								inputMode="decimal"
								name="increment"
							/>
						</label>
					</>
				) : null}
				{inputs.mode === "match" ? (
					<label className={label}>
						At most this many positions (optional)
						<input
							className={field}
							defaultValue={inputs.maxPositions ?? ""}
							min={1}
							name="maxpos"
							type="number"
						/>
					</label>
				) : null}
				<div className="sm:col-span-4">
					<button
						className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
						type="submit"
					>
						Build
					</button>
					<span className="ml-3 text-xs text-slate-500">
						Costed at the latest close plus the markup, standing in for the offer;
						accrued interest to settlement included. Positions under $1 million are
						odd lots: they trade, but institutional prices are quoted for $1 million
						blocks, so allow a wider markup.
					</span>
				</div>
			</Form>

			{inputs.mode === "strategy" && strategy ? (
				<section className="mt-5 grid gap-4 sm:grid-cols-2">
					<div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 text-sm">
						<p className="font-semibold text-emerald-900">{strategy.name}: for</p>
						<p className="mt-1 text-slate-700">{strategy.summary}</p>
						<ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700">
							{strategy.pros.map((p) => (
								<li key={p}>{p}</li>
							))}
						</ul>
					</div>
					<div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 text-sm">
						<p className="font-semibold text-amber-900">Against</p>
						<ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700">
							{strategy.cons.map((c) => (
								<li key={c}>{c}</li>
							))}
						</ul>
					</div>
				</section>
			) : null}

			{result?.status === "failed" ? (
				<p className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
					{result.message}
				</p>
			) : null}

			{result?.status === "planned" ? (
				<>
					<section className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
						<Card
							hint={`${result.positions.length} positions`}
							title="Cost"
							value={money(result.cost)}
						/>
						{result.leftover !== null ? (
							<Card
								hint="left in cash"
								title="Of the budget"
								value={money(result.leftover)}
							/>
						) : result.streamName !== null ? (
							<Card
								hint={result.streamName}
								title="Liabilities"
								value={money(result.byYear.reduce((s, y) => s + y.liabilities, 0))}
							/>
						) : (
							<Card title="Positions" value={String(result.positions.length)} />
						)}
						<Card
							hint="bond-equivalent, on cost"
							title="Yield"
							value={rate(result.yieldPercent, 3)}
						/>
						<Card
							hint="on the fitted curve"
							title="Duration"
							value={`${number(result.duration)} yrs`}
						/>
						<Card title="DV01" value={`${money(result.dv01)}/bp`} />
					</section>
					{result.notes.length > 0 ? (
						<ul className="mt-3 space-y-1 text-sm text-amber-800">
							{result.notes.map((n) => (
								<li key={n}>{n}</li>
							))}
						</ul>
					) : null}

					<section className="mt-8">
						<div className="flex flex-wrap items-baseline justify-between gap-2">
							<h2 className="font-semibold text-neutral-900">{result.method}</h2>
							{editLink ? (
								<Link
									className="text-sm text-primary underline underline-offset-4"
									to={editLink}
								>
									Edit these positions yourself
								</Link>
							) : null}
						</div>
						<div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
							<table className="w-full text-sm">
								<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
									<tr>
										<th className={th}>Security</th>
										<th className={`${th} text-right`}>Face</th>
										<th className={`${th} text-right`}>Close</th>
										<th className={`${th} text-right`}>Limit</th>
										<th className={`${th} text-right`}>Cost</th>
										<th className={th}>TreasuryDirect alternative</th>
									</tr>
								</thead>
								<tbody>
									{result.positions.map((p) => (
										<tr className="border-t border-slate-100" key={p.cusip}>
											<td className="px-3 py-2">
												<span className="font-mono text-xs">{p.cusip}</span>{" "}
												{describeSecurity(p)}
											</td>
											<td className={`${td} text-right`}>
												{face(p.faceAmount)}
												{p.isOddLot ? (
													<span className="block text-[10px] text-amber-700">odd lot</span>
												) : null}
											</td>
											<td className={`${td} text-right text-slate-500`}>
												{price(p.close)}
											</td>
											<td className={`${td} text-right`}>{price(p.planPrice)}</td>
											<td className={`${td} text-right`}>{money(p.cost)}</td>
											<td className="px-3 py-2 text-xs text-slate-600">
												{p.treasuryDirect.isClose
													? `${p.treasuryDirect.term} at its next auction (${p.treasuryDirect.cadence})`
													: "No close auctioned term"}
												{p.treasuryDirect.overLimit
													? " · over the $10m per-auction limit"
													: ""}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</section>

					{result.matching ? (
						<section className="mt-8">
							<h2 className="font-semibold text-neutral-900">
								Each liability, covered
							</h2>
							<div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
								<table className="w-full text-sm">
									<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
										<tr>
											<th className={th}>Due</th>
											<th className={`${th} text-right`}>Amount</th>
											<th className={`${th} text-right`}>Surplus carried</th>
											<th className={`${th} text-right`}>Cost per $1 due</th>
										</tr>
									</thead>
									<tbody>
										{result.matching.surplusByDate.map((r, i) => (
											<tr className="border-t border-slate-100" key={r.date}>
												<td className={td}>{r.date}</td>
												<td className={`${td} text-right`}>{money(r.amount)}</td>
												<td className={`${td} text-right`}>{money(r.surplus)}</td>
												<td className={`${td} text-right`}>
													{number(result.matching?.marginalCostByDate[i]?.perDollar, 4)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							<p className="mt-2 text-xs text-slate-500">
								Money arriving before a liability waits for it, earning nothing
								(conservative). Cost per $1 due is what one more dollar on that date
								would cost today. The best possible cost, ignoring whole-bond rounding,
								is {money(result.matching.relaxationCost)}.
							</p>
						</section>
					) : null}

					{result.immunisation ? (
						<section className="mt-8">
							<h2 className="font-semibold text-neutral-900">Rate exposure matched</h2>
							<ImmunisationTable risk={result.immunisation as TRiskView} />
						</section>
					) : null}

					<section className="mt-8">
						<h2 className="font-semibold text-neutral-900">Cash in, by year</h2>
						<div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
							<table className="w-full text-sm">
								<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
									<tr>
										<th className={th}>Year</th>
										<th className={`${th} text-right`}>Coupons and principal</th>
										<th className={`${th} text-right`}>Liabilities</th>
										<th className={`${th} text-right`}>Net</th>
									</tr>
								</thead>
								<tbody>
									{result.byYear.map((y) => (
										<tr className="border-t border-slate-100" key={y.year}>
											<td className={td}>{y.year}</td>
											<td className={`${td} text-right`}>{money(y.income)}</td>
											<td className={`${td} text-right`}>
												{y.liabilities ? money(y.liabilities) : "—"}
											</td>
											<td
												className={`${td} text-right ${y.income - y.liabilities < 0 ? "text-red-700" : ""}`}
											>
												{money(y.income - y.liabilities)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</section>

					<section className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
						<h2 className="font-semibold text-neutral-900">Save this plan</h2>
						<p className="mt-1 text-sm text-slate-600">
							Saves the positions at today's prices, with an order sheet split between
							TreasuryDirect and the secondary market, which you can download or turn
							into a tracked portfolio.
						</p>
						<Form className="mt-3 flex flex-wrap items-end gap-3" method="post">
							<input name="query" type="hidden" value={query.toString()} />
							<label className={label}>
								Name
								<input
									className={field}
									defaultValue={result.method}
									maxLength={120}
									name="namePlan"
								/>
							</label>
							<button
								className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
								type="submit"
							>
								Save plan
							</button>
							{actionData?.error ? (
								<p className="text-sm text-red-700">{actionData.error}</p>
							) : null}
						</Form>
					</section>
				</>
			) : null}
		</main>
	);
}

type TRiskView = {
	targetPresentValue: number;
	targetKeyRateDurations: number[];
	achievedKeyRateDurations: number[];
	residualDv01: number[];
	durationResidual: number;
};

const KR_LABELS = [
	"3M",
	"6M",
	"1Y",
	"2Y",
	"3Y",
	"5Y",
	"7Y",
	"10Y",
	"15Y",
	"20Y",
	"25Y",
	"30Y",
];

const ImmunisationTable = ({ risk }: { risk: TRiskView }) => (
	<>
		<div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
			<table className="w-full text-sm">
				<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
					<tr>
						<th className={th}>Key rate</th>
						{KR_LABELS.map((l) => (
							<th className={`${th} text-right`} key={l}>
								{l}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					<tr className="border-t border-slate-100">
						<td className="px-3 py-2">Target duration</td>
						{risk.targetKeyRateDurations.map((d, i) => (
							<td className={`${td} text-right`} key={KR_LABELS[i]}>
								{number(d, 2)}
							</td>
						))}
					</tr>
					<tr className="border-t border-slate-100">
						<td className="px-3 py-2">Portfolio</td>
						{risk.achievedKeyRateDurations.map((d, i) => (
							<td className={`${td} text-right`} key={KR_LABELS[i]}>
								{number(d, 2)}
							</td>
						))}
					</tr>
					<tr className="border-t border-slate-100">
						<td className="px-3 py-2">Unhedged $/bp</td>
						{risk.residualDv01.map((d, i) => (
							<td
								className={`${td} text-right ${Math.abs(d) > 1 ? "text-amber-700" : "text-slate-500"}`}
								key={KR_LABELS[i]}
							>
								{money(d)}
							</td>
						))}
					</tr>
				</tbody>
			</table>
		</div>
		<p className="mt-2 text-xs text-slate-500">
			Target present value {money(risk.targetPresentValue)}. Total duration matched
			to within {number(Math.abs(risk.durationResidual), 3)} years; what is left
			over at each key rate is shown in dollars per basis point. Rebalance as time
			passes and durations drift.
		</p>
	</>
);
