import { describe, expect, test } from "bun:test";
import {
	bandRichCheap,
	rankTipsRichCheap,
	type TRichCheapRow,
} from "../src/reads/richCheap";

const row = (over: Partial<TRichCheapRow>): TRichCheapRow => ({
	cusip: "91282C000",
	family: "note",
	couponPercent: 4,
	maturityDate: "2030-01-15",
	yearsToMaturity: 5,
	price: 100,
	yieldPercent: 4,
	residualBasisPoints: 0,
	priceResidualCents: 0,
	zScore: 0,
	vsCurve: null,
	vsHistory: null,
	...over,
});

describe("rich/cheap by band", () => {
	test("ranks on z, not on the size of the residual", () => {
		// The consumer page's 2026-09-25 case: persistently rich by a lot,
		// ordinary that day, beside a bond barely off the curve but very unusual.
		const out = bandRichCheap([
			row({
				cusip: "LEVEL0001",
				yearsToMaturity: 25,
				priceResidualCents: 91.8,
				zScore: -0.24,
				residualBasisPoints: -6,
			}),
			row({
				cusip: "UNUSUAL01",
				yearsToMaturity: 25,
				priceResidualCents: 4,
				zScore: -3.1,
				residualBasisPoints: -0.3,
			}),
		]);
		const longBand = out.bands.find((b) => b.key === "20PL");
		expect(longBand?.rich.map((r) => r.cusip)).toEqual([
			"UNUSUAL01",
			"LEVEL0001",
		]);
	});

	test("a null z is counted and never ranked; a z of 0 is scoreable and in neither list", () => {
		const out = bandRichCheap([
			row({
				cusip: "UNSCORED1",
				zScore: null,
				residualBasisPoints: null,
				yieldPercent: null,
			}),
			row({ cusip: "ATAVERAGE", zScore: 0 }),
			row({ cusip: "CHEAPER01", zScore: 1.5, residualBasisPoints: 2 }),
		]);
		const band = out.bands.find((b) => b.key === "0307");
		expect(band?.total).toBe(3);
		expect(band?.scoreable).toBe(2);
		expect(band?.cheap.map((r) => r.cusip)).toEqual(["CHEAPER01"]);
		expect(band?.rich).toEqual([]);
	});

	test("bills are apart, by price residual, cheapest the most negative", () => {
		const out = bandRichCheap([
			row({
				cusip: "BILLRICH1",
				family: "bill",
				yearsToMaturity: 0.3,
				zScore: null,
				priceResidualCents: 2.5,
			}),
			row({
				cusip: "BILLCHEAP",
				family: "bill",
				yearsToMaturity: 0.3,
				zScore: null,
				priceResidualCents: -1.8,
			}),
			row({ cusip: "SHORTNOTE", yearsToMaturity: 0.5, zScore: 2 }),
		]);
		expect(out.bills.cheap[0].cusip).toBe("BILLCHEAP");
		expect(out.bills.rich[0].cusip).toBe("BILLRICH1");
		const under1 = out.bands.find((b) => b.key === "0001");
		expect(under1?.total).toBe(1);
		expect(under1?.cheap[0].cusip).toBe("SHORTNOTE");
	});

	test("a security on a band edge is in exactly one band", () => {
		const out = bandRichCheap([row({ yearsToMaturity: 3, zScore: 2 })]);
		expect(out.bands.reduce((s, b) => s + b.total, 0)).toBe(1);
		expect(out.bands.find((b) => b.key === "0307")?.total).toBe(1);
	});
});

describe("rankTipsRichCheap", () => {
	const tips = (cusip: string, years: number, z: number | null) =>
		({
			cusip,
			family: "tips",
			couponPercent: 1.875,
			maturityDate: "2034-07-15",
			yearsToMaturity: years,
			price: 100,
			yieldPercent: z === null ? null : 2.1,
			residualBasisPoints: z === null ? null : z * 2,
			priceResidualCents: 0,
			zScore: z,
			vsCurve: null,
			vsHistory: null,
		}) as TRichCheapRow;

	test("ranks on z within TIPS, never a null as zero, and drops the under-a-year ones", () => {
		const out = rankTipsRichCheap([
			tips("A", 5, 2.5),
			tips("B", 8, -3.1),
			tips("C", 3, null),
			tips("D", 0.5, 9),
			tips("E", 12, 0.4),
		]);
		expect(out.total).toBe(4);
		expect(out.scoreable).toBe(3);
		expect(out.cheap.map((r) => r.cusip)).toEqual(["A", "E"]);
		expect(out.rich.map((r) => r.cusip)).toEqual(["B"]);
	});
});
