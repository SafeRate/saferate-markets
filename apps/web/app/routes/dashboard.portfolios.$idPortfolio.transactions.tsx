import {
	addTransactions,
	deleteImport,
	deletePortfolio,
	deleteTransaction,
	getPortfolio,
	listTransactions,
	type TNewTransaction,
	updatePortfolio,
	MAX_TRANSACTIONS_PER_ADD,
} from "@markets/persistence";
import {
	parseDate,
	parsePrice,
	parseTradesCsv,
	settlementFor,
} from "@markets/portfolio";
import { PRODUCT_NAME } from "@markets/schema";
import { useEffect, useState } from "react";
import {
	data,
	Form,
	Link,
	redirect,
	useFetcher,
	useNavigation,
} from "react-router";
import { describeSecurity, face, price } from "@/lib/format";
import {
	BENCHMARK_OPTIONS,
	INCOME_OPTIONS,
	parseBenchmark,
	parsePolicy,
} from "@/lib/portfolioOptions";
import { useIsDemo, WriteGate } from "@/components/WriteGate";
import { requireDashboard } from "@/lib/session.server";
import { loadSecurities, validateNewTrades } from "@/services/portfolio.server";
import { freeValueLimitProblem } from "@/services/freeTier.server";
import type { Route } from "./+types/dashboard.portfolios.$idPortfolio.transactions";

export const meta: Route.MetaFunction = () => [
	{ title: `Trades | ${PRODUCT_NAME}` },
];

const MAX_CSV_BYTES = 1_000_000;

const loadPortfolio = async (
	request: Request,
	env: Env,
	idPortfolio: string,
) => {
	const org = await requireDashboard(request, env);
	const portfolio = await getPortfolio({
		db: env.DB,
		idOrganization: org.idOrganization,
		idPortfolio,
	});
	if (portfolio === null) throw data("No such portfolio.", { status: 404 });
	return { org, portfolio };
};

export const loader = async ({
	request,
	context,
	params,
}: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const { org, portfolio } = await loadPortfolio(
		request,
		env,
		params.idPortfolio,
	);
	const transactions = await listTransactions({
		db: env.DB,
		idOrganization: org.idOrganization,
		idPortfolio: portfolio.idPortfolio,
	});
	const { info } =
		transactions.length === 0
			? { info: new Map() }
			: await loadSecurities(
					env,
					transactions.map((t) => t.cusip),
				);
	return {
		portfolio,
		transactions: transactions.map((t) => ({
			...t,
			label: describeSecurity(info.get(t.cusip) ?? null),
		})),
	};
};

type TActionResult =
	| { intent: string; ok: true; message: string }
	| {
			intent: string;
			ok: false;
			errors: string[];
			/** Trades already in the portfolio: the import form then offers "Import anyway". */
			duplicates?: number;
	  };

export const action = async ({
	request,
	context,
	params,
}: Route.ActionArgs): Promise<TActionResult | Response> => {
	const env = context.cloudflare.env;
	const { org, portfolio } = await loadPortfolio(
		request,
		env,
		params.idPortfolio,
	);
	const scope = {
		db: env.DB,
		idOrganization: org.idOrganization,
		idPortfolio: portfolio.idPortfolio,
	};
	const form = await request.formData();
	const intent = String(form.get("intent") ?? "");

	const store = async (
		incoming: (TNewTransaction & { label: string })[],
		source: "manual" | "csv",
	) => {
		const existing = await listTransactions(scope);
		const problems = await validateNewTrades({ env, existing, incoming });
		if (problems.length > 0)
			return { intent, ok: false as const, errors: problems };
		if (org.tier === "free") {
			const problem = await freeValueLimitProblem({
				env,
				idOrganization: org.idOrganization,
				idPortfolio: portfolio.idPortfolio,
				incoming: incoming.map(({ label: _label, ...t }) => t),
			});
			if (problem) return { intent, ok: false as const, errors: [problem] };
		}
		const stored = await addTransactions({
			...scope,
			idUser: org.idUser,
			source,
			transactions: incoming.map(({ label: _label, ...t }) => t),
		});
		return {
			intent,
			ok: true as const,
			message: `${stored?.count ?? 0} trade${stored?.count === 1 ? "" : "s"} added.`,
		};
	};

	if (intent === "add") {
		const errors: string[] = [];
		const cusip = String(form.get("cusip") ?? "")
			.trim()
			.toUpperCase();
		if (!/^[0-9A-Z]{9}$/.test(cusip))
			errors.push("Choose a security: a CUSIP is nine letters and digits.");
		const side = String(form.get("side")) === "sell" ? "sell" : "buy";
		const tradeDate = parseDate(String(form.get("tradeDate") ?? ""));
		if (tradeDate === null) errors.push("Trade date is required.");
		const settleRaw = String(form.get("settleDate") ?? "").trim();
		const settleDate =
			settleRaw === ""
				? tradeDate === null
					? null
					: settlementFor(tradeDate)
				: parseDate(settleRaw);
		if (settleDate === null && tradeDate !== null)
			errors.push("Settlement date is not a date.");
		const faceAmount = Number(
			String(form.get("faceAmount") ?? "").replace(/[,$\s]/g, ""),
		);
		if (!(faceAmount > 0))
			errors.push("Face amount must be a positive number of dollars.");
		const cleanPrice = parsePrice(String(form.get("cleanPrice") ?? ""));
		if (cleanPrice === null)
			errors.push(
				"Price is per 100 of face, as a decimal (96.53125) or in 32nds (96-17).",
			);
		const account = String(form.get("account") ?? "").trim();
		if (
			errors.length > 0 ||
			tradeDate === null ||
			settleDate === null ||
			cleanPrice === null
		)
			return { intent, ok: false, errors };
		return store(
			[
				{
					cusip,
					side,
					tradeDate,
					settleDate,
					faceAmount,
					cleanPrice,
					account: account === "" ? null : account,
					label: `${side} ${cusip} on ${tradeDate}`,
				},
			],
			"manual",
		);
	}

	if (intent === "import") {
		const file = form.get("file");
		if (!(file instanceof File) || file.size === 0)
			return { intent, ok: false, errors: ["Choose a CSV file."] };
		if (file.size > MAX_CSV_BYTES)
			return {
				intent,
				ok: false,
				errors: [
					`The file is over ${MAX_CSV_BYTES / 1_000_000} MB. Split it and import the parts.`,
				],
			};
		const parsed = parseTradesCsv(await file.text());
		if (!parsed.ok)
			return {
				intent,
				ok: false,
				errors: parsed.errors.map((e) =>
					e.line === null ? e.message : `Line ${e.line}: ${e.message}`,
				),
			};
		// The same file imported twice doubles every position, silently. Found
		// 2026-09-29 by the break tests. Identical trades can be real (two
		// tickets, same day, same price), so this asks rather than refuses.
		const same = (t: {
			cusip: string;
			side: string;
			tradeDate: string;
			faceAmount: number;
			cleanPrice: number;
		}) => `${t.cusip}|${t.side}|${t.tradeDate}|${t.faceAmount}|${t.cleanPrice}`;
		const held = new Set((await listTransactions(scope)).map(same));
		const repeated = parsed.trades.filter((t) => held.has(same(t)));
		if (repeated.length > 0 && form.get("allowDuplicates") !== "yes") {
			const first = repeated[0];
			return {
				intent,
				ok: false,
				duplicates: repeated.length,
				errors: [
					`${repeated.length.toLocaleString("en-US")} of this file's ${parsed.trades.length.toLocaleString("en-US")} trades ${repeated.length === 1 ? "is" : "are"} already in this portfolio, with the same CUSIP, side, trade date, face and price (line ${first.line}: ${first.side} ${first.faceAmount.toLocaleString("en-US")} ${first.cusip} on ${first.tradeDate}). Nothing was imported. If the file was imported before, there is nothing to do; if these are new trades, tick "Import anyway" and import it again.`,
				],
			};
		}
		if (parsed.trades.length > MAX_TRANSACTIONS_PER_ADD)
			return {
				intent,
				ok: false,
				errors: [
					`The file has ${parsed.trades.length.toLocaleString("en-US")} trades; one import takes at most ${MAX_TRANSACTIONS_PER_ADD.toLocaleString("en-US")}. Split it and import the parts.`,
				],
			};
		const result = await store(
			parsed.trades.map(({ line, ...t }) => ({ ...t, label: `Line ${line}` })),
			"csv",
		);
		if (!result.ok) return result;
		const read = Object.entries(parsed.mapping)
			.map(([field, header]) => `${field} ← "${header}"`)
			.join(", ");
		return {
			...result,
			message: `${result.message} Columns read: ${read}.${parsed.skippedMaturities > 0 ? ` ${parsed.skippedMaturities} maturity row${parsed.skippedMaturities === 1 ? "" : "s"} skipped: redemption is computed.` : ""}`,
		};
	}

	if (intent === "delete") {
		await deleteTransaction({
			...scope,
			idTransaction: String(form.get("idTransaction") ?? ""),
		});
		return { intent, ok: true, message: "Trade deleted." };
	}

	if (intent === "undoImport") {
		const removed = await deleteImport({
			...scope,
			idImport: String(form.get("idImport") ?? ""),
		});
		return {
			intent,
			ok: true,
			message: `Import undone: ${removed} trade${removed === 1 ? "" : "s"} removed.`,
		};
	}

	if (intent === "settings") {
		const namePortfolio = String(form.get("namePortfolio") ?? "").trim();
		if (namePortfolio === "")
			return { intent, ok: false, errors: ["Give the portfolio a name."] };
		await updatePortfolio({
			...scope,
			namePortfolio,
			codeBenchmark: parseBenchmark(form.get("codeBenchmark")),
			policyIncome: parsePolicy(form.get("policyIncome")),
		});
		return { intent, ok: true, message: "Settings saved." };
	}

	if (intent === "deletePortfolio") {
		if (String(form.get("confirmName") ?? "").trim() !== portfolio.namePortfolio)
			return {
				intent,
				ok: false,
				errors: ["Type the portfolio's name exactly to delete it."],
			};
		await deletePortfolio(scope);
		return redirect("/dashboard/portfolios");
	}

	return { intent, ok: false, errors: ["Unknown action."] };
};

const field =
	"mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm";
const button =
	"rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60";

const Outcome = ({
	result,
	intent,
}: {
	result: TActionResult | undefined;
	intent: string;
}) => {
	if (result === undefined || result.intent !== intent) return null;
	return result.ok ? (
		<p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
			{result.message}
		</p>
	) : (
		<ul className="mt-3 space-y-1 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
			{result.errors.map((e) => (
				<li key={e}>{e}</li>
			))}
		</ul>
	);
};

type TSearchResult = {
	cusip: string;
	label: string;
	close: number | null;
	closeDate: string | null;
};

/** CUSIP search: type a CUSIP, coupon, maturity year or kind, pick a match. */
const SecurityPicker = () => {
	const search = useFetcher<{ results: TSearchResult[] }>();
	const [query, setQuery] = useState("");
	const [chosen, setChosen] = useState<TSearchResult | null>(null);
	useEffect(() => {
		if (chosen !== null || query.trim().length < 2) return;
		const timer = setTimeout(
			() =>
				search.load(`/dashboard/securities/search?q=${encodeURIComponent(query)}`),
			250,
		);
		return () => clearTimeout(timer);
	}, [query, chosen]);
	const results = chosen === null ? (search.data?.results ?? []) : [];
	return (
		<div className="relative sm:col-span-2">
			<label className="text-sm font-medium text-slate-700">
				Security
				<input
					autoComplete="off"
					className={field}
					onChange={(e) => {
						setQuery(e.target.value);
						setChosen(null);
					}}
					placeholder="CUSIP, or e.g. 4.625 2035, note feb 2035"
					value={chosen === null ? query : `${chosen.cusip}  ${chosen.label}`}
				/>
			</label>
			<input
				name="cusip"
				type="hidden"
				value={
					chosen?.cusip ??
					(/^[0-9A-Za-z]{9}$/.test(query.trim()) ? query.trim() : "")
				}
			/>
			{results.length > 0 ? (
				<ul className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-slate-200 bg-white text-sm shadow-lg">
					{results.map((r) => (
						<li key={r.cusip}>
							<button
								className="flex w-full justify-between gap-4 px-3 py-2 text-left hover:bg-slate-50"
								onClick={() => setChosen(r)}
								type="button"
							>
								<span>
									<span className="font-mono text-xs">{r.cusip}</span> {r.label}
								</span>
								{r.close !== null ? (
									<span className="tabular text-slate-500">
										{price(r.close)} on {r.closeDate}
									</span>
								) : null}
							</button>
						</li>
					))}
				</ul>
			) : null}
			{chosen?.close ? (
				<p className="mt-1 text-xs text-slate-500">
					Latest close {price(chosen.close)} ({chosen.closeDate}).
				</p>
			) : null}
		</div>
	);
};

export default function Transactions({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const { portfolio, transactions } = loaderData;
	const isDemo = useIsDemo();
	const busy = useNavigation().state !== "idle";
	const imports = [
		...new Set(
			transactions
				.map((t) => t.idImport)
				.filter((id): id is string => id !== null),
		),
	];
	return (
		<main className="max-w-5xl">
			<p className="text-sm">
				<Link
					className="text-primary underline-offset-4 hover:underline"
					to={`/dashboard/portfolios/${portfolio.idPortfolio}`}
				>
					← {portfolio.namePortfolio}
				</Link>
			</p>
			<h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900">
				Trades
			</h1>
			<p className="mt-2 text-sm text-slate-600">
				Buys and sells only: coupons and maturities are computed from each
				security's terms. Prices are clean, per 100 of face; settlement defaults to
				the next business day.
			</p>

			<WriteGate to="add or import your own trades">
				<section className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
					<h2 className="font-semibold text-neutral-900">Add a trade</h2>
					<Form className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-4" method="post">
						<input name="intent" type="hidden" value="add" />
						<SecurityPicker />
						<label className="text-sm font-medium text-slate-700">
							Side
							<select className={field} name="side">
								<option value="buy">Buy</option>
								<option value="sell">Sell</option>
							</select>
						</label>
						<label className="text-sm font-medium text-slate-700">
							Face amount ($)
							<input
								className={field}
								inputMode="decimal"
								name="faceAmount"
								placeholder="1,000,000"
								required
							/>
						</label>
						<label className="text-sm font-medium text-slate-700">
							Trade date
							<input className={field} name="tradeDate" required type="date" />
						</label>
						<label className="text-sm font-medium text-slate-700">
							Settlement (optional)
							<input className={field} name="settleDate" type="date" />
						</label>
						<label className="text-sm font-medium text-slate-700">
							Clean price
							<input
								className={field}
								name="cleanPrice"
								placeholder="96.53125 or 96-17"
								required
							/>
						</label>
						<label className="text-sm font-medium text-slate-700">
							Account (optional)
							<input className={field} maxLength={120} name="account" />
						</label>
						<div className="sm:col-span-4">
							<button className={button} disabled={busy} type="submit">
								Add trade
							</button>
							<Outcome intent="add" result={actionData} />
						</div>
					</Form>
				</section>

				<section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
					<h2 className="font-semibold text-neutral-900">Import a CSV</h2>
					<p className="mt-1 text-sm text-slate-600">
						One row per trade. Columns are matched by name in any order: a CUSIP (or
						US ISIN), face or quantity, price, and trade date are required; side,
						settlement date and account are optional. With no side column a negative
						quantity is a sale. Prices may be in 32nds. A file imports whole or not at
						all, and can be undone.
					</p>
					<pre className="mt-3 overflow-x-auto rounded-md bg-slate-50 p-3 font-mono text-xs text-slate-700">
						{
							"cusip,side,face,price,trade_date,settle_date,account\n91282CMM0,buy,1000000,96-17,2026-09-25,2026-09-28,Main"
						}
					</pre>
					<Form
						className="mt-4 flex flex-wrap items-center gap-3"
						encType="multipart/form-data"
						method="post"
					>
						<input name="intent" type="hidden" value="import" />
						<input
							accept=".csv,text/csv"
							className="text-sm"
							name="file"
							required
							type="file"
						/>
						{actionData?.intent === "import" &&
						!actionData.ok &&
						"duplicates" in actionData &&
						actionData.duplicates ? (
							<label className="flex items-center gap-1 text-sm text-slate-700">
								<input name="allowDuplicates" type="checkbox" value="yes" />
								Import anyway
							</label>
						) : null}
						<button className={button} disabled={busy} type="submit">
							Import
						</button>
					</Form>
					<Outcome intent="import" result={actionData} />
				</section>
			</WriteGate>

			<section className="mt-6">
				<div className="flex items-baseline justify-between">
					<h2 className="font-semibold text-neutral-900">
						All trades ({transactions.length})
					</h2>
					{imports.length > 0 ? (
						<div className="flex flex-wrap gap-2">
							{imports.map((idImport, i) =>
								isDemo ? null : (
									<Form key={idImport} method="post">
										<input name="intent" type="hidden" value="undoImport" />
										<input name="idImport" type="hidden" value={idImport} />
										<button
											className="text-xs text-red-700 underline underline-offset-4"
											type="submit"
										>
											Undo import {i + 1} (
											{transactions.filter((t) => t.idImport === idImport).length} trades)
										</button>
									</Form>
								),
							)}
						</div>
					) : null}
				</div>
				<Outcome intent="delete" result={actionData} />
				<Outcome intent="undoImport" result={actionData} />
				{transactions.length === 0 ? (
					<p className="mt-3 text-sm text-slate-600">No trades yet.</p>
				) : (
					<div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
						<table className="w-full text-sm">
							<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
								<tr>
									<th className="px-3 py-2 font-semibold">Trade date</th>
									<th className="px-3 py-2 font-semibold">Settles</th>
									<th className="px-3 py-2 font-semibold">Side</th>
									<th className="px-3 py-2 font-semibold">Security</th>
									<th className="px-3 py-2 text-right font-semibold">Face</th>
									<th className="px-3 py-2 text-right font-semibold">Price</th>
									<th className="px-3 py-2 font-semibold">Account</th>
									<th className="px-3 py-2 font-semibold">Source</th>
									<th className="px-3 py-2" />
								</tr>
							</thead>
							<tbody>
								{transactions.map((t) => (
									<tr className="border-t border-slate-100" key={t.idTransaction}>
										<td className="tabular px-3 py-2">{t.tradeDate}</td>
										<td className="tabular px-3 py-2 text-slate-500">{t.settleDate}</td>
										<td className="px-3 py-2 capitalize">{t.side}</td>
										<td className="px-3 py-2">
											<span className="font-mono text-xs">{t.cusip}</span> {t.label}
										</td>
										<td className="tabular px-3 py-2 text-right">{face(t.faceAmount)}</td>
										<td className="tabular px-3 py-2 text-right">
											{price(t.cleanPrice)}
										</td>
										<td className="px-3 py-2 text-slate-500">{t.account ?? ""}</td>
										<td className="px-3 py-2 text-slate-500">
											{t.sourceTransaction === "csv" ? "CSV" : "Manual"}
										</td>
										<td className="px-3 py-2 text-right">
											{isDemo ? null : (
												<Form method="post">
													<input name="intent" type="hidden" value="delete" />
													<input
														name="idTransaction"
														type="hidden"
														value={t.idTransaction}
													/>
													<button
														className="text-xs text-red-700 underline underline-offset-4"
														type="submit"
													>
														Delete
													</button>
												</Form>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>

			{isDemo ? null : (
				<section className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
					<div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
						<h2 className="font-semibold text-neutral-900">Settings</h2>
						<Form className="mt-4 space-y-4" method="post">
							<input name="intent" type="hidden" value="settings" />
							<label className="block text-sm font-medium text-slate-700">
								Name
								<input
									className={field}
									defaultValue={portfolio.namePortfolio}
									maxLength={80}
									name="namePortfolio"
									required
								/>
							</label>
							<label className="block text-sm font-medium text-slate-700">
								Benchmark
								<select
									className={field}
									defaultValue={portfolio.codeBenchmark ?? ""}
									name="codeBenchmark"
								>
									<option value="">None</option>
									{BENCHMARK_OPTIONS.map((o) => (
										<option key={o.code} value={o.code}>
											{o.label}
										</option>
									))}
								</select>
							</label>
							<label className="block text-sm font-medium text-slate-700">
								Coupons and proceeds
								<select
									className={field}
									defaultValue={portfolio.policyIncome}
									name="policyIncome"
								>
									{INCOME_OPTIONS.map((o) => (
										<option key={o.policy} value={o.policy}>
											{o.label}
										</option>
									))}
								</select>
							</label>
							<button className={button} disabled={busy} type="submit">
								Save
							</button>
							<Outcome intent="settings" result={actionData} />
						</Form>
					</div>
					<div className="rounded-xl border border-red-200 bg-white p-5 shadow-sm">
						<h2 className="font-semibold text-red-800">Delete this portfolio</h2>
						<p className="mt-1 text-sm text-slate-600">
							Removes the portfolio and every trade in it, permanently. Type its name
							to confirm.
						</p>
						<Form className="mt-4 space-y-3" method="post">
							<input name="intent" type="hidden" value="deletePortfolio" />
							<input
								className={field}
								name="confirmName"
								placeholder={portfolio.namePortfolio}
							/>
							<button
								className="rounded-full border border-red-300 px-5 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
								type="submit"
							>
								Delete portfolio
							</button>
							<Outcome intent="deletePortfolio" result={actionData} />
						</Form>
					</div>
				</section>
			)}
		</main>
	);
}
