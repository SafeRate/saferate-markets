import { z } from "zod";

/**
 * D1 operations for portfolios and their trades. Every read and write is scoped
 * by idOrganization in the SQL itself, so a guessed idPortfolio from another
 * customer finds nothing rather than relying on a check the caller might skip.
 */

const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ZPolicyIncome = z.enum(["cash", "reinvest", "distribute"]);

export const ZPortfolio = z.object({
	idPortfolio: z.string(),
	namePortfolio: z.string(),
	codeBenchmark: z.string().nullable(),
	policyIncome: ZPolicyIncome,
	createdAt: z.number(),
	updatedAt: z.number(),
	countTransactions: z.number().optional(),
});
export type TPortfolio = z.infer<typeof ZPortfolio>;

export const ZPortfolioTransaction = z.object({
	idTransaction: z.string(),
	idPortfolio: z.string(),
	cusip: z.string(),
	side: z.enum(["buy", "sell"]),
	tradeDate: zIsoDate,
	settleDate: zIsoDate,
	faceAmount: z.number(),
	cleanPrice: z.number(),
	account: z.string().nullable(),
	sourceTransaction: z.enum(["manual", "csv"]),
	idImport: z.string().nullable(),
	createdAt: z.number(),
});
export type TPortfolioTransaction = z.infer<typeof ZPortfolioTransaction>;

export const ZNewTransaction = z.object({
	cusip: z.string().regex(/^[0-9A-Z]{9}$/),
	side: z.enum(["buy", "sell"]),
	tradeDate: zIsoDate,
	settleDate: zIsoDate,
	faceAmount: z.number().positive(),
	cleanPrice: z.number().positive(),
	account: z.string().max(120).nullable(),
});
export type TNewTransaction = z.infer<typeof ZNewTransaction>;

type TScope = { db: D1Database; idOrganization: string };

export async function listPortfolios(input: TScope) {
	const result = await input.db
		.prepare(
			/* sql */ `
			select p.idPortfolio, p.namePortfolio, p.codeBenchmark, p.policyIncome, p.createdAt, p.updatedAt,
			       (select count(*) from portfolioTransactions t where t.idPortfolio = p.idPortfolio)
			         as countTransactions
			from portfolios p
			where p.idOrganization = ?
			order by p.createdAt
		`,
		)
		.bind(input.idOrganization)
		.all();
	return z.array(ZPortfolio).parse(result.results ?? []);
}

export async function getPortfolio(input: TScope & { idPortfolio: string }) {
	const row = await input.db
		.prepare(
			/* sql */ `
			select idPortfolio, namePortfolio, codeBenchmark, policyIncome, createdAt, updatedAt
			from portfolios where idPortfolio = ? and idOrganization = ?
		`,
		)
		.bind(input.idPortfolio, input.idOrganization)
		.first();
	return row === null ? null : ZPortfolio.parse(row);
}

export async function createPortfolio(
	input: TScope & {
		namePortfolio: string;
		codeBenchmark: string | null;
		policyIncome: z.infer<typeof ZPolicyIncome>;
	},
) {
	const name = z.string().trim().min(1).max(80).parse(input.namePortfolio);
	const idPortfolio = crypto.randomUUID();
	const now = Date.now();
	await input.db
		.prepare(
			/* sql */ `
			insert into portfolios
				(idPortfolio, idOrganization, namePortfolio, codeBenchmark, policyIncome, createdAt, updatedAt)
			values (?, ?, ?, ?, ?, ?, ?)
		`,
		)
		.bind(
			idPortfolio,
			input.idOrganization,
			name,
			input.codeBenchmark,
			ZPolicyIncome.parse(input.policyIncome),
			now,
			now,
		)
		.run();
	return idPortfolio;
}

export async function updatePortfolio(
	input: TScope & {
		idPortfolio: string;
		namePortfolio: string;
		codeBenchmark: string | null;
		policyIncome: z.infer<typeof ZPolicyIncome>;
	},
) {
	const name = z.string().trim().min(1).max(80).parse(input.namePortfolio);
	const result = await input.db
		.prepare(
			/* sql */ `
			update portfolios set namePortfolio = ?, codeBenchmark = ?, policyIncome = ?, updatedAt = ?
			where idPortfolio = ? and idOrganization = ?
		`,
		)
		.bind(
			name,
			input.codeBenchmark,
			ZPolicyIncome.parse(input.policyIncome),
			Date.now(),
			input.idPortfolio,
			input.idOrganization,
		)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

/** Deletes the portfolio and every trade in it. Hard delete: positions are not kept once removed. */
export async function deletePortfolio(input: TScope & { idPortfolio: string }) {
	const portfolio = await getPortfolio(input);
	if (portfolio === null) return false;
	await input.db.batch([
		input.db
			.prepare("delete from portfolioTransactions where idPortfolio = ?")
			.bind(input.idPortfolio),
		input.db
			.prepare(
				"delete from portfolios where idPortfolio = ? and idOrganization = ?",
			)
			.bind(input.idPortfolio, input.idOrganization),
	]);
	return true;
}

export async function listTransactions(
	input: TScope & { idPortfolio: string },
) {
	const result = await input.db
		.prepare(
			/* sql */ `
			select t.idTransaction, t.idPortfolio, t.cusip, t.side, t.tradeDate, t.settleDate,
			       t.faceAmount, t.cleanPrice, t.account, t.sourceTransaction, t.idImport, t.createdAt
			from portfolioTransactions t
			join portfolios p on p.idPortfolio = t.idPortfolio
			where t.idPortfolio = ? and p.idOrganization = ?
			order by t.tradeDate, t.createdAt
		`,
		)
		.bind(input.idPortfolio, input.idOrganization)
		.all();
	return z.array(ZPortfolioTransaction).parse(result.results ?? []);
}

/**
 * Adds trades in one batch, so an import lands whole or not at all. The caller
 * has already checked the resulting ledger (packages/portfolio checkTrades).
 */
export async function addTransactions(
	input: TScope & {
		idPortfolio: string;
		idUser: string;
		source: "manual" | "csv";
		transactions: TNewTransaction[];
	},
) {
	const portfolio = await getPortfolio(input);
	if (portfolio === null) return null;
	const rows = z
		.array(ZNewTransaction)
		.min(1)
		.max(5000)
		.parse(input.transactions);
	const idImport = input.source === "csv" ? crypto.randomUUID() : null;
	const now = Date.now();
	const statement = input.db.prepare(
		/* sql */ `
		insert into portfolioTransactions
			(idTransaction, idPortfolio, cusip, side, tradeDate, settleDate, faceAmount, cleanPrice,
			 account, sourceTransaction, idImport, idUserCreatedBy, createdAt)
		values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
	);
	await input.db.batch([
		...rows.map((row) =>
			statement.bind(
				crypto.randomUUID(),
				input.idPortfolio,
				row.cusip,
				row.side,
				row.tradeDate,
				row.settleDate,
				row.faceAmount,
				row.cleanPrice,
				row.account,
				input.source,
				idImport,
				input.idUser,
				now,
			),
		),
		input.db
			.prepare("update portfolios set updatedAt = ? where idPortfolio = ?")
			.bind(now, input.idPortfolio),
	]);
	return { count: rows.length, idImport };
}

export async function deleteTransaction(
	input: TScope & { idPortfolio: string; idTransaction: string },
) {
	const result = await input.db
		.prepare(
			/* sql */ `
			delete from portfolioTransactions
			where idTransaction = ? and idPortfolio = ?
			  and idPortfolio in (select idPortfolio from portfolios where idOrganization = ?)
		`,
		)
		.bind(input.idTransaction, input.idPortfolio, input.idOrganization)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

/** Undo one CSV import: every row it added. */
export async function deleteImport(
	input: TScope & { idPortfolio: string; idImport: string },
) {
	const result = await input.db
		.prepare(
			/* sql */ `
			delete from portfolioTransactions
			where idImport = ? and idPortfolio = ?
			  and idPortfolio in (select idPortfolio from portfolios where idOrganization = ?)
		`,
		)
		.bind(input.idImport, input.idPortfolio, input.idOrganization)
		.run();
	return result.meta?.changes ?? 0;
}
