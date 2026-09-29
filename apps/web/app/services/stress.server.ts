import { call, type TEnv } from "@markets/mcp-tools";
import type { TPortfolioTransaction } from "@markets/persistence";
import {
	buildScenarios,
	KEY_RATES,
	pricersFor,
	type TCurveParams,
	type TIncomePolicy,
	type TPortfolioHolding,
	type TScenarioSet,
	type TStressScenario,
	scenarioFromCurves,
	settlementFor,
	simulateHistorical,
	standardScenarios,
	stressPortfolio,
	yearFraction,
	zeroRate,
} from "@markets/portfolio";
import { z } from "zod";
import { loadCurveParams, loadPortfolioState } from "./portfolio.server";

/**
 * Stress testing and tail risk for a portfolio's current holdings, on the
 * treasury repo's own risk code (ported into packages/portfolio/src/risk):
 *  - SCENARIOS reprice every nominal cashflow exactly on today's fitted zero
 *    curve shocked at the twelve key rates (portfolioStress.ts): the standard
 *    set, each stored market event replayed, and a shock of the user's own.
 *  - VALUE AT RISK and EXPECTED SHORTFALL by filtered historical simulation
 *    (historicalSimulation.ts): every day's key-rate move since September 2008,
 *    standardised by GARCH(1,1) volatility and rescaled to today's, with the far
 *    tail read from a fitted generalised Pareto (volatilityModels.ts, after
 *    Tsay). Monte Carlo was rejected on purpose upstream: the slope factor's
 *    kurtosis is 79.8, which a normal model cannot produce.
 *
 * TIPS and FRNs are not repriced on the nominal curve. A TIPS moves by its REAL
 * duration times the nominal shift at its maturity, which assumes breakevens
 * are unchanged; a floater by its rate duration, near zero because it resets.
 * Both are shown apart, and neither enters the value at risk.
 */

const HISTORY_START = "2008-09-02";

/** Scenario sets per as-of date, per isolate: the GARCH fit is the costly part. */
const scenarioCache = new Map<
	string,
	{
		dates: string[];
		levels: number[][];
		set: TScenarioSet;
		params: Map<string, TCurveParams>;
	}
>();

const loadHistory = async (env: TEnv, asOf: string) => {
	const cached = scenarioCache.get(asOf);
	if (cached) return cached;
	const params = await loadCurveParams(env, HISTORY_START, asOf);
	const dates = [...params.keys()].sort();
	// Key-rate zero levels in BASIS POINTS: the simulation's P&L is
	// -(dollars per bp) x (move in bp).
	const levels = dates.map((d) =>
		KEY_RATES.map((t) => zeroRate(params.get(d) as TCurveParams, t) * 100),
	);
	const set = buildScenarios({ dates, levels, model: "garch" });
	const entry = { dates, levels, set, params };
	scenarioCache.clear();
	scenarioCache.set(asOf, entry);
	return entry;
};

/** The key-rate shift at any maturity, interpolated between the key rates. */
const shiftAt = (shift: number[], time: number) => {
	if (time <= KEY_RATES[0]) return shift[0] ?? 0;
	for (let k = 1; k < KEY_RATES.length; k++)
		if (time <= KEY_RATES[k]) {
			const w = (time - KEY_RATES[k - 1]) / (KEY_RATES[k] - KEY_RATES[k - 1]);
			return (shift[k - 1] ?? 0) * (1 - w) + (shift[k] ?? 0) * w;
		}
	return shift[KEY_RATES.length - 1] ?? 0;
};

export type TCustomShock = {
	parallelBp: number;
	twistBp: number;
	butterflyBp: number;
};

/**
 * A shock of the user's own, at the key rates: a parallel move; a twist
 * pivoting on 5 years, -half at 2 years and inside, +half at 10 and beyond; and
 * a butterfly peaking at 5 years, zero at 2 and 10.
 */
export const customScenario = ({
	parallelBp,
	twistBp,
	butterflyBp,
}: TCustomShock): TStressScenario => ({
	name: `Your shock: ${parallelBp >= 0 ? "+" : ""}${parallelBp}bp parallel, ${twistBp >= 0 ? "+" : ""}${twistBp}bp 2s10s, ${butterflyBp >= 0 ? "+" : ""}${butterflyBp}bp 5y belly`,
	shiftBasisPoints: KEY_RATES.map((t) => {
		const twist =
			t <= 2
				? -twistBp / 2
				: t >= 10
					? twistBp / 2
					: -twistBp / 2 + (twistBp * (t - 2)) / 8;
		const fly =
			t <= 2 || t >= 10
				? 0
				: t <= 5
					? (butterflyBp * (t - 2)) / 3
					: (butterflyBp * (10 - t)) / 5;
		return parallelBp + twist + fly;
	}),
});

const ZEvent = z
	.object({
		event_id: z.string(),
		name: z.string(),
		start_date: z.string(),
		end_date: z.string(),
		category: z.string(),
	})
	.passthrough();

const histogram = (values: number[], bins = 40) => {
	const lo = values[Math.floor(values.length * 0.001)] ?? 0;
	const hi = values[Math.floor(values.length * 0.999)] ?? 0;
	const width = (hi - lo) / bins || 1;
	const counts = new Array(bins).fill(0) as number[];
	for (const v of values) {
		const i = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / width)));
		counts[i] += 1;
	}
	return counts.map((count, i) => ({
		from: lo + i * width,
		to: lo + (i + 1) * width,
		count,
	}));
};

export const analyseStress = async ({
	env,
	transactions,
	policyIncome,
	custom,
}: {
	env: TEnv;
	transactions: TPortfolioTransaction[];
	policyIncome: TIncomePolicy;
	custom: TCustomShock | null;
}) => {
	const state = await loadPortfolioState({ env, transactions, policyIncome });
	if (state.status !== "ready") return state;
	const { ledger, terms, marks, info, linkerRisk, floaterRisk } = state;
	// The state carries only the TIPS and FRN pricers; nominals take the formula.
	const pricers = pricersFor(terms, state.pricers);
	const asOf = ledger.days.at(-1)?.date ?? state.asOf;
	const settlement = settlementFor(asOf);

	const lastClose = (cusip: string) =>
		[...(marks.get(cusip) ?? [])].reverse().find((m) => m.date <= asOf)?.close;
	const nominal: TPortfolioHolding[] = [];
	const others: {
		cusip: string;
		family: string;
		marketValue: number;
		duration: number;
		maturityYears: number;
	}[] = [];
	let marketValue = ledger.cash;
	for (const [cusip, face] of ledger.holdings) {
		const security = terms.get(cusip);
		const pricer = pricers.get(cusip);
		const close = lastClose(cusip);
		if (!security || !pricer || close === undefined || face <= 1e-9) continue;
		const dirty = pricer.dirty(close, asOf);
		marketValue += (face / 100) * dirty;
		if (security.family === "tips" || security.family === "frn") {
			others.push({
				cusip,
				family: security.family,
				marketValue: (face / 100) * dirty,
				duration:
					security.family === "tips"
						? (linkerRisk.get(cusip)?.realDuration ?? 0)
						: (floaterRisk.get(cusip)?.rateDuration ?? 0),
				maturityYears: yearFraction(settlement, security.maturityDate),
			});
			continue;
		}
		const dates = [
			...new Set([
				...pricer.couponDates(settlement).filter((d) => d > settlement),
				security.maturityDate,
			]),
		].sort();
		const couponDays = new Set(pricer.couponDates(settlement));
		nominal.push({
			cusip,
			faceValue: face,
			dirtyPrice: dirty,
			macaulayDuration: 0,
			modifiedDuration: 0,
			convexity: 0,
			dv01: 0,
			keyRateDurations: [],
			payments: dates.map(
				(d) =>
					(couponDays.has(d) ? pricer.coupon(d) : 0) +
					(d === security.maturityDate ? pricer.redemption() : 0),
			),
			// Calendar years: a zero curve is a function of elapsed time.
			paymentsExps: dates.map((d) => yearFraction(settlement, d)),
		});
	}

	const history = await loadHistory(env, asOf);
	const curveDate = [...history.dates].reverse().find((d) => d <= asOf) ?? asOf;
	const curve = history.params.get(curveDate) as TCurveParams;

	const approxOthers = (shift: number[]) =>
		others.reduce(
			(s, o) =>
				s - (o.duration * o.marketValue * shiftAt(shift, o.maturityYears)) / 10_000,
			0,
		);

	const run = (scenarios: TStressScenario[]) => {
		const priced =
			nominal.length === 0
				? null
				: stressPortfolio({ holdings: nominal, curve, scenarios });
		return scenarios.map((scenario, i) => {
			const r = priced?.results[i];
			const other = approxOthers(scenario.shiftBasisPoints);
			const total = (r?.profitAndLoss ?? 0) + other;
			return {
				name: scenario.name,
				shift2y: scenario.shiftBasisPoints[3],
				shift10y: scenario.shiftBasisPoints[7],
				shift30y: scenario.shiftBasisPoints[11],
				nominal: r?.profitAndLoss ?? 0,
				firstOrder: r?.firstOrder ?? 0,
				convexity: r?.secondOrder ?? 0,
				other,
				total,
				fraction: marketValue > 0 ? total / marketValue : null,
			};
		});
	};

	const standard = run([
		...standardScenarios(),
		...(custom ? [customScenario(custom)] : []),
	]);

	// Every stored market event, replayed on today's holdings: the key-rate
	// move from the last fitted day before it began to its end.
	const events = z
		.array(ZEvent)
		.parse((await call(env, "events")({ from: HISTORY_START, to: asOf })) ?? [])
		.filter((e) => e.end_date > e.start_date);
	const paramOn = (date: string, strictlyBefore: boolean) => {
		const d = [...history.dates]
			.reverse()
			.find((x) => (strictlyBefore ? x < date : x <= date));
		return d === undefined
			? null
			: { date: d, params: history.params.get(d) as TCurveParams };
	};
	const episodes = events.flatMap((e) => {
		const from = paramOn(e.start_date, true);
		const to = paramOn(e.end_date, false);
		if (!from || !to || to.date <= from.date) return [];
		return [
			{
				event: e,
				from: from.date,
				to: to.date,
				scenario: scenarioFromCurves({
					name: e.name,
					startCurve: from.params,
					endCurve: to.params,
				}),
			},
		];
	});
	const replayed = run(episodes.map((e) => e.scenario)).map((row, i) => ({
		...row,
		category: episodes[i].event.category,
		from: episodes[i].from,
		to: episodes[i].to,
	}));

	// Key-rate DV01 of the nominal book, by bumping each key rate 1bp.
	const bumps = KEY_RATES.map((_, k) => ({
		name: String(k),
		shiftBasisPoints: KEY_RATES.map((__, j) => (j === k ? 1 : 0)),
	}));
	const bumped =
		nominal.length === 0
			? null
			: stressPortfolio({ holdings: nominal, curve, scenarios: bumps });
	const keyRateDv01 = KEY_RATES.map(
		(_, k) => -(bumped?.results[k].profitAndLoss ?? 0),
	);
	const dv01 = keyRateDv01.reduce((s, v) => s + v, 0);

	const risk =
		nominal.length === 0
			? null
			: ([1, 10] as const).map((horizonDays) => {
					const empirical = simulateHistorical({
						scenarios: history.set,
						keyRateDv01,
						paths: 50_000,
						horizonDays,
						tail: "empirical",
					});
					const evt = simulateHistorical({
						scenarios: history.set,
						keyRateDv01,
						paths: 50_000,
						horizonDays,
						tail: "extreme-value",
					});
					return {
						horizonDays,
						empirical: {
							var95: empirical.valueAtRisk95,
							var99: empirical.valueAtRisk99,
							es95: empirical.expectedShortfall95,
							es99: empirical.expectedShortfall99,
						},
						extremeValue: {
							var95: evt.valueAtRisk95,
							var99: evt.valueAtRisk99,
							es95: evt.expectedShortfall95,
							es99: evt.expectedShortfall99,
							tailShape: evt.tailShape,
						},
						standardDeviation: empirical.standardDeviation,
						kurtosis: empirical.kurtosis,
						histogram: horizonDays === 1 ? histogram(empirical.profitAndLoss) : null,
					};
				});

	return {
		status: "analysed" as const,
		asOf,
		curveDate,
		marketValue,
		cash: ledger.cash,
		dv01,
		keyRateDv01: KEY_RATES.map((t, k) => ({ years: t, dv01: keyRateDv01[k] })),
		standard,
		replayed,
		risk,
		historyDays: history.set.dates.length,
		historyFrom: history.set.dates[0] ?? null,
		others: others.map((o) => ({ ...o, info: info.get(o.cusip) ?? null })),
	};
};
