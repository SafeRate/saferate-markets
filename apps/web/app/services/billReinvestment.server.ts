import { call } from "@markets/mcp-tools";
import {
	billRate,
	breakevenReinvestmentRate,
	growthAt,
	rateFor,
	rollAtForwards,
	type TBillCurveParams,
} from "@markets/portfolio";
import { z } from "zod";

type TEnv = Env;

/**
 * T-bill reinvestment: roll short bills or lock in a year?
 *
 * REINVESTMENT IS PRICED AT THE CURVE'S OWN FORWARDS, NOT A FORECAST. A
 * forecast of where bill rates will be is a prediction Safe Rate would have to
 * defend, and it moves toward advice. The implied forward is the rate today's
 * bill curve already prices for each future bill, read off the published fit.
 * Rolling at the forwards and holding the 52-week bill come out equal by
 * construction, so the useful outputs are the forwards themselves (the
 * breakeven a roll has to beat) and what each roll earns if rates land away
 * from them: flat at today's level, or 50 and 100 basis points lower or 50
 * higher.
 *
 * Rates are the fitted bill curve's bond-equivalent yields, the basis
 * TreasuryDirect calls the investment rate. The first bill of every roll is
 * bought today at today's rate, so a scenario only moves the reinvestments.
 */

const ZCurveRow = z
	.object({
		date: z.string(),
		beta_0: z.number(),
		beta_1: z.number(),
		beta_2: z.number(),
		lambda: z.number(),
	})
	.passthrough();

const latestBillCurve = async (env: TEnv) => {
	const to = new Date();
	const from = new Date(to.getTime() - 14 * 86_400_000);
	const iso = (d: Date) => d.toISOString().slice(0, 10);
	const reply = (await call(
		env,
		"curveSeries",
	)({ family: "money-market", from: iso(from), to: iso(to) })) as
		| { rows?: unknown[] }
		| unknown[]
		| null;
	const rows = z
		.array(ZCurveRow)
		.parse(Array.isArray(reply) ? reply : (reply?.rows ?? []))
		.sort((a, b) => a.date.localeCompare(b.date));
	const last = rows.at(-1);
	if (!last) throw new Error("no bill curve in the last two weeks");
	const curve: TBillCurveParams = {
		beta0: last.beta_0,
		beta1: last.beta_1,
		beta2: last.beta_2,
		lambda: last.lambda,
	};
	return { date: last.date, curve };
};

export const TERMS = [
	{ key: "4w", label: "4-week", years: 4 / 52 },
	{ key: "13w", label: "13-week", years: 13 / 52 },
	{ key: "26w", label: "26-week", years: 26 / 52 },
] as const;

const SHIFTS = [
	{ key: "forwards", label: "Rates move as the market prices them" },
	{ key: "flat", label: "Rates stay at today's level" },
	{
		key: "down50",
		label: "Rates end up 0.5 points lower than priced",
		shiftBp: -50,
	},
] as const;

/**
 * How far the priced 3-month rate must move over the year before the page
 * says it is rising or falling rather than "about the same", in percentage
 * points. Ten basis points: below that the direction is noise in the fit.
 */
const DIRECTION_THRESHOLD = 0.1;

export type TDirection = "rise" | "fall" | "stay about the same";

export const directionOf = (from: number, to: number): TDirection =>
	to - from > DIRECTION_THRESHOLD
		? "rise"
		: from - to > DIRECTION_THRESHOLD
			? "fall"
			: "stay about the same";

const addDays = (iso: string, days: number) => {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + Math.round(days));
	return d.toISOString().slice(0, 10);
};

export const loadBillReinvestment = async (env: TEnv, amount: number) => {
	const { date, curve } = await latestBillCurve(env);
	const horizon = 1;
	const yearRate = billRate(curve, horizon);
	const yearIncome = amount * (growthAt(yearRate, horizon) - 1);

	const terms = TERMS.map((term) => {
		const todayRate = billRate(curve, term.years);
		const atForwards = rollAtForwards({
			curve,
			termYears: term.years,
			horizonYears: horizon,
		});
		const breakeven = breakevenReinvestmentRate({
			curve,
			termYears: term.years,
			horizonYears: horizon,
		});
		const outcomes = SHIFTS.map((s) => {
			const growth =
				s.key === "flat"
					? growthAt(todayRate, horizon)
					: rollAtForwards({
							curve,
							termYears: term.years,
							horizonYears: horizon,
							shiftBp: "shiftBp" in s ? s.shiftBp : 0,
						}).growth;
			return {
				key: s.key,
				ratePercent: rateFor(growth, horizon),
				income: amount * (growth - 1),
			};
		});
		return {
			key: term.key,
			label: term.label,
			todayRate,
			breakeven,
			rolls: atForwards.steps.length,
			schedule: atForwards.steps.map((s) => ({
				date: addDays(date, s.startYears * 364),
				startYears: s.startYears,
				endYears: s.startYears + term.years,
				rate: s.pricedRate,
			})),
			outcomes,
		};
	});

	// The 52-week bill as a fourth "roll" of one step, so every tab on the
	// page reads the same shape: its rate is fixed, so every case earns the same.
	const held = {
		key: "52w",
		label: "52-week",
		todayRate: yearRate,
		breakeven: null,
		rolls: 1,
		schedule: [{ date, startYears: 0, endYears: horizon, rate: yearRate }],
		outcomes: SHIFTS.map((sh) => ({
			key: sh.key,
			ratePercent: yearRate,
			income: yearIncome,
		})),
	};
	const thirteenWeek = terms.find((t) => t.key === "13w");
	const pricedLater = thirteenWeek?.schedule.at(-1) ?? null;
	const direction = directionOf(
		thirteenWeek?.todayRate ?? yearRate,
		pricedLater?.rate ?? yearRate,
	);

	return {
		asOf: date,
		amount,
		direction,
		pricedLater,
		yearRate,
		yearIncome,
		terms: [
			...terms.map((t) => ({ ...t, breakeven: t.breakeven as number | null })),
			held,
		],
		scenarios: SHIFTS.map((s) => ({ key: s.key, label: s.label })),
	};
};

export type TBillReinvestment = Awaited<
	ReturnType<typeof loadBillReinvestment>
>;
