import { describe, expect, test } from "bun:test";
import bill from "./fixtures/pricing/bill-2027-03-18.json";
import coupon from "./fixtures/pricing/coupon-91282CMM0.json";
import noteAnalytics from "./fixtures/securities/nominal-analytics.json";
import { bearer, setup } from "./helpers";

/**
 * The calculators, on PRODUCTION outputs (price_treasury_security on
 * api.saferate.markets, 2026-09-28, mapped back to upstream's field names):
 * 91282CMM0 at its 2026-09-25 close of 96.53125, and a 2027-03-18 bill at a
 * 4% discount rate.
 */

const refusal = (code: string, message: string) => {
	const error = new Error(message);
	error.stack = `${code}: ${message}\n    at upstream`;
	return error;
};

const treasury = (overrides: Record<string, unknown> = {}) => {
	const asked: Record<string, unknown>[] = [];
	return {
		asked,
		fake: {
			couponPrice: async (input: Record<string, unknown>) => {
				asked.push(input);
				return coupon;
			},
			billPrice: async (input: Record<string, unknown>) => {
				asked.push(input);
				return bill;
			},
			...overrides,
		},
	};
};

const get = async (path: string, overrides?: Record<string, unknown>) => {
	const { asked, fake } = treasury(overrides);
	const { call, key } = await setup({ treasury: fake });
	const response = await call(path, { headers: bearer(key) });
	return { status: response.status, body: await response.json(), asked };
};

describe("coupon", () => {
	test("from a CUSIP and a price: reproduces the day's stored analytics", async () => {
		const { status, body, asked } = await get(
			"/v1/price/coupon?cusip=91282cmm0&clean_price=96.53125&trade_date=2026-09-25",
		);
		expect(status).toBe(200);
		const stored = noteAnalytics.find((row) => row.date === "2026-09-25");
		expect(body.yield_to_maturity_percent).toBe(stored?.ytm);
		expect(body.dv01).toBe(stored?.dv01);
		expect(body.convexity).toBeCloseTo((stored?.convexity ?? 0) / 100, 12);
		expect(body.coupon_rate_percent).toBeCloseTo(4.625, 12);
		// The CUSIP goes up in upper case, and percent inputs go up as decimals.
		expect(asked[0].cusip).toBe("91282CMM0");
		expect(asked[0].cleanPrice).toBe(96.53125);
	});

	test("a yield goes upstream as a decimal", async () => {
		const { asked } = await get(
			"/v1/price/coupon?cusip=91282CMM0&yield_percent=5.1",
		);
		expect(asked[0].yieldRate).toBeCloseTo(0.051, 12);
	});

	test("both sides, or neither, is a 400 before any call", async () => {
		for (const q of [
			"cusip=91282CMM0&clean_price=96&yield_percent=5",
			"cusip=91282CMM0",
		]) {
			const { status, asked } = await get(`/v1/price/coupon?${q}`);
			expect(status).toBe(400);
			expect(asked).toHaveLength(0);
		}
	});

	test("no CUSIP needs both coupon and maturity", async () => {
		const { status } = await get(
			"/v1/price/coupon?clean_price=96&coupon_rate_percent=4",
		);
		expect(status).toBe(400);
	});

	test("an upstream refusal is a 400 that says whether it is fixable", async () => {
		const { status, body } = await get(
			"/v1/price/coupon?cusip=91282CMM0&clean_price=96",
			{
				couponPrice: async () => {
					throw refusal("bad_date", "trade date is after maturity");
				},
			},
		);
		expect(status).toBe(400);
		expect(body.code).toBe("bad_date");
		expect(body.is_correctable).toBe(true);
	});
});

describe("bill", () => {
	test("both rates come back, and they differ", async () => {
		const { status, body, asked } = await get(
			"/v1/price/bill?maturity_date=2027-03-18&discount_rate_percent=4&trade_date=2026-09-25",
		);
		expect(status).toBe(200);
		expect(body.price).toBe(98.1);
		expect(body.discount_rate_percent).toBeCloseTo(4, 10);
		expect(body.investment_rate_percent).toBeCloseTo(4.1341, 4);
		expect(asked[0].discountRate).toBeCloseTo(0.04, 12);
	});

	test("both sides, or neither, is a 400", async () => {
		expect((await get("/v1/price/bill?maturity_date=2027-03-18")).status).toBe(
			400,
		);
		expect(
			(
				await get(
					"/v1/price/bill?maturity_date=2027-03-18&price=98&discount_rate_percent=4",
				)
			).status,
		).toBe(400);
	});
});
