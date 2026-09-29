import { settlementFor } from "./dates";

/**
 * Trades from a CSV, matched by HEADER NAME, not position, because no two
 * custodians order or name their columns alike. Each field has the aliases the
 * common exports use (custodian transaction files, Bloomberg PORT uploads,
 * broker trade blotters); headers are compared lowercased with everything but
 * letters and digits stripped, so "Trade Date", "trade_date" and "TRADEDATE"
 * are one name.
 *
 * All or nothing: any row that cannot be read fails the import, listed with
 * its line number, so a file is never half loaded. Maturities need no row
 * (redemption is computed); rows whose side says maturity or redemption are
 * skipped and counted.
 */

export const CSV_FIELDS = {
	cusip: [
		"cusip",
		"securityid",
		"identifier",
		"securityidentifier",
		"isin",
		"cusipisin",
	],
	side: [
		"side",
		"transactiontype",
		"transtype",
		"type",
		"action",
		"buysell",
		"bs",
		"direction",
	],
	faceAmount: [
		"face",
		"faceamount",
		"facevalue",
		"par",
		"paramount",
		"parvalue",
		"quantity",
		"qty",
		"originalface",
		"nominal",
		"units",
	],
	cleanPrice: [
		"price",
		"cleanprice",
		"tradeprice",
		"executionprice",
		"px",
		"unitprice",
	],
	tradeDate: [
		"tradedate",
		"date",
		"transactiondate",
		"executiondate",
		"tradedt",
	],
	settleDate: [
		"settledate",
		"settlementdate",
		"settledt",
		"valuedate",
		"settle",
	],
	account: ["account", "accountname", "accountnumber", "portfolio", "fund"],
} as const;

export type TCsvField = keyof typeof CSV_FIELDS;

export type TParsedTrade = {
	line: number;
	cusip: string;
	side: "buy" | "sell";
	tradeDate: string;
	settleDate: string;
	faceAmount: number;
	cleanPrice: number;
	account: string | null;
};

export type TCsvResult =
	| {
			ok: true;
			trades: TParsedTrade[];
			/** Which header was read for each field, so the page can show its reading. */
			mapping: Partial<Record<TCsvField, string>>;
			skippedMaturities: number;
	  }
	| { ok: false; errors: { line: number | null; message: string }[] };

const normalise = (header: string) =>
	header.toLowerCase().replace(/[^a-z0-9]/g, "");

/** RFC 4180 rows: quoted fields, doubled quotes, commas and newlines inside quotes. */
export const splitCsv = (text: string) => {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	const input = text.replace(/^﻿/, "");
	for (let i = 0; i < input.length; i += 1) {
		const ch = input[i];
		if (quoted) {
			if (ch === '"' && input[i + 1] === '"') {
				field += '"';
				i += 1;
			} else if (ch === '"') quoted = false;
			else field += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && input[i + 1] === "\n") i += 1;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += ch;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
};

/** ISO, or US month/day/year (2- or 4-digit year). Anything else is refused. */
export const parseDate = (raw: string) => {
	const value = raw.trim();
	const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
	let year: number;
	let month: number;
	let day: number;
	if (iso) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
	else if (us) {
		year = Number(us[3].length === 2 ? `20${us[3]}` : us[3]);
		[month, day] = [Number(us[1]), Number(us[2])];
	} else return null;
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	return date.toISOString().slice(0, 10);
};

/**
 * A price per 100: decimal (99.515625), or Treasury 32nds, where "99-16" is
 * 99 16/32, a trailing "+" adds 1/64, and a third digit is eighths of a 32nd
 * ("99-162" is 99 16.25/32).
 */
export const parsePrice = (raw: string) => {
	const value = raw.trim().replace(/[$,\s]/g, "");
	const ticks = /^(\d+)-(\d{2})([0-7+])?$/.exec(value);
	if (ticks) {
		const thirtySeconds = Number(ticks[2]);
		if (thirtySeconds > 31) return null;
		const extra =
			ticks[3] === undefined ? 0 : ticks[3] === "+" ? 0.5 : Number(ticks[3]) / 8;
		return Number(ticks[1]) + (thirtySeconds + extra) / 32;
	}
	const decimal = Number(value);
	return Number.isFinite(decimal) && decimal > 0 ? decimal : null;
};

const parseAmount = (raw: string) => {
	const value = raw
		.trim()
		.replace(/[$,\s]/g, "")
		.replace(/^\((.*)\)$/, "-$1");
	const number = Number(value);
	return value === "" || !Number.isFinite(number) ? null : number;
};

type TSideReading = "buy" | "sell" | "maturity" | null;

const parseSide = (raw: string): TSideReading => {
	const value = normalise(raw);
	if (
		["buy", "b", "by", "purchase", "bought", "buytoopen", "long"].includes(value)
	)
		return "buy";
	if (["sell", "s", "sl", "sale", "sold", "selltoclose"].includes(value))
		return "sell";
	if (["maturity", "matured", "redemption", "redeemed", "mat"].includes(value))
		return "maturity";
	return null;
};

/** A CUSIP, or the CUSIP inside a US ISIN (US + 9-character CUSIP + check digit). */
const parseCusip = (raw: string) => {
	const value = raw.trim().toUpperCase();
	if (/^[0-9A-Z]{9}$/.test(value)) return value;
	if (/^US[0-9A-Z]{9}[0-9]$/.test(value)) return value.slice(2, 11);
	return null;
};

export const parseTradesCsv = (text: string): TCsvResult => {
	const rows = splitCsv(text);
	if (rows.length < 2)
		return {
			ok: false,
			errors: [{ line: null, message: "The file has no data rows." }],
		};

	const headers = rows[0].map(normalise);
	const mapping: Partial<Record<TCsvField, string>> = {};
	const column: Partial<Record<TCsvField, number>> = {};
	for (const [field, aliases] of Object.entries(CSV_FIELDS) as [
		TCsvField,
		readonly string[],
	][]) {
		// The first alias in the list that is present wins, so "price" beats "px".
		for (const alias of aliases) {
			const index = headers.indexOf(alias);
			if (index !== -1) {
				column[field] = index;
				mapping[field] = rows[0][index].trim();
				break;
			}
		}
	}

	const missing = (
		["cusip", "faceAmount", "cleanPrice", "tradeDate"] as const
	).filter((field) => column[field] === undefined);
	if (missing.length > 0) {
		return {
			ok: false,
			errors: [
				{
					line: 1,
					message: `No column found for ${missing.join(", ")}. Headers read: ${rows[0].map((h) => `"${h.trim()}"`).join(", ")}. Accepted names include: ${missing.map((f) => `${f}: ${CSV_FIELDS[f].slice(0, 4).join(" / ")}`).join("; ")}.`,
				},
			],
		};
	}

	const cell = (row: string[], field: TCsvField) => {
		const index = column[field];
		return index === undefined ? "" : (row[index] ?? "");
	};

	const trades: TParsedTrade[] = [];
	const errors: { line: number; message: string }[] = [];
	let skippedMaturities = 0;
	rows.slice(1).forEach((row, i) => {
		const line = i + 2;
		const problems: string[] = [];
		const sideRaw = cell(row, "side");
		const side = column.side === undefined ? null : parseSide(sideRaw);
		if (side === "maturity") {
			skippedMaturities += 1;
			return;
		}
		if (column.side !== undefined && side === null)
			problems.push(`side "${sideRaw}" is not buy or sell`);

		const cusip = parseCusip(cell(row, "cusip"));
		if (cusip === null)
			problems.push(`"${cell(row, "cusip")}" is not a CUSIP or US ISIN`);

		const amount = parseAmount(cell(row, "faceAmount"));
		if (amount === null || amount === 0)
			problems.push(`face amount "${cell(row, "faceAmount")}" is not a number`);
		// With no side column, a negative quantity is a sale, as custodians write it.
		const resolvedSide = side ?? (amount !== null && amount < 0 ? "sell" : "buy");
		if (side !== null && amount !== null && amount < 0 && side === "buy")
			problems.push("a buy with a negative face amount");

		const cleanPrice = parsePrice(cell(row, "cleanPrice"));
		if (cleanPrice === null)
			problems.push(`price "${cell(row, "cleanPrice")}" is not a price per 100`);
		else if (cleanPrice > 200 || cleanPrice < 20)
			problems.push(
				`price ${cleanPrice} is not per 100 of face (a dollar amount?)`,
			);

		const tradeDate = parseDate(cell(row, "tradeDate"));
		if (tradeDate === null)
			problems.push(
				`trade date "${cell(row, "tradeDate")}" is not YYYY-MM-DD or MM/DD/YYYY`,
			);

		const settleRaw = cell(row, "settleDate").trim();
		const settleDate =
			settleRaw === ""
				? tradeDate === null
					? null
					: settlementFor(tradeDate)
				: parseDate(settleRaw);
		if (settleDate === null && tradeDate !== null)
			problems.push(`settlement date "${settleRaw}" is not a date`);
		if (settleDate !== null && tradeDate !== null && settleDate < tradeDate)
			problems.push("settles before it trades");

		if (
			problems.length > 0 ||
			cusip === null ||
			amount === null ||
			cleanPrice === null ||
			tradeDate === null ||
			settleDate === null
		) {
			errors.push({ line, message: problems.join("; ") });
			return;
		}
		const account = cell(row, "account").trim();
		trades.push({
			line,
			cusip,
			side: resolvedSide,
			tradeDate,
			settleDate,
			faceAmount: Math.abs(amount),
			cleanPrice,
			account: account === "" ? null : account,
		});
	});

	if (errors.length > 0) return { ok: false, errors };
	if (trades.length === 0)
		return {
			ok: false,
			errors: [{ line: null, message: "No trades in the file." }],
		};
	return { ok: true, trades, mapping, skippedMaturities };
};
