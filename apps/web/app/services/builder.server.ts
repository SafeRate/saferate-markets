import {
	readAnalytics,
	readLatestPriceDate,
	readPricesOn,
	type TEnv,
} from "@markets/mcp-tools";
import {
	buildStrategy,
	customPlan,
	horizonMatch,
	immuniseLiabilities,
	matchLiabilities,
	planCashflows,
	planRisk,
	planUniverse,
	planYield,
	settlementFor,
	type TCurveParams,
	type TLiabilityInput,
	type TPlan,
	type TPlannedSecurity,
	trackIndex,
	treasuryDirectAlternative,
} from "@markets/portfolio";
import {
	INDEX_META,
	securityFamilyFromPriceType,
} from "@saferate/treasury-client/types";
import { loadCurveParams } from "./portfolio.server";
import type { TBuilderInputs } from "@/lib/builderOptions";

export {
	BUILDER_MODES,
	TRACKABLE_INDICES,
	strategyByKey,
	type TBuilderInputs,
	type TBuilderMode,
} from "@/lib/builderOptions";

/**
 * The Portfolio Builder, server side: today's universe and curve, one of the
 * methods in packages/portfolio builder.ts, and what the result delivers.
 */

export const loadMarket = async (env: TEnv, markupTicks: number) => {
	const asOf = await readLatestPriceDate(env);
	const settlementDate = settlementFor(asOf);
	const priced = await readPricesOn(env, asOf);
	const universe = planUniverse({
		securities: priced.map((p) => ({
			cusip: p.cusip,
			family: securityFamilyFromPriceType(p.securityType),
			couponPercent: p.couponPercent,
			maturityDate: p.maturityDate,
			price: p.close,
		})),
		settlementDate,
		markup: markupTicks / 32,
	});
	const lookback = new Date(`${asOf}T00:00:00Z`);
	lookback.setUTCDate(lookback.getUTCDate() - 10);
	const params = await loadCurveParams(
		env,
		lookback.toISOString().slice(0, 10),
		asOf,
	);
	const curveDate = [...params.keys()]
		.sort()
		.reverse()
		.find((d) => d <= asOf);
	if (curveDate === undefined)
		throw new Error(`No fitted curve on or before ${asOf}`);
	return {
		asOf,
		settlementDate,
		universe,
		curve: params.get(curveDate) as TCurveParams,
		curveDate,
	};
};

export type TBuilt =
	| {
			status: "planned";
			plan: TPlan & { risk?: unknown };
			liabilities: TLiabilityInput[];
	  }
	| { status: "failed"; message: string }
	| { status: "idle" };

export const runBuilder = async ({
	env,
	inputs,
	liabilities,
	market,
}: {
	env: TEnv;
	inputs: TBuilderInputs;
	liabilities: TLiabilityInput[];
	market: Awaited<ReturnType<typeof loadMarket>>;
}): Promise<TBuilt> => {
	const { universe, curve, settlementDate } = market;
	const denomination = inputs.denomination;
	const needsLiabilities =
		inputs.mode === "match" ||
		inputs.mode === "immunise" ||
		inputs.mode === "horizon";
	if (needsLiabilities && liabilities.length === 0)
		return {
			status: "failed",
			message: "Choose or enter a liability stream first.",
		};
	const future = liabilities.filter((l) => l.date > settlementDate);
	if (needsLiabilities && future.length < liabilities.length)
		return {
			status: "failed",
			message: `${liabilities.length - future.length} liabilities fall on or before settlement (${settlementDate}) and cannot be funded by a purchase now. Remove them or move them later.`,
		};
	const needsBudget = inputs.mode === "strategy" || inputs.mode === "index";
	if (needsBudget && !(inputs.budget !== null && inputs.budget > 0))
		return { status: "failed", message: "Enter the amount to invest." };

	let plan: TPlan | { kind: string; message: string };
	switch (inputs.mode) {
		case "match":
			plan = matchLiabilities({
				universe,
				liabilities,
				denomination,
				maxPositions: inputs.maxPositions ?? undefined,
			});
			break;
		case "immunise":
			plan = immuniseLiabilities({
				universe,
				liabilities,
				curve,
				settlementDate,
				denomination,
			});
			break;
		case "horizon":
			plan = horizonMatch({
				universe,
				liabilities,
				curve,
				settlementDate,
				horizonYears: inputs.horizonYears,
				denomination,
			});
			break;
		case "strategy":
			plan = buildStrategy({
				strategy: inputs.strategy,
				universe,
				budget: inputs.budget as number,
				settlementDate,
				horizonYears: inputs.horizonYears,
				denomination,
			});
			break;
		case "index": {
			const analytics = await readAnalytics(env, { code: inputs.indexCode });
			const basis = [...analytics].sort(
				(a, b) => b.basisSharePercent - a.basisSharePercent,
			)[0];
			if (basis === undefined)
				return {
					status: "failed",
					message: `No analytics for the ${inputs.indexCode} index.`,
				};
			plan = trackIndex({
				universe,
				indexKeyRateDurations: basis.keyRateDurations.map((k) => k.value),
				budget: inputs.budget as number,
				curve,
				settlementDate,
				denomination,
				indexName: INDEX_META[inputs.indexCode].name,
			});
			break;
		}
		case "custom":
			if (inputs.rows.length === 0)
				return { status: "failed", message: "Add at least one security." };
			plan = customPlan({ universe, rows: inputs.rows });
			break;
	}
	if ("kind" in plan) return { status: "failed", message: plan.message };
	if (plan.positions.length === 0)
		return {
			status: "failed",
			message:
				"Nothing to buy: the budget or the liabilities are too small for the denomination.",
		};
	return { status: "planned", plan, liabilities };
};

/** What the page shows about a plan: metrics, cashflows by year, the order sheet. */
export const describePlan = ({
	plan,
	liabilities,
	market,
	budget,
}: {
	plan: TPlan & { risk?: unknown };
	liabilities: TLiabilityInput[];
	market: Awaited<ReturnType<typeof loadMarket>>;
	budget: number | null;
}) => {
	const { settlementDate, curve, asOf } = market;
	const risk = planRisk(plan, curve, settlementDate);
	const flows = planCashflows(plan);
	const years = new Map<number, { income: number; liabilities: number }>();
	for (const f of flows) {
		const y = Number(f.date.slice(0, 4));
		const row = years.get(y) ?? { income: 0, liabilities: 0 };
		row.income += f.amount;
		years.set(y, row);
	}
	for (const l of liabilities) {
		const y = Number(l.date.slice(0, 4));
		const row = years.get(y) ?? { income: 0, liabilities: 0 };
		row.liabilities += l.amount;
		years.set(y, row);
	}
	const byYear = [...years]
		.sort(([a], [b]) => a - b)
		.map(([year, r]) => ({ year, ...r }));
	const positions = plan.positions.map((p) => ({
		cusip: p.cusip,
		family: p.security.family,
		couponPercent: p.security.couponPercent,
		maturityDate: p.security.maturityDate,
		faceAmount: p.faceAmount,
		close: p.security.price,
		planPrice: p.security.planPrice,
		dirtyPrice: p.security.dirtyPrice,
		cost: p.cost,
		treasuryDirect: treasuryDirectAlternative(
			{ faceAmount: p.faceAmount, maturityDate: p.security.maturityDate },
			settlementDate,
		),
	}));
	return {
		method: plan.method,
		asOf,
		settlementDate,
		curveDate: market.curveDate,
		cost: plan.cost,
		budget,
		leftover: budget === null ? null : budget - plan.cost,
		notes: plan.notes,
		yieldPercent: (planYield(plan, settlementDate) ?? 0) * 100,
		duration: risk.duration,
		dv01: risk.dv01,
		keyRateDurations: risk.keyRateDurations,
		positions,
		byYear,
		matching: plan.matching ?? null,
		immunisation: (plan as { risk?: unknown }).risk ?? null,
	};
};

export type { TPlannedSecurity };
