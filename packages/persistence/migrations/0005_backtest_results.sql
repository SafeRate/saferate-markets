-- Finished strategy backtests, shared across Workers (2026-09-29).
--
-- A backtest depends only on its inputs and on history, and history changes
-- only when a new close lands, so a result is keyed by the engine version,
-- the latest price date and the request. Nothing here is per customer. The
-- Workers cache was tried first and is per data centre: staging's requests
-- alternated between YYZ and ATL, so half of every repeat missed and paid
-- about 20 s again. Rows older than two weeks are pruned on write.

create table if not exists backtestResults (
	keyBacktest text primary key,
	datePrices text not null,
	payload text not null,
	createdAt integer not null
);

create index if not exists idxBacktestResultsCreated on backtestResults (createdAt);
