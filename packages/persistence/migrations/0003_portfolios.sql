-- Portfolios and their trades, per organization (2026-09-29).
--
-- Customer positions are commercially sensitive, so they live HERE, in the
-- paying portal's database, scoped to an organization, and never in the
-- treasury database. The privacy policy's "Portfolio holdings" category
-- describes these two tables; change it with them.
--
-- A portfolio is its TRADES. Holdings, value, income and returns are derived
-- from them and the market's closes on every read (packages/portfolio), so
-- there is no stored balance to drift from the ledger. Maturities are not rows:
-- redemption is computed from the security's terms.

create table if not exists portfolios (
	idPortfolio text primary key,
	idOrganization text not null references organizations(idOrganization),
	namePortfolio text not null,
	-- A Safe Rate index code to benchmark against, or null.
	codeBenchmark text,
	-- Where coupons, redemptions and sale proceeds go: a TIncomePolicy from
	-- packages/portfolio ('cash' | 'reinvest' | 'distribute').
	policyIncome text not null default 'cash'
		check (policyIncome in ('cash', 'reinvest', 'distribute')),
	createdAt integer not null,
	updatedAt integer not null
);

create index if not exists idxPortfoliosOrganization on portfolios (idOrganization);

create table if not exists portfolioTransactions (
	idTransaction text primary key,
	idPortfolio text not null references portfolios(idPortfolio) on delete cascade,
	cusip text not null,
	side text not null check (side in ('buy', 'sell')),
	-- ISO dates. settleDate defaults to T+1 but is kept as entered.
	tradeDate text not null,
	settleDate text not null,
	-- Dollars of face, and the clean price per 100 paid or received.
	faceAmount real not null check (faceAmount > 0),
	cleanPrice real not null check (cleanPrice > 0),
	account text,
	-- 'manual' or 'csv'; idImport groups one file's rows so an import can be undone.
	sourceTransaction text not null,
	idImport text,
	idUserCreatedBy text not null,
	createdAt integer not null
);

create index if not exists idxPortfolioTransactionsPortfolio
	on portfolioTransactions (idPortfolio, tradeDate);
