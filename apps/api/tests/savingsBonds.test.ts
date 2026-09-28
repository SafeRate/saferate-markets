import { describe, expect, test } from "bun:test";
import ee from "./fixtures/savings-bonds/ee-2010-01-01.json";
import iBond from "./fixtures/savings-bonds/i-2022-05-01.json";
import rates from "./fixtures/savings-bonds/rates.json";
import { bearer, setup } from "./helpers";

/**
 * Savings bonds on PRODUCTION outputs (get_savings_bond_rates and
 * value_savings_bond on api.saferate.markets, 2026-09-28, mapped back to
 * upstream's fields): every Series I period and the current EE rate; a $1,000
 * I bond issued 2022-05-01 and a $100 EE bond issued 2010-01-01, both valued
 * on 2026-09-01.
 */

const refusal = (code: string, message: string) => {
	const error = new Error(message);
	error.stack = `${code}: ${message}\n    at upstream`;
	return error;
};

const treasury = (overrides: Record<string, unknown> = {}) => ({
	savingsBondRates: async () => rates,
	iBond: async () => iBond,
	eeBond: async () => ee,
	...overrides,
});

const get = async (path: string, overrides?: Record<string, unknown>) => {
	const { call, key } = await setup({ treasury: treasury(overrides) });
	const response = await call(path, { headers: bearer(key) });
	return { status: response.status, body: await response.json() };
};

describe("/v1/savings-bonds/rates", () => {
	test("the rates in force, in percent, with the I history", async () => {
		const { status, body } = await get("/v1/savings-bonds/rates?on=2026-09-28");
		expect(status).toBe(200);
		expect(body.series_i.period_start).toBe("2026-05-01");
		expect(body.series_i.composite_percent).toBeCloseTo(4.25503, 8);
		expect(body.series_i.fixed_percent).toBeCloseTo(0.9, 8);
		expect(body.series_ee.semiannual_inflation_percent).toBeNull();
		expect(body.series_i_history.length).toBe(57);
	});

	test("as of an earlier date, later periods are not in force", async () => {
		const { body } = await get("/v1/savings-bonds/rates?on=2022-06-01");
		expect(body.series_i.period_start).toBe("2022-05-01");
		expect(
			body.series_i_history.every(
				(r: { period_start: string }) => r.period_start <= "2022-06-01",
			),
		).toBe(true);
	});
});

describe("valuations", () => {
	test("Series I: the penalty is what separates accrued from redemption", async () => {
		const { status, body } = await get(
			"/v1/savings-bonds/i/value?purchased=2022-05-01&denomination=1000&valued_on=2026-09-01",
		);
		expect(status).toBe(200);
		expect(body.accrued_value - body.penalty_amount).toBeCloseTo(
			body.redemption_value,
			8,
		);
		expect(body.current_period.fixed_rate).toBe(0);
	});

	test("Series EE: the doubling guarantee is reported", async () => {
		const { status, body } = await get(
			"/v1/savings-bonds/ee/value?purchased=2010-01-01&denomination=100&valued_on=2026-09-01",
		);
		expect(status).toBe(200);
		expect(body.guarantee_date).toBe("2030-01-01");
		expect(body.rate_percent).toBeCloseTo(1.2, 8);
		expect(body.cohort).toBe("2005-05");
	});

	test("a date pair the series cannot value is a 400, and not correctable", async () => {
		const { status, body } = await get(
			"/v1/savings-bonds/ee/value?purchased=1994-01-01",
			{
				eeBond: async () => {
					throw refusal(
						"no_valuation",
						"EE bonds from this window are not modelled.",
					);
				},
			},
		);
		expect(status).toBe(400);
		expect(body.code).toBe("no_valuation");
		expect(body.is_correctable).toBe(false);
	});
});
