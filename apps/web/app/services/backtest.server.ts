import {
	readDailyLevels,
	readLatestPriceDate,
	readPricesOn,
	type TEnv,
} from "@markets/mcp-tools";
import {
	LOT_PRESETS,
	runBacktest,
	STRATEGIES,
	type TBacktestResult,
	type TRebalanceFrequency,
	type TStrategyKey,
	type TUniverseSecurity,
} from "@markets/portfolio";
import {
	INDEX_META,
	isIndexCode,
	securityFamilyFromPriceType,
	type TIndexCode,
} from "@saferate/treasury-client/types";
import { getBacktestResult, putBacktestResult } from "@markets/persistence";
import { loadMoneyMarket, loadSecurities } from "./portfolio.server";

/**
 * Strategy backtests on real history: packages/portfolio backtest.ts fed with
 * each rebalance day's FedInvest closes, the securities' price histories, and
 * the bill curve's 1-month rate for cash. Compared with a Safe Rate index.
 */

/** Where the price archive starts to be complete (the curves begin 2008-09). */
export const EARLIEST_START = "2008-10-01";

/**
 * The longest window each frequency is offered for. Every rebalance values the
 * book from its first day, so work grows with rebalances times days: measured
 * on staging, see CLAUDE.md. Monthly beyond five years is a CPU-limit risk.
 */
export const MAX_YEARS: Record<TRebalanceFrequency, number> = {
	monthly: 5,
	quarterly: 10,
	annual: 18,
};

/** The index each template is naturally judged against. */
export const DEFAULT_BENCHMARK: Record<TStrategyKey, TIndexCode> = {
	billRoll: "BILL",
	shortEnd: "0103",
	ladder: "AGG",
	intermediate: "0307",
	long: "20PL",
	bullet: "AGG",
	barbell: "AGG",
};

/**
 * Priced universes, per isolate: history does not change. The PROMISE is
 * cached, so strategies run side by side share one read of a day.
 */
const universeCache = new Map<
	string,
	Promise<{ date: string; securities: TUniverseSecurity[] } | null>
>();

const universeOn = (env: TEnv) => (date: string) => {
	const hit = universeCache.get(date);
	if (hit !== undefined) return hit;
	const pending = readUniverse(env, date).catch((error) => {
		universeCache.delete(date);
		throw error;
	});
	universeCache.set(date, pending);
	if (universeCache.size > 600) {
		const oldest = universeCache.keys().next().value;
		if (oldest !== undefined) universeCache.delete(oldest);
	}
	return pending;
};

const readUniverse = async (env: TEnv, date: string) => {
	let found: { date: string; securities: TUniverseSecurity[] } | null = null;
	const day = new Date(`${date}T00:00:00Z`);
	for (let i = 0; i < 7 && found === null; i++) {
		const iso = day.toISOString().slice(0, 10);
		const priced = await readPricesOn(env, iso);
		if (priced.length > 0)
			found = {
				date: iso,
				securities: priced.map((p) => ({
					cusip: p.cusip,
					family: securityFamilyFromPriceType(p.securityType),
					couponPercent: p.couponPercent,
					maturityDate: p.maturityDate,
					price: p.close,
				})),
			};
		day.setUTCDate(day.getUTCDate() + 1);
	}
	return found;
};

export type TBacktestRequest = {
	strategies: TStrategyKey[];
	start: string;
	end: string;
	frequency: TRebalanceFrequency;
	horizonYears: number;
	initial: number;
	costTicks: number;
	benchmark: TIndexCode;
};

export const latestDate = (env: TEnv) => readLatestPriceDate(env);

export const runBacktests = async (env: TEnv, request: TBacktestRequest) => {
	const { start, end } = request;
	const moneyMarket = await loadMoneyMarket(env, start, end);
	const calendar = moneyMarket
		.map((d) => d.date)
		.filter((d) => d >= start && d <= end);
	const rateOn = new Map(
		moneyMarket.map((d) => [
			d.date,
			(d.rates.find((r) => r.label === "1M")?.rate ?? 0) / 100,
		]),
	);
	let lastRate = 0;
	const cashRate = (date: string) => {
		lastRate = rateOn.get(date) ?? lastRate;
		return lastRate;
	};
	const data = {
		calendar,
		cashRate,
		universeOn: universeOn(env),
		securities: async (cusips: string[]) => {
			const loaded = await loadSecurities(env, cusips);
			return { terms: loaded.terms, marks: loaded.marks };
		},
	};

	// Side by side: each strategy waits on its own reads between rebalances,
	// so running them together overlaps the waits. Measured on staging
	// 2026-09-29, one after another: 23.5 s for all seven over five years,
	// 5.5 s of it CPU and 20.8 s loading securities.
	const results: {
		key: TStrategyKey;
		name: string;
		result: TBacktestResult | { ok: false; message: string };
	}[] = await Promise.all(
		request.strategies.map(async (key) => ({
			key,
			name: STRATEGIES.find((s) => s.key === key)?.name ?? key,
			result: await runBacktest({
				strategy: key,
				horizonYears: request.horizonYears,
				start,
				end,
				frequency: request.frequency,
				initial: request.initial,
				costPer100: request.costTicks / 32,
				lots: LOT_PRESETS.retail,
				data,
			}),
		})),
	);

	const levels = await readDailyLevels(env, {
		code: request.benchmark,
		from: start,
		to: end,
	});
	// The benchmark opens on the strategies' first day, at that day's close.
	const firstDay =
		results.flatMap((r) => (r.result.ok ? [r.result.start] : [])).sort()[0] ??
		start;
	const opened = levels.find((l) => l.date >= firstDay);
	const benchmark =
		opened === undefined
			? null
			: {
					code: request.benchmark,
					name: INDEX_META[request.benchmark].name,
					series: levels
						.filter((l) => l.date >= opened.date)
						.map((l) => ({ date: l.date, growth: l.level / opened.level })),
				};
	return { results, benchmark, calendarDays: calendar.length };
};

/**
 * runBacktests, through the Workers cache. A backtest depends only on its
 * inputs and on history, which changes when a new close lands, so the key is
 * the request and the latest price date; nothing in it is per user. Measured
 * on staging 2026-09-29: all seven over five years was 21 s cold (most of it
 * reading about 300 securities' full price histories, which the treasury
 * service returns whole), so a repeat must not pay it again.
 */
/**
 * In the cache key. BUMP IT whenever packages/portfolio backtest.ts, the
 * ledger, or what this file feeds them changes: a cached result is served
 * for a week, whatever the code now says.
 */
const ENGINE_VERSION = "2026-09-29.slots";

/** Weekly points for the charts; the statistics were computed on every day. */
const thin = <T extends { date: string }>(xs: T[]) =>
	xs.filter((_, i) => i % 5 === 0 || i === xs.length - 1);

const forCharts = (ran: Awaited<ReturnType<typeof runBacktests>>) => ({
	...ran,
	benchmark:
		ran.benchmark === null
			? null
			: {
					...ran.benchmark,
					cumulative: (ran.benchmark.series.at(-1)?.growth ?? 1) - 1,
					first: ran.benchmark.series[0]?.date ?? null,
					last: ran.benchmark.series.at(-1)?.date ?? null,
					series: thin(ran.benchmark.series),
				},
	results: ran.results.map((r) =>
		r.result.ok
			? { ...r, result: { ...r.result, series: thin(r.result.series) } }
			: r,
	),
});

export type TBacktestOutcome = ReturnType<typeof forCharts>;

export const runBacktestsCached = async (
	env: TEnv & { DB: D1Database },
	ctx: ExecutionContext,
	request: TBacktestRequest,
	latest: string,
): Promise<TBacktestOutcome> => {
	const keyBacktest = `${ENGINE_VERSION}|${latest}|${new URLSearchParams(
		Object.entries(request).map(([k, v]) => [k, String(v)]),
	)}`;
	const edgeKey = new Request(
		`https://backtest.cache.saferate.internal/${encodeURIComponent(keyBacktest)}`,
	);
	const edge = (globalThis as { caches?: { default?: Cache } }).caches?.default;

	// 1. This data centre's cache, 2. the shared store, 3. compute.
	const atEdge = edge === undefined ? undefined : await edge.match(edgeKey);
	if (atEdge !== undefined) return (await atEdge.json()) as TBacktestOutcome;
	const stored = await getBacktestResult({ db: env.DB, keyBacktest }).catch(
		(error) => {
			console.error("[backtest] store read failed", error);
			return null;
		},
	);
	const payload =
		stored ?? JSON.stringify(forCharts(await runBacktests(env, request)));
	const keep = async () => {
		if (stored === null)
			await putBacktestResult({
				db: env.DB,
				keyBacktest,
				datePrices: latest,
				payload,
			}).catch((error) => console.error("[backtest] store write failed", error));
		if (edge !== undefined)
			await edge.put(
				edgeKey,
				new Response(payload, {
					headers: {
						"Content-Type": "application/json",
						"Cache-Control": "public, max-age=604800",
					},
				}),
			);
	};
	ctx.waitUntil(keep());
	return JSON.parse(payload) as TBacktestOutcome;
};

export const parseRequest = (
	params: URLSearchParams,
	latest: string,
	/** Used when the link does not say (the Builder's "Backtest this strategy"). */
	defaultStart: string,
):
	| { ok: true; request: TBacktestRequest }
	| { ok: false; message: string }
	| null => {
	if (params.get("run") !== "1") return null;
	const strategy = params.get("strategy") ?? "all";
	const strategies =
		strategy === "all"
			? STRATEGIES.map((s) => s.key)
			: STRATEGIES.filter((s) => s.key === strategy).map((s) => s.key);
	if (strategies.length === 0)
		return { ok: false, message: "Choose a strategy." };
	const frequency =
		(["monthly", "quarterly", "annual"] as const).find(
			(f) => f === params.get("frequency"),
		) ?? "quarterly";
	const end = params.get("end") || latest;
	const start = params.get("start") || defaultStart;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
		return { ok: false, message: "Dates are YYYY-MM-DD." };
	if (start < EARLIEST_START)
		return {
			ok: false,
			message: `The price history is complete from ${EARLIEST_START}.`,
		};
	if (end > latest)
		return { ok: false, message: `The latest close on file is ${latest}.` };
	if (start >= end)
		return { ok: false, message: "The start must be before the end." };
	const years = (Date.parse(end) - Date.parse(start)) / (365.25 * 86_400_000);
	if (years > MAX_YEARS[frequency] + 0.01)
		return {
			ok: false,
			message: `${frequency === "annual" ? "Yearly" : frequency[0].toUpperCase() + frequency.slice(1)} rebalancing runs over at most ${MAX_YEARS[frequency]} years here; choose a later start or a slower rebalance.`,
		};
	const number = (name: string, fallback: number) => {
		const v = Number(String(params.get(name) ?? "").replace(/[$,\s]/g, ""));
		return Number.isFinite(v) &&
			params.get(name) !== "" &&
			params.get(name) !== null
			? v
			: fallback;
	};
	const initial = number("initial", 1_000_000);
	if (!(initial >= 10_000))
		return { ok: false, message: "Start with at least $10,000." };
	const costTicks = Math.max(0, Math.min(8, number("cost", 0.5)));
	const horizonYears = Math.max(2, Math.min(30, number("horizon", 10)));
	const askedBenchmark = params.get("benchmark") ?? "";
	const benchmark: TIndexCode = isIndexCode(askedBenchmark)
		? askedBenchmark
		: strategies.length === 1
			? DEFAULT_BENCHMARK[strategies[0]]
			: "AGG";
	return {
		ok: true,
		request: {
			strategies,
			start,
			end,
			frequency,
			horizonYears,
			initial,
			costTicks,
			benchmark,
		},
	};
};
