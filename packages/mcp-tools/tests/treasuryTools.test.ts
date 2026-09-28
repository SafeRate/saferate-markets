import { getSavingsBondRates } from "../src/tools/getSavingsBondRates";
import { getTreasuryCurve } from "../src/tools/getTreasuryCurve";
import { getTreasuryDebt } from "../src/tools/getTreasuryDebt";
import { getTreasuryIndex } from "../src/tools/getTreasuryIndex";
import { getTreasurySecurity } from "../src/tools/getTreasurySecurity";
import { priceTreasurySecurity } from "../src/tools/priceTreasurySecurity";
import { snakeKeys } from "../src/tools/shared";
import { valueSavingsBond } from "../src/tools/valueSavingsBond";
import { describe, expect, test } from "bun:test";

/**
 * The TREASURY binding is an RPC entrypoint, so a fake is just an object of
 * async methods. `as never` for the same reason the db fixtures use it: the
 * generated `Service` type carries no method signatures.
 */
const fakeTreasury = (methods: Record<string, unknown>) =>
	({ TREASURY: methods }) as never;

/** A refusal as the package raises it: the code is the Error's name. */
const refusal = (code: string, message: string) => {
	const error = new Error(message);
	error.name = code;
	return error;
};

/**
 * Rows are given in the SHAPE UPSTREAM SENDS — snake_case, straight off SQL —
 * because the package zod-parses every one of them. A camelCase fixture would
 * fail to parse, which is the schema doing its job.
 *
 * The first zero row doubles as the fit diagnostics, so it carries both sets of
 * fields; that is how getLatestCurve reads it.
 */
const ZERO_ROW = {
	converged: 1,
	date: "2026-09-15",
	forward_rate: 4.1,
	lambda_1: 0.6,
	lambda_2: 0.1,
	par_yield: 4.05,
	rmse_basis_points: 1.1,
	rmse_price_cents: 3.2,
	security_count: 220,
	tenor_years: 10,
	theta_0: 4.0,
	theta_1: -0.5,
	theta_2: 0.2,
	theta_3: 0.1,
	zero_rate: 4.02,
};

describe("snakeKeys — the JSON.stringify traps", () => {
	// getQueueYields returns Maps and Sets. `JSON.stringify(new Map())` is `{}`
	// and does not throw, so without this an assistant is handed an empty object
	// where the yields were and cannot tell that anything went missing.
	test("renders a Map as an object rather than {}", () => {
		const out = snakeKeys({ yieldsByCusip: new Map([["912810TW8", 4.2]]) });
		expect(out).toEqual({ yields_by_cusip: { "912810TW8": 4.2 } });
	});

	test("renders a Set as an array rather than {}", () => {
		const out = snakeKeys({ outstanding: new Set(["A", "B"]) });
		expect(out).toEqual({ outstanding: ["A", "B"] });
	});

	test("converts nested keys and leaves values alone", () => {
		const out = snakeKeys({ topLevel: [{ innerKey: 1, nullValue: null }] });
		expect(out).toEqual({ top_level: [{ inner_key: 1, null_value: null }] });
	});

	test("keeps a consecutive-capital run as one segment", () => {
		expect(snakeKeys({ dv01Value: 1, cusipID: "x" })).toEqual({
			dv01_value: 1,
			cusip_id: "x",
		});
	});
});

describe("get_treasury_curve", () => {
	test("resolves the most recent fitted day when no date is given", async () => {
		const out = await getTreasuryCurve(
			{},
			{
				env: fakeTreasury({
					latestCurve: async () => ({
						date: "2026-09-15",
						zero: [ZERO_ROW],
					}),
					curvesOn: async () => ({ zero: [ZERO_ROW] }),
				}),
			},
		);
		expect(out.ok).toBe(true);
		expect(out.date).toBe("2026-09-15");
		// The flag matters: an assistant must be able to say "as of the most
		// recent published day" rather than implying it asked for that date.
		expect(out.is_latest_published).toBe(true);
	});

	test("says so plainly on a day with no fitted curve", async () => {
		const out = await getTreasuryCurve(
			{ date: "2026-09-13" },
			{ env: fakeTreasury({ curvesOn: async () => ({ zero: [] }) }) },
		);
		expect(out.ok).toBe(false);
		expect(out.message).toContain("business days only");
	});

	// Inverted from saferate-ai's version. That server also serves mortgage
	// quotes, so it warns against reading a yield as a mortgage rate and points
	// at get_quote_estimate. This server has no such tool, and a response naming
	// one sends the model looking for a capability that is not here.
	test("names no tool this server does not have", async () => {
		const out = await getTreasuryCurve(
			{ date: "2026-09-15" },
			{ env: fakeTreasury({ curvesOn: async () => ({ zero: [ZERO_ROW] }) }) },
		);
		expect(JSON.stringify(out)).not.toContain("get_quote_estimate");
		expect(out).not.toHaveProperty("not_a_mortgage_rate");
	});

	// The distinction the *Optional package variants would have destroyed.
	test("re-throws a transport failure instead of reporting no data", async () => {
		const down = getTreasuryCurve(
			{ date: "2026-09-15" },
			{
				env: fakeTreasury({
					curvesOn: async () => {
						throw new Response("Data temporarily unavailable", { status: 503 });
					},
				}),
			},
		);
		// An outage must NOT become `ok: false, no_data` — that would be a claim
		// about Safe Rate's coverage when the truth is the service is down. It
		// still rejects; it is only made readable, because the SDK stringifies a
		// raw Response to the useless literal "[object Response]".
		expect(down).rejects.toThrow("Treasury data service is unavailable");
		await down.catch((error: Error) => {
			expect(error.name).toBe("TreasuryUnavailable");
			expect(error.message).toContain("NOT an absence of data");
		});
	});

	test("turns an upstream refusal into an answer, not an exception", async () => {
		const out = await getTreasuryCurve(
			{ date: "2026-09-15", include: ["real"] },
			{
				env: fakeTreasury({
					curvesOn: async () => ({ zero: [ZERO_ROW] }),
					realCurve: async () => {
						throw refusal("bad_range", "That range runs past coverage.");
					},
				}),
			},
		);
		// getRealCurveOn swallows unknown_family itself; anything else surfaces.
		expect(out.ok === false || out.real_curve === null).toBe(true);
	});
});

describe("get_treasury_security", () => {
	test("rejects a non-CUSIP before spending a round trip", async () => {
		let called = false;
		const out = await getTreasurySecurity(
			{ cusip: "the 10 year" },
			{
				env: fakeTreasury({
					security: async () => {
						called = true;
						return {};
					},
				}),
			},
		);
		expect(out.ok).toBe(false);
		expect(out.error).toBe("bad_cusip");
		// And points at the tool that turns a phrase into an identifier.
		expect(out.message).toContain("list_treasury_securities");
		expect(called).toBe(false);
	});

	test("upper-cases a lowercase CUSIP rather than 404ing on it", async () => {
		const seen: string[] = [];
		await getTreasurySecurity(
			{ cusip: "91282cjl6" },
			{
				// getSecurity fans out over five RPC methods, so a fake carrying
				// only `security` throws a TypeError on the next one.
				env: fakeTreasury({
					frnAnalytics: async () => [],
					security: async (cusip: string) => {
						seen.push(cusip);
						return null;
					},
					securityAnalytics: async () => [],
					securityPrices: async () => [],
					tipsAnalytics: async () => [],
				}),
			},
		);
		expect(seen[0]).toBe("91282CJL6");
	});
});

describe("price_treasury_security — exactly one side of the conversion", () => {
	test("refuses both a price and a yield, and says why", async () => {
		const out = await priceTreasurySecurity(
			{
				clean_price: 99.5,
				cusip: "91282CJL6",
				instrument: "coupon",
				yield_percent: 4.2,
			},
			{ env: fakeTreasury({}) },
		);
		expect(out.ok).toBe(false);
		expect(out.error).toBe("bad_input_pair");
		expect(out.message).toContain("they may disagree");
	});

	test("refuses neither", async () => {
		const out = await priceTreasurySecurity(
			{ cusip: "91282CJL6", instrument: "coupon" },
			{ env: fakeTreasury({}) },
		);
		expect(out.ok).toBe(false);
		expect(out.message).toContain("supplied neither");
	});

	test("requires terms or a CUSIP for a coupon security", async () => {
		const out = await priceTreasurySecurity(
			{ instrument: "coupon", yield_percent: 4.2 },
			{ env: fakeTreasury({}) },
		);
		expect(out.ok).toBe(false);
		expect(out.error).toBe("missing_terms");
	});

	// The pricer returns its own { ok, value } envelope, so without unwrapping
	// the model got result.ok.value — two ok flags deep. Caught on staging.
	test("returns the valuation flat, not double-enveloped", async () => {
		const out = await priceTreasurySecurity(
			{
				discount_rate_percent: 3.9,
				instrument: "bill",
				maturity_date: "2027-01-07",
			},
			{
				env: fakeTreasury({
					// camelCase: a computed valuation, not a SQL row. Rates are
					// decimals; the schema multiplies them by 100.
					billPrice: async () => ({
						daysInYear: 365,
						daysToMaturity: 111,
						discountRate: 0.039,
						investmentRate: 0.04,
						maturityDate: "2027-01-07",
						price: 98.7975,
						settlementDate: "2026-09-18",
					}),
				}),
			},
		);
		expect(out.ok).toBe(true);
		expect(out.result).toBeDefined();
		// The value itself, not a nested envelope around it.
		expect((out.result as Record<string, unknown>).ok).toBeUndefined();
		expect((out.result as Record<string, unknown>).price).toBe(98.7975);
	});

	test("requires a maturity for a bill", async () => {
		const out = await priceTreasurySecurity(
			{ discount_rate_percent: 4.2, instrument: "bill" },
			{ env: fakeTreasury({}) },
		);
		expect(out.ok).toBe(false);
		expect(out.error).toBe("missing_maturity");
	});
});

describe("value_savings_bond", () => {
	// Unlike the curve rows, a bond valuation arrives already camelCase: it is
	// computed upstream rather than read off SQL.
	const valuation = {
		accruedValue: 137.2,
		completedPeriods: 6,
		currentPeriod: {
			compositeRate: 0.0428,
			earningPeriodEnd: "2026-10-01",
			earningPeriodStart: "2026-04-01",
			fixedRate: 0.012,
			fixedRateSetOn: "2023-05-01",
			inflationRateSetOn: "2026-05-01",
			semiannualInflationRate: 0.0154,
		},
		finalMaturity: "2053-04-01",
		matured: false,
		monthsIntoCurrentPeriod: 5,
		on: "2026-09-17",
		penaltyAmount: 2.1,
		penaltyMonths: 3,
		principal: 100,
		purchased: "2023-04-01",
		redeemable: true,
		redeemableFrom: "2024-04-01",
		redemptionValue: 135.1,
		valueAtLastCompletedPeriod: 134.0,
	};

	test("returns the redemption rules in-band with the value", async () => {
		const out = await valueSavingsBond(
			{ purchased: "2023-04-01", series: "I" },
			{ env: fakeTreasury({ iBond: async () => valuation }) },
		);
		expect(out.ok).toBe(true);
		// A model asked "what's it worth" will otherwise quote the accrued value
		// flat and overstate what the holder actually receives.
		expect(out.how_to_report_this?.early_redemption_penalty).toContain(
			"three months of interest",
		);
		expect(out.how_to_report_this?.one_year_lockup).toContain(
			"cannot be redeemed",
		);
		expect(out.how_to_report_this?.purchase_date_meaning).toContain("ISSUE date");
	});

	test("translates a correctable refusal and says it can be retried", async () => {
		const out = await valueSavingsBond(
			{ purchased: "1990-01-01", series: "EE" },
			{
				env: fakeTreasury({
					eeBond: async () => {
						throw refusal("bad_principal", "A denomination must be positive.");
					},
				}),
			},
		);
		expect(out.ok).toBe(false);
		expect(out.error).toBe("bad_principal");
		expect(out.is_correctable).toBe(true);
		expect(out.message).toContain("try again");
	});

	test("marks an unanswerable pair as not correctable", async () => {
		const out = await valueSavingsBond(
			{ purchased: "1990-01-01", series: "EE" },
			{
				env: fakeTreasury({
					eeBond: async () => {
						throw refusal(
							"no_valuation",
							"An EE bond issued before May 1995 is outside the rate tables.",
						);
					},
				}),
			},
		);
		expect(out.ok).toBe(false);
		expect(out.is_correctable).toBe(false);
		// Tell the model to stop rather than to retry with different arguments.
		expect(out.message).toContain("not a fixable argument");
	});
});

describe("get_treasury_index — the total-return misreading", () => {
	// Real-shaped rows (from production treasury-api, 2026-09-28): the daily
	// latest is 2026-09-25 while the month-end series stops at 2026-08-31.
	const DAILY_LATEST = [
		{
			code: "broad",
			date: "2026-09-25",
			level: 143.397,
			return_since_rebalance: -0.0174,
			rebalance_date: "2026-08-31",
			constituents: 298,
			methodology: "0.1",
			provisional: 1,
		},
	];
	const MONTH_END = [
		{
			code: "broad",
			constituents: 298,
			date: "2026-08-31",
			level: 145.935,
			methodology: "0.1",
			month_return: 0.00376,
		},
	];
	const listing = () =>
		fakeTreasury({
			indexLevelsDailyOn: async () => DAILY_LATEST,
			indexLevels: async () => MONTH_END,
		});

	test("warns that a level is not a yield, on the listing", async () => {
		const out = await getTreasuryIndex({}, { env: listing() });
		expect(out.ok).toBe(true);
		expect(out.total_return_warning).toContain("not yields");
		expect(out.total_return_warning).toContain("yields FELL");
		expect(out.not_official).toContain("Not an official");
	});

	// The defect this replaced: "latest published day" was the latest MONTH-END,
	// four weeks stale. Now both, labelled, from the same readers as REST.
	test("latest is the newest business day; the month-end is labelled apart", async () => {
		const out = (await getTreasuryIndex({}, { env: listing() })) as {
			as_of: string;
			indices: {
				code: string;
				latest: { date: string; is_provisional: boolean } | null;
				last_month_end: { date: string } | null;
			}[];
		};
		const broad = out.indices.find((i) => i.code === "broad");
		expect(out.as_of).toBe("2026-09-25");
		expect(broad?.latest?.date).toBe("2026-09-25");
		expect(broad?.latest?.is_provisional).toBe(true);
		expect(broad?.last_month_end?.date).toBe("2026-08-31");
	});

	test("a method the deployed service lacks fails loudly, never as an empty list", async () => {
		const call = getTreasuryIndex(
			{},
			{
				env: fakeTreasury({
					indexLevelsDailyOn: async () => {
						throw new TypeError(
							'The RPC receiver does not implement the method "indexLevelsDailyOn".',
						);
					},
				}),
			},
		);
		await expect(call).rejects.toThrow("NOT an absence of data");
	});

	test("links an index to its saferate.com page by SLUG, not by code", async () => {
		const out = (await getTreasuryIndex(
			{ code: "broad" },
			{
				env: fakeTreasury({
					curveSeries: async () => [],
					indexLevels: async () => MONTH_END,
				}),
			},
		)) as { next_steps: { index_url: string } };
		expect(out.next_steps.index_url).toBe(
			"https://saferate.com/treasury/indices/nominal",
		);
	});

	// "broad" is LOWERCASE in the code list while TIPS/AGG/20PL are upper, so
	// upper-casing the input broke the most obvious code a caller would type.
	// Found on staging, not here — the fake had been happy to answer anything.
	test("accepts the lowercase code as typed", async () => {
		const seen: string[] = [];
		const out = await getTreasuryIndex(
			{ code: "broad" },
			{
				env: fakeTreasury({
					// getIndexBaseDate reaches for the curve series to date the
					// index's base, so a fake with only indexLevels 503s.
					curveSeries: async () => [],
					indexLevels: async (input: { code: string }) => {
						seen.push(input.code);
						return [
							{
								code: "broad",
								constituents: 300,
								date: "2026-09-09",
								level: 180.2,
								methodology: "1.0",
								month_return: 0.004,
							},
						];
					},
				}),
			},
		);
		expect(out.ok).toBe(true);
		expect(seen[0]).toBe("broad");
	});

	test("resolves a code case-insensitively to its canonical spelling", async () => {
		const seen: string[] = [];
		await getTreasuryIndex(
			{ code: "tips" },
			{
				env: fakeTreasury({
					indexLevels: async (input: { code: string }) => {
						seen.push(input.code);
						return [];
					},
				}),
			},
		);
		expect(seen[0]).toBe("TIPS");
	});

	test("rejects an unknown code locally, without a round trip", async () => {
		let called = false;
		const out = await getTreasuryIndex(
			{ code: "nonsense" },
			{
				env: fakeTreasury({
					indexLevels: async () => {
						called = true;
						return [];
					},
				}),
			},
		);
		expect(out.ok).toBe(false);
		// Upstream 503s on an unknown code rather than refusing, so asking it
		// would have produced "[object Response]" instead of this.
		expect(called).toBe(false);
		expect(out.error).toBe("unknown_index");
	});

	test("lists the valid codes when given an unknown one", async () => {
		const out = await getTreasuryIndex(
			{ code: "nonsense" },
			{ env: fakeTreasury({}) },
		);
		expect(out.ok).toBe(false);
		expect(out.error).toBe("unknown_index");
		// Recoverable in one turn rather than by guessing.
		expect(out.message).toContain("broad");
		expect(out.message).toContain("TIPS");
	});
});

describe("get_treasury_debt — the two headline numbers", () => {
	test("insists on naming which debt figure is being quoted", async () => {
		const out = await getTreasuryDebt(
			{ on: "2026-08-31" },
			{
				env: fakeTreasury({
					debtSummary: async () => [
						{
							debt_held_public: 29_000_000,
							intragovernmental: 7_000_000,
							record_date: "2026-08-31",
							security_class: "_",
							security_type: "Total Public Debt Outstanding",
							total: 36_000_000,
						},
					],
				}),
			},
		);
		expect(out.ok).toBe(true);
		expect(out.how_to_report_this?.which_number).toContain("intragovernmental");
		expect(out.how_to_report_this?.as_of_meaning).toContain("IN FORCE");
	});
});

describe("get_savings_bond_rates", () => {
	test("separates the fixed component from the six-month composite", async () => {
		const out = await getSavingsBondRates(
			{ on: "2026-09-15" },
			{
				env: fakeTreasury({
					// Rates are DECIMALS upstream; the schema multiplies by 100.
					savingsBondRates: async () => [
						{
							composite_rate: 0.0428,
							fixed_rate: 0.012,
							period_start: "2026-05-01",
							semiannual_inflation_rate: 0.0154,
							series: "I",
						},
						{
							composite_rate: 0.025,
							fixed_rate: 0.025,
							period_start: "2026-05-01",
							semiannual_inflation_rate: null,
							series: "EE",
						},
					],
				}),
			},
		);
		expect(out.ok).toBe(true);
		expect(out.series_i?.how_it_works).toContain("reset every six months");
		expect(out.series_i?.how_it_works).toContain("compare the fixed rate");
	});
});
