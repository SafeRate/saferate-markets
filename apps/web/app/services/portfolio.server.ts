import {
	call,
	familyOf,
	readAnalyticsFor,
	readDailyLevels,
	readLatestPriceDate,
	readSecurityDetail,
	readSecurityPrices,
	type TEnv,
} from "@markets/mcp-tools";
import {
	attributeLedger,
	attributionOver,
	buildLedger,
	pricersFor,
	type TCurveParams,
	chainReturns,
	checkTrades,
	externalFlows,
	levelReturn,
	moneyWeightedReturn,
	PERIOD_LABEL,
	periodStart,
	positionsAt,
	projectedIncome,
	realisedPriceGains,
	summarise,
	type TFamily,
	type TIncomePolicy,
	type TLedgerProblem,
	type TMark,
	frnPricer,
	type TPeriodKey,
	type TPricer,
	tipsPricer,
	type TSecurityTerms,
	type TTrade,
} from "@markets/portfolio";
import type { TPortfolioTransaction } from "@markets/persistence";
import {
	INDEX_META,
	isIndexCode,
	type TIndexCode,
	ZMoneyMarketCurveDay,
	ZSecurityAnalytics,
} from "@saferate/treasury-client/types";
import { z } from "zod";

/**
 * A portfolio, valued: the treasury data it needs, read through the strict
 * readers (outage, not-deployed and empty kept apart), run through
 * packages/portfolio. Everything here is derived on read from the stored
 * trades; nothing is written back.
 */

export type TSecurityInfo = {
	cusip: string;
	family: TFamily | null;
	couponPercent: number;
	maturityDate: string;
	originalSecurityTerm: string;
	detailSecurityType: string;
	/** A floater's fixed spread over its index, percent. Null otherwise. */
	spreadPercent: number | null;
};

/** Terms and closes for each CUSIP, from its detail and price history. */
export const loadSecurities = async (env: TEnv, cusips: string[]) => {
	const unique = [...new Set(cusips)];
	const loaded = await Promise.all(
		unique.map(async (cusip) => {
			const [detail, prices] = await Promise.all([
				readSecurityDetail(env, cusip),
				readSecurityPrices(env, { cusip }),
			]);
			return { cusip, detail, prices };
		}),
	);
	const info = new Map<string, TSecurityInfo>();
	const terms = new Map<string, TSecurityTerms>();
	const marks = new Map<string, TMark[]>();
	const pricers = new Map<string, TPricer>();
	/** The latest stored TIPS / FRN analytics row, for their own risk measures. */
	const linkerRisk = new Map<
		string,
		{ date: string; realDuration: number; indexRatio: number }
	>();
	const floaterRisk = new Map<
		string,
		{ date: string; spreadDuration: number; rateDuration: number }
	>();
	const unknown: string[] = [];
	for (const { cusip, detail, prices } of loaded) {
		if (detail === null) {
			unknown.push(cusip);
			continue;
		}
		const family = familyOf(prices);
		info.set(cusip, {
			cusip,
			family,
			couponPercent: detail.couponPercent ?? 0,
			maturityDate: detail.maturityDate,
			originalSecurityTerm: detail.originalSecurityTerm,
			detailSecurityType: detail.detailSecurityType,
			spreadPercent: detail.spread,
		});
		if (family !== null) {
			terms.set(cusip, {
				cusip,
				family,
				// The detail stores the coupon in PERCENT (4.625), unlike prices.
				couponRate: (detail.couponPercent ?? 0) / 100,
				maturityDate: detail.maturityDate,
				// A floater pays quarterly; everything else coupon-bearing, semiannually.
				frequency: family === "frn" ? 4 : 2,
			});
		}
		// TIPS and FRNs are valued from their stored analytics, as the index does.
		if (family === "tips" || family === "frn") {
			const analytics = await readAnalyticsFor(env, { cusip, basis: family });
			const security = terms.get(cusip) as TSecurityTerms;
			if (analytics.basis === "tips") {
				pricers.set(
					cusip,
					tipsPricer(
						security,
						analytics.rows.map((r) => ({ date: r.date, indexRatio: r.indexRatio })),
					),
				);
				const last = analytics.rows.at(-1);
				if (last)
					linkerRisk.set(cusip, {
						date: last.date,
						realDuration: last.modifiedDuration,
						indexRatio: last.indexRatio,
					});
			} else if (analytics.basis === "frn") {
				pricers.set(
					cusip,
					frnPricer(
						security,
						analytics.rows.map((r) => ({
							date: r.date,
							accrued: r.accruedInterest,
							indexRate: r.indexRatePercent / 100,
							spread: r.quotedSpreadBp / 10_000,
						})),
					),
				);
				const last = analytics.rows.at(-1);
				if (last)
					floaterRisk.set(cusip, {
						date: last.date,
						spreadDuration: last.spreadDurationYears,
						rateDuration: last.rateDurationYears,
					});
			}
		}
		marks.set(
			cusip,
			prices.map((p) => ({ date: p.date, close: p.close })),
		);
	}
	return { info, terms, marks, pricers, linkerRisk, floaterRisk, unknown };
};

/**
 * The fitted zero curve's parameters for every day in a window, from the raw
 * curve rows (each tenor row repeats its day's fit). In five-year pieces: the
 * zero family stores ten rows a day and upstream caps a reply at 20,000.
 */
const loadCurveParams = async (env: TEnv, from: string, to: string) => {
	const params = new Map<string, TCurveParams>();
	const ZRow = z
		.object({
			date: z.string(),
			theta_0: z.number(),
			theta_1: z.number(),
			theta_2: z.number(),
			theta_3: z.number(),
			lambda_1: z.number(),
			lambda_2: z.number(),
		})
		.passthrough();
	let cursor = from;
	while (cursor <= to) {
		const pieceEnd = new Date(`${cursor}T00:00:00Z`);
		pieceEnd.setUTCFullYear(pieceEnd.getUTCFullYear() + 5);
		const until =
			pieceEnd.toISOString().slice(0, 10) < to
				? pieceEnd.toISOString().slice(0, 10)
				: to;
		const reply = await call(
			env,
			"curveSeries",
		)({ family: "zero", from: cursor, to: until });
		const rows = Array.isArray(reply)
			? reply
			: ((reply as { rows?: unknown[] } | null)?.rows ?? []);
		for (const row of z.array(ZRow).parse(rows))
			if (!params.has(row.date))
				params.set(row.date, {
					theta0: row.theta_0,
					theta1: row.theta_1,
					theta2: row.theta_2,
					theta3: row.theta_3,
					lambda1: row.lambda_1,
					lambda2: row.lambda_2,
				});
		const next = new Date(`${until}T00:00:00Z`);
		next.setUTCDate(next.getUTCDate() + 1);
		cursor = next.toISOString().slice(0, 10);
	}
	return params;
};

/** The bill curve over a window: the market's calendar, and what cash earns. */
const loadMoneyMarket = async (env: TEnv, from: string, to: string) => {
	const reply = await call(
		env,
		"curveSeries",
	)({ family: "money-market", from, to });
	const rows = Array.isArray(reply)
		? reply
		: ((reply as { rows?: unknown[] } | null)?.rows ?? []);
	return z
		.array(ZMoneyMarketCurveDay)
		.parse(rows)
		.sort((a, b) => a.date.localeCompare(b.date));
};

const toTrade = (t: TPortfolioTransaction): TTrade => ({
	idTransaction: t.idTransaction,
	cusip: t.cusip,
	side: t.side,
	tradeDate: t.tradeDate,
	settleDate: t.settleDate,
	faceAmount: t.faceAmount,
	cleanPrice: t.cleanPrice,
});

export const describeProblem = (problem: TLedgerProblem) => {
	switch (problem.kind) {
		case "unsupported_family":
			return `${problem.cusip} is a ${problem.family.toUpperCase()}. It has no stored analytics to value it from, so it cannot be priced yet.`;
		case "oversold":
			return `${problem.cusip}: sells ${problem.soldFace.toLocaleString("en-US")} face on ${problem.tradeDate}, but only ${problem.heldFace.toLocaleString("en-US")} is held then.`;
		case "trade_after_maturity":
			return `${problem.cusip}: the trade on ${problem.tradeDate} settles on or after the security matures.`;
		case "no_terms":
			return `${problem.cusip} is not a Treasury security Safe Rate has on file.`;
		case "no_marks":
			return `${problem.cusip} has no prices on file.`;
	}
};

const PERIODS: Exclude<TPeriodKey, "custom">[] = [
	"mtd",
	"qtd",
	"ytd",
	"1y",
	"3y",
	"5y",
	"inception",
];

const downsample = <T>(rows: T[], max: number) =>
	rows.length <= max
		? rows
		: rows.filter(
				(_, i) => i % Math.ceil(rows.length / max) === 0 || i === rows.length - 1,
			);

export const valuePortfolio = async ({
	env,
	transactions,
	codeBenchmark,
	policyIncome,
	custom,
	attributionPeriod = "ytd",
}: {
	/** Which period to attribute: one at a time, it is the costly part. */
	attributionPeriod?: TPeriodKey;
	env: TEnv;
	transactions: TPortfolioTransaction[];
	codeBenchmark: string | null;
	policyIncome: TIncomePolicy;
	custom: { from: string; to: string } | null;
}) => {
	const trades = transactions.map(toTrade);
	const asOf = await readLatestPriceDate(env);
	if (trades.length === 0) return { status: "empty" as const, asOf };

	const { info, terms, marks, pricers, linkerRisk, floaterRisk, unknown } =
		await loadSecurities(
			env,
			trades.map((t) => t.cusip),
		);
	const problems = [
		...unknown.map((cusip) => ({ kind: "no_terms" as const, cusip })),
		...checkTrades(trades, terms, new Set(pricers.keys())),
	];
	if (problems.length > 0)
		return {
			status: "problems" as const,
			asOf,
			problems: problems.map(describeProblem),
		};

	const firstTrade = trades.reduce(
		(min, t) => (t.tradeDate < min ? t.tradeDate : min),
		trades[0].tradeDate,
	);
	const moneyMarket = await loadMoneyMarket(env, firstTrade, asOf);
	const rateOn = new Map(
		moneyMarket.map((d) => [
			d.date,
			(d.rates.find((r) => r.label === "1M")?.rate ?? 0) / 100,
		]),
	);
	const calendar = [
		...new Set([
			...moneyMarket.map((d) => d.date),
			...[...marks.values()].flat().map((m) => m.date),
		]),
	]
		.filter((d) => d >= firstTrade && d <= asOf)
		.sort();
	let lastRate = 0;
	const cashRate = (date: string) => {
		lastRate = rateOn.get(date) ?? lastRate;
		return lastRate;
	};

	const ledger = buildLedger({
		trades,
		terms,
		marks,
		calendar,
		asOf,
		income: policyIncome,
		cashRate,
		pricers,
	});
	const summary = summarise(ledger, asOf);
	const end = ledger.days.at(-1)?.date ?? asOf;

	const benchmark =
		codeBenchmark !== null && isIndexCode(codeBenchmark) ? codeBenchmark : null;
	// From a fortnight before the first trade: the benchmark opens at the last
	// index close BEFORE it, the same starting line as the portfolio's first day.
	const lookback = new Date(`${firstTrade}T00:00:00Z`);
	lookback.setUTCDate(lookback.getUTCDate() - 14);
	const benchmarkLevels =
		benchmark === null
			? []
			: (
					await readDailyLevels(env, {
						code: benchmark as TIndexCode,
						from: lookback.toISOString().slice(0, 10),
					})
				).map((l) => ({
					date: l.date,
					level: l.level,
				}));

	const firstDay = ledger.days[0]?.date ?? null;
	const periodRow = (
		key: TPeriodKey,
		start: string | null,
		periodEnd: string,
	) => {
		// A period the portfolio did not span opens at the CLOSE OF ITS FIRST
		// DAY, for the portfolio and the benchmark alike. So both start from the
		// same line, and the first purchase's trade-to-close gap (an execution
		// gain, or a typo) stays in the dollar gain and money-weighted return
		// instead of the time-weighted one. Measured 2026-09-29: 91282CMM0 bought
		// at the 1 Sep close returned -2.83% to 28 Sep against its own 7-10 Year
		// index at -2.82% on this rule, and -3.11% from the prior close.
		const isFullPeriod = start !== null && firstDay !== null && firstDay <= start;
		const openAt = isFullPeriod ? start : firstDay;
		const portfolio = {
			...chainReturns(ledger.days, openAt, periodEnd),
			isFullPeriod,
		};
		const bench =
			benchmark === null || openAt === null
				? null
				: levelReturn(benchmarkLevels, openAt, periodEnd);
		return {
			key,
			label: PERIOD_LABEL[key],
			start: isFullPeriod ? start : firstDay,
			end: periodEnd,
			cumulative: portfolio.cumulative,
			annualised: portfolio.annualised,
			isFullPeriod: portfolio.isFullPeriod,
			benchmarkCumulative: bench?.cumulative ?? null,
			benchmarkAnnualised: bench?.annualised ?? null,
		};
	};
	const periods = PERIODS.map((key) =>
		periodRow(key, periodStart(key, end), end),
	).filter(
		// A trailing period longer than the portfolio's life is just inception again.
		(row) =>
			row.key === "inception" ||
			row.key === "mtd" ||
			row.key === "qtd" ||
			row.key === "ytd" ||
			row.isFullPeriod,
	);
	const customRow =
		custom === null
			? null
			: periodRow("custom", custom.from, custom.to < end ? custom.to : end);

	const lastMarks = new Map(
		[...marks].flatMap(([cusip, series]) => {
			const last = [...series].reverse().find((m) => m.date <= asOf);
			return last === undefined ? [] : [[cusip, last] as const];
		}),
	);
	const positions = positionsAt({
		ledger,
		trades,
		terms,
		lastMarks,
		asOf: end,
		pricers,
	});
	const realised = realisedPriceGains(trades, ledger, end);

	// Risk from the day's stored analytics, by market value, bonds only.
	const analyticsRows = z
		.array(z.object({ cusip: z.string() }).passthrough())
		.parse((await call(env, "analyticsOn")(end)) ?? []);
	const analytics = new Map(
		analyticsRows
			.filter((row) => ledger.holdings.has(row.cusip))
			.map((row) => [row.cusip, ZSecurityAnalytics.parse(row)] as const),
	);
	// Nominal risk over bills, notes and bonds. A TIPS duration is REAL and a
	// floater's is mostly spread, so each is reported apart, never blended in.
	const familyAt = (cusip: string) => terms.get(cusip)?.family;
	const nominals = positions.filter((p) => {
		const f = familyAt(p.cusip);
		return f === "bill" || f === "note" || f === "bond";
	});
	const bondValue = nominals.reduce((s, p) => s + p.marketValue, 0);
	const covered = nominals.filter((p) => analytics.has(p.cusip));
	const coveredValue = covered.reduce((s, p) => s + p.marketValue, 0);
	const weighted = (
		pick: (a: z.infer<typeof ZSecurityAnalytics>) => number | null,
	) =>
		coveredValue <= 0
			? null
			: covered.reduce((s, p) => {
					const a = analytics.get(p.cusip);
					const value = a === undefined ? null : pick(a);
					return value === null ? s : s + (p.marketValue / coveredValue) * value;
				}, 0);
	const krdLabels =
		[...analytics.values()][0]?.keyRateDurations.map((k) => k.label) ?? [];
	const risk = {
		coveredShare: bondValue > 0 ? coveredValue / bondValue : null,
		uncovered: nominals
			.filter((p) => !analytics.has(p.cusip))
			.map((p) => p.cusip),
		modifiedDuration: weighted((a) => a.modifiedDuration),
		convexity: weighted((a) => a.convexity),
		yieldPercent: weighted((a) => a.ytm),
		dv01: covered.reduce(
			(s, p) => s + (p.faceAmount / 100) * (analytics.get(p.cusip)?.dv01 ?? 0),
			0,
		),
		keyRates: krdLabels.map((label, i) => ({
			label,
			duration: weighted((a) => a.keyRateDurations[i]?.value ?? 0) ?? 0,
		})),
		linkers: (() => {
			const held = positions.filter((p) => linkerRisk.has(p.cusip));
			const value = held.reduce((s, p) => s + p.marketValue, 0);
			return held.length === 0
				? null
				: {
						marketValue: value,
						realDuration: held.reduce(
							(s, p) =>
								s +
								(p.marketValue / value) * (linkerRisk.get(p.cusip)?.realDuration ?? 0),
							0,
						),
					};
		})(),
		floaters: (() => {
			const held = positions.filter((p) => floaterRisk.has(p.cusip));
			const value = held.reduce((s, p) => s + p.marketValue, 0);
			return held.length === 0
				? null
				: {
						marketValue: value,
						spreadDuration: held.reduce(
							(s, p) =>
								s +
								(p.marketValue / value) *
									(floaterRisk.get(p.cusip)?.spreadDuration ?? 0),
							0,
						),
						rateDuration: held.reduce(
							(s, p) =>
								s +
								(p.marketValue / value) * (floaterRisk.get(p.cusip)?.rateDuration ?? 0),
							0,
						),
					};
		})(),
	};

	const income = projectedIncome({
		holdings: ledger.holdings,
		terms,
		asOf: end,
		pricers,
	});
	const horizon = new Date(`${end}T00:00:00Z`);
	horizon.setUTCFullYear(horizon.getUTCFullYear() + 1);
	const nextYear = income.filter(
		(f) => f.date <= horizon.toISOString().slice(0, 10),
	);

	const benchmarkByDate = new Map(benchmarkLevels.map((l) => [l.date, l.level]));
	let growth = 1;
	const firstBench =
		benchmarkLevels.find((l) => l.date >= (ledger.days[0]?.date ?? ""))?.level ??
		null;
	const series = downsample(
		ledger.days.map((d) => {
			growth *= 1 + (d.dailyReturn ?? 0);
			const level = benchmarkByDate.get(d.date);
			return {
				date: d.date,
				marketValue: d.marketValue,
				growth,
				benchmarkGrowth:
					level === undefined || firstBench === null ? null : level / firstBench,
			};
		}),
		400,
	);

	// Trades priced well away from that day's close: legitimate intraday, but
	// more often a typo or the wrong date, and either way the gap is booked as
	// the first day's return. Shown, not refused (validateNewTrades refuses at 5).
	const awayFromClose = trades.flatMap((t) => {
		const close = [...(marks.get(t.cusip) ?? [])]
			.reverse()
			.find((m) => m.date <= t.tradeDate);
		if (close === undefined || Math.abs(close.close - t.cleanPrice) <= 1)
			return [];
		return [
			{
				...t,
				close: close.close,
				closeDate: close.date,
				info: info.get(t.cusip) ?? null,
			},
		];
	});

	// Attribution over one period, on the day's fitted curves.
	const attrStart =
		attributionPeriod === "custom"
			? (custom?.from ?? null)
			: attributionPeriod === "inception"
				? null
				: periodStart(attributionPeriod, end);
	const attrEnd =
		attributionPeriod === "custom" && custom
			? custom.to < end
				? custom.to
				: end
			: end;
	const attrOpen =
		attrStart !== null && firstDay !== null && firstDay <= attrStart
			? attrStart
			: firstDay;
	const curveFrom = new Date(`${attrOpen ?? firstTrade}T00:00:00Z`);
	curveFrom.setUTCDate(curveFrom.getUTCDate() - 7);
	const curves = await loadCurveParams(
		env,
		curveFrom.toISOString().slice(0, 10),
		attrEnd,
	);
	const attributionDays = attributeLedger({
		ledger,
		trades,
		terms,
		pricers: pricersFor(terms, pricers),
		marks,
		curves,
		window: { start: attrOpen, end: attrEnd },
	});
	const attribution = {
		key: attributionPeriod,
		label: PERIOD_LABEL[attributionPeriod],
		...attributionOver(attributionDays, attrOpen, attrEnd),
		benchmark:
			benchmark === null || attrOpen === null
				? null
				: levelReturn(benchmarkLevels, attrOpen, attrEnd),
	};

	return {
		status: "valued" as const,
		attribution,
		awayFromClose,
		asOf: end,
		policyIncome,
		benchmark:
			benchmark === null
				? null
				: { code: benchmark, name: INDEX_META[benchmark as TIndexCode].name },
		summary: {
			...summary,
			moneyWeighted: moneyWeightedReturn(
				externalFlows(ledger),
				end,
				summary.marketValue,
			),
			realisedPriceGain: [...realised.values()].reduce((s, g) => s + g, 0),
			unrealisedPriceGain: positions.reduce(
				(s, p) => s + (p.unrealisedPriceGain ?? 0),
				0,
			),
		},
		periods,
		custom: customRow,
		positions: positions.map((p) => ({
			...p,
			info: info.get(p.cusip) ?? null,
			realisedPriceGain: realised.get(p.cusip) ?? 0,
		})),
		closedPositions: [...realised]
			.filter(([cusip]) => !ledger.holdings.has(cusip))
			.map(([cusip, gain]) => ({
				cusip,
				info: info.get(cusip) ?? null,
				realisedPriceGain: gain,
			})),
		risk,
		incomeNextYear: nextYear.map((f) => ({
			...f,
			info: info.get(f.cusip) ?? null,
		})),
		incomeTotal: income.reduce((s, f) => s + f.amount, 0),
		series,
		staleMarks: ledger.staleMarks.length,
		info: Object.fromEntries(info),
	};
};

/** How far a trade price may sit from that day's close before it is refused as a likely typo. */
const PRICE_TOLERANCE = 5;

/**
 * Check trades BEFORE they are stored, against the whole ledger they would
 * join: terms known, kind supported, nothing oversold or traded after maturity,
 * the trade inside the price history, and its price near that day's close (a
 * price that is not per 100 is the commonest mistake). Returns the problems,
 * each naming its trade; empty means store them.
 */
export const validateNewTrades = async ({
	env,
	existing,
	incoming,
}: {
	env: TEnv;
	existing: TPortfolioTransaction[];
	incoming: (Omit<TTrade, "idTransaction"> & { label: string })[];
}) => {
	const asOf = await readLatestPriceDate(env);
	const { terms, marks, pricers, unknown } = await loadSecurities(env, [
		...existing.map((t) => t.cusip),
		...incoming.map((t) => t.cusip),
	]);
	const problems: string[] = unknown.map(
		(cusip) => `${cusip} is not a Treasury security Safe Rate has on file.`,
	);
	for (const trade of incoming) {
		if (trade.tradeDate > asOf) {
			problems.push(
				`${trade.label}: trade date ${trade.tradeDate} is after the latest close on file (${asOf}).`,
			);
			continue;
		}
		if (trade.settleDate < trade.tradeDate)
			problems.push(`${trade.label}: settles before it trades.`);
		const series = marks.get(trade.cusip) ?? [];
		if (series.length === 0) continue;
		if (trade.tradeDate < series[0].date) {
			problems.push(
				`${trade.label}: ${trade.tradeDate} is before Safe Rate's price history for ${trade.cusip}, which starts ${series[0].date}.`,
			);
			continue;
		}
		const close = [...series].reverse().find((m) => m.date <= trade.tradeDate);
		if (
			close !== undefined &&
			Math.abs(close.close - trade.cleanPrice) > PRICE_TOLERANCE
		)
			problems.push(
				`${trade.label}: price ${trade.cleanPrice} is more than ${PRICE_TOLERANCE} points from the ${close.date} close of ${close.close}. Prices are clean, per 100 of face.`,
			);
	}
	const all: TTrade[] = [
		...existing.map(toTrade),
		...incoming.map((t, i) => ({ ...t, idTransaction: `new-${i}` })),
	];
	problems.push(
		...checkTrades(all, terms, new Set(pricers.keys())).map(describeProblem),
	);
	return [...new Set(problems)];
};
