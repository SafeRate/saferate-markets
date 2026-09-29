import { describe, expect, test } from "bun:test";
import { parseDate, parsePrice, parseTradesCsv, splitCsv } from "../src/csv";

describe("columns are matched by name, in any order", () => {
	test("a custodian-style export with its own names and order", () => {
		const csv = [
			"Account,Settlement Date,Security ID,Transaction Type,Quantity,Trade Price,Trade Date",
			'FUND-A,09/28/2026,91282CMM0,Buy,"1,000,000",96-17,09/25/2026',
			"FUND-A,2026-09-30,91282CMM0,SELL,250000,96.5,2026-09-29",
		].join("\n");
		const result = parseTradesCsv(csv);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.mapping).toEqual({
			account: "Account",
			settleDate: "Settlement Date",
			cusip: "Security ID",
			side: "Transaction Type",
			faceAmount: "Quantity",
			cleanPrice: "Trade Price",
			tradeDate: "Trade Date",
		});
		expect(result.trades[0]).toEqual({
			line: 2,
			cusip: "91282CMM0",
			side: "buy",
			tradeDate: "2026-09-25",
			settleDate: "2026-09-28",
			faceAmount: 1_000_000,
			cleanPrice: 96 + 17 / 32,
			account: "FUND-A",
		});
		expect(result.trades[1].side).toBe("sell");
	});

	test("the minimal file: no side, no settlement; a negative quantity is a sale", () => {
		const result = parseTradesCsv(
			"cusip,par,price,date\nUS91282CMM01,1000000,96,2026-09-25\n91282CMM0,-400000,97,2026-10-01\n",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The CUSIP inside a US ISIN; T+1 settlement when none is given.
		expect(result.trades[0]).toMatchObject({
			cusip: "91282CMM0",
			side: "buy",
			settleDate: "2026-09-28",
		});
		expect(result.trades[1]).toMatchObject({ side: "sell", faceAmount: 400_000 });
	});

	test("maturity rows are skipped and counted: redemption is computed", () => {
		const result = parseTradesCsv(
			"cusip,side,face,price,trade date\n912797UJ4,Maturity,100000,100,2026-10-01\n91282CMM0,buy,1000,96,2026-09-25\n",
		);
		expect(result.ok && result.skippedMaturities).toBe(1);
	});
});

describe("all or nothing, with line numbers", () => {
	test("every bad row is reported and nothing is imported", () => {
		const result = parseTradesCsv(
			"cusip,side,face,price,trade date\n91282CMM0,buy,1000,96,2026-09-25\nNOT-A-CUSIP,hold,abc,9650,31/12/2026\n",
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].line).toBe(3);
		for (const fragment of [
			"not a CUSIP",
			"not buy or sell",
			"not a number",
			"not per 100",
			"not YYYY-MM-DD",
		])
			expect(result.errors[0].message).toContain(fragment);
	});

	test("a missing required column names what it looked for", () => {
		const result = parseTradesCsv(
			"cusip,side,trade date\n91282CMM0,buy,2026-09-25\n",
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors[0].message).toContain("faceAmount");
		expect(result.errors[0].message).toContain("cleanPrice");
	});
});

describe("the pieces", () => {
	test("32nds: 99-16 is 99.5, a plus adds a 64th, a third digit is eighths", () => {
		expect(parsePrice("99-16")).toBe(99.5);
		expect(parsePrice("99-16+")).toBe(99.5 + 1 / 64);
		expect(parsePrice("99-162")).toBe(99 + 16.25 / 32);
		expect(parsePrice("99-32")).toBeNull();
		expect(parsePrice("$99.515625")).toBe(99.515625);
	});

	test("dates: ISO or US order, and impossible dates refused", () => {
		expect(parseDate("9/5/26")).toBe("2026-09-05");
		expect(parseDate("2026-02-30")).toBeNull();
		expect(parseDate("05.09.2026")).toBeNull();
	});

	test("quoted fields with commas and doubled quotes, CRLF, and a BOM", () => {
		expect(splitCsv('﻿a,"b,1","say ""hi"""\r\nx,y,z\r\n')).toEqual([
			["a", "b,1", 'say "hi"'],
			["x", "y", "z"],
		]);
	});
});

import { parseLiabilities } from "../src/csv";

describe("liabilities", () => {
	test("pasted lines with no header: date, amount, label", () => {
		const r = parseLiabilities(
			"2027-06-30, $1,000,000, Year 1 payout\n6/30/2028,1000000\n",
		);
		expect(r.ok && r.rows).toEqual([
			{
				line: 1,
				dueDate: "2027-06-30",
				amount: 1_000_000,
				label: "Year 1 payout",
			},
			{ line: 2, dueDate: "2028-06-30", amount: 1_000_000, label: null },
		]);
	});

	test("a CSV with its own column names, in any order", () => {
		const r = parseLiabilities(
			"Description,Payment,Payment Date\nBenefits,250000,2027-12-31\n",
		);
		expect(r.ok && r.rows[0]).toEqual({
			line: 2,
			dueDate: "2027-12-31",
			amount: 250_000,
			label: "Benefits",
		});
	});

	test("a header CSV with an unquoted thousands comma is refused, not read shifted", () => {
		const r = parseLiabilities(
			"date,amount,label\n2027-06-30,1,000,000,payout\n",
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0].message).toContain("quotes");
	});

	test("misgrouped commas in a pasted amount are refused", () => {
		expect(parseLiabilities("2027-06-30, 1,00,000").ok).toBe(false);
	});

	test("bad rows are all reported, and nothing is kept", () => {
		const r = parseLiabilities("2027-06-30,abc\n2027-13-01,100\n");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.map((e) => e.line)).toEqual([1, 2]);
	});
});
