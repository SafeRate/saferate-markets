-- One row per failure a visitor or customer could have seen, from both Workers
-- and from the visitor's browser. Written only by @markets/persistence's
-- recordSiteError, the single copy of this INSERT.
--
-- WHY: until now every failure went to console.error, and Workers Logs keeps 7
-- days. handleError in apps/web/app/entry.server.tsx carried a TODO for exactly
-- this table. The saferate-ai daily report reads it to put Markets' errors on
-- the same agenda as saferate.com's.
--
-- `code` says where the row came from, and is the only thing that does:
--   web-render  React Router caught it server-side (loader, action, render). Has a stack.
--   web-server  apps/web returned >= 500 with no handleError call, or threw outside the router.
--   web-cron    the scheduled() handler (the five-minute alerts sweep) failed.
--   web-client  an uncaught error or unhandled rejection in the visitor's browser.
--   api-server  apps/api's onError: an unhandled throw on api.saferate.markets.
--
-- Epoch ms, like every table Markets owns (Better Auth's are ISO text).
create table if not exists siteErrors (
	idSiteError text primary key,
	code text not null,
	path text,
	message text not null,
	stack text,
	cfRay text,
	createdAt integer not null
);

create index if not exists idxSiteErrorsCreatedAt on siteErrors (createdAt);
create index if not exists idxSiteErrorsCodeCreatedAt on siteErrors (code, createdAt);
