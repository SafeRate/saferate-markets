import { call } from "@markets/mcp-tools";
import {
	buildStrategy,
	KEY_RATES,
	planYield,
	shockedZeroRate,
	type TPlan,
	yearFraction,
} from "@markets/portfolio";
import { z } from "zod";
import { lotsFrom } from "@/lib/builderOptions";
import { describePlan, loadMarket } from "@/services/builder.server";

type TEnv = Env;

/**
 * The public ladder pages: one published rule, rebuilt from the day's prices.
 *
 * IMPERSONAL BY CONSTRUCTION. Every visitor sees the same rule applied to the
 * same end-of-day prices; the only input is the amount, which changes the
 * face values and nothing about which securities are chosen or why. The rule
 * is the Builder's own `ladder` template, so this page and the dashboard can
 * never describe two different ladders.
 *
 * Prices are the day's end-of-day closes with no markup (`loadMarket(env, 0)`),
 * so every number here can be checked against Treasury's file. The dashboard
 * Builder adds a dealer markup; this page states the rule at the published
 * price instead.
 *
 * Scenario figures reprice every cashflow off the fitted curve after a shift
 * (`shockedZeroRate`), the same full repricing the stress tool uses. They are
 * what the basket would be worth under a move, not a forecast, and there is no
 * historical performance figure anywhere on the page.
 */

export const LADDER_YEARS = [5] as const;
export type TLadderYears = (typeof LADDER_YEARS)[number];

/** Key-rate shifts, in basis points, in the order of KEY_RATES. */
const parallel = (bp: number) => KEY_RATES.map(() => bp);
/** 2s10s moves by `bp`: half down at two years, half up at ten, linear between. */
const twist = (bp: number) =>
	KEY_RATES.map((t) =>
		t <= 2 ? -bp / 2 : t >= 10 ? bp / 2 : -bp / 2 + (bp * (t - 2)) / 8,
	);

export const SCENARIOS = [
	{ name: "Rates +100 bp", shift: parallel(100) },
	{ name: "Rates +50 bp", shift: parallel(50) },
	{ name: "Rates −50 bp", shift: parallel(-50) },
	{ name: "Rates −100 bp", shift: parallel(-100) },
	{ name: "2s10s steepens 25 bp", shift: twist(25) },
	{ name: "2s10s flattens 25 bp", shift: twist(-25) },
] as const;

/** Every remaining cashflow of a plan, as years from settlement. */
const flowsOf = (plan: TPlan, settlementDate: string) =>
	plan.positions.flatMap((p) =>
		p.security.payments.map((pay) => ({
			years: yearFraction(settlementDate, pay.date),
			amount: (p.faceAmount / 100) * pay.amount,
		})),
	);

const valueOf = (
	flows: { years: number; amount: number }[],
	curve: Awaited<ReturnType<typeof loadMarket>>["curve"],
	shift: readonly number[],
	ageBy = 0,
) => {
	let value = 0;
	let received = 0;
	for (const f of flows) {
		const time = f.years - ageBy;
		if (time <= 0) {
			received += f.amount;
			continue;
		}
		const rate = shockedZeroRate({
			curve,
			time,
			shiftBasisPoints: [...shift],
		});
		value += f.amount * Math.exp((-rate / 100) * time);
	}
	return { value, received };
};

const ZSeriesRow = z
	.object({ date: z.string(), value: z.number() })
	.passthrough();

/** SOFR on or before a date, for financed carry; null if it cannot be read. */
const readSofr = async (env: TEnv, asOf: string) => {
	try {
		const from = new Date(`${asOf}T00:00:00Z`);
		from.setUTCDate(from.getUTCDate() - 14);
		const reply = (await call(
			env,
			"series",
		)({
			ids: ["SOFR"],
			from: from.toISOString().slice(0, 10),
			to: asOf,
		})) as { rows?: unknown[] } | null;
		const rows = z
			.array(ZSeriesRow)
			.parse(reply?.rows ?? [])
			.filter((r) => r.date <= asOf)
			.sort((a, b) => a.date.localeCompare(b.date));
		const last = rows.at(-1);
		return last ? { date: last.date, percent: last.value } : null;
	} catch {
		return null;
	}
};

export const loadLadderPage = async (
	env: TEnv,
	{ years, amount }: { years: TLadderYears; amount: number },
) => {
	const market = await loadMarket(env, 0);
	const lots = lotsFrom("retail", {
		increment: null,
		minimumOrder: null,
		minimumPosition: null,
	});
	const plan = buildStrategy({
		strategy: "ladder",
		universe: market.universe,
		budget: amount,
		settlementDate: market.settlementDate,
		horizonYears: years,
		denomination: lots.increment,
		lots,
	});
	if (plan.positions.length === 0) return null;
	const described = describePlan({
		plan,
		liabilities: [],
		market,
		budget: amount,
	});
	const rungs = plan.positions.map((p) => {
		const single: TPlan = { ...plan, positions: [p], cost: p.cost };
		return {
			cusip: p.cusip,
			family: p.security.family,
			couponPercent: p.security.couponPercent,
			maturityDate: p.security.maturityDate,
			price: p.security.price,
			faceAmount: p.faceAmount,
			cost: p.cost,
			weightPercent: (p.cost / plan.cost) * 100,
			yieldPercent: (planYield(single, market.settlementDate) ?? 0) * 100,
		};
	});

	const flows = flowsOf(plan, market.settlementDate);
	const base = valueOf(flows, market.curve, parallel(0)).value;
	const scenarios = SCENARIOS.map((s) => {
		const shocked = valueOf(flows, market.curve, s.shift).value;
		return {
			name: s.name,
			change: shocked - base,
			changePercent: ((shocked - base) / base) * 100,
		};
	});
	// Unchanged curve, three months on: coupons received plus what is left,
	// against today. Carry and roll-down together, on today's fitted curve.
	const aged = valueOf(flows, market.curve, parallel(0), 0.25);
	const threeMonthPercent = ((aged.value + aged.received - base) / base) * 100;

	const sofr = await readSofr(env, market.asOf);
	return {
		years,
		amount,
		asOf: market.asOf,
		settlementDate: market.settlementDate,
		curveDate: market.curveDate,
		cost: described.cost,
		leftover: described.leftover,
		notes: described.notes,
		yieldPercent: described.yieldPercent,
		duration: described.duration,
		dv01: described.dv01,
		rungs,
		byYear: described.byYear.map((y) => ({ year: y.year, income: y.income })),
		scenarios,
		threeMonthPercent,
		sofr,
		financedCarryPercent: sofr ? described.yieldPercent - sofr.percent : null,
	};
};

export type TLadderPage = NonNullable<
	Awaited<ReturnType<typeof loadLadderPage>>
>;
