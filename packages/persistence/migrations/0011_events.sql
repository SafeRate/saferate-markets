-- The customer journey, first-party: who arrived from where, and every step they
-- took after. Written only by @markets/persistence's events.ts (recordEvent,
-- recordVisitor, linkVisitorToUser), the single copy of these INSERTs.
--
-- WHY: until now the only behavioural data was GA4 and Clarity — third-party,
-- sampled, gone for anyone who opts out, and blind inside /dashboard — and no
-- visit could be joined to the account it became. These two tables are the
-- dataset: one row per visitor, one row per thing that happened.
--
-- PRIVACY (see apps/web/app/lib/visitor.server.ts, and /privacy): a visitor row
-- and every BEHAVIOURAL event (page views, backtests run, plans built) exist only
-- when isAnalyticsPermitted() — no opt-out cookie, no GPC. ACCOUNT MILESTONES
-- (sign-up, key created, subscription changed) mirror records this database keeps
-- anyway and are always written, without a visitor id when not permitted. No
-- email address, name, IP address, API key or query string is ever stored here.
--
-- Epoch ms, like every table Markets owns.

-- One row per first-party visitor id (the markets_vid cookie), minted on the
-- first permitted page view. The touch fields are FIRST touch and never updated;
-- later touches are page_view events carrying their own utm/referrer.
create table if not exists visitors (
	idVisitor text primary key,
	firstSeenAt integer not null,
	landingPath text,
	-- Host only (e.g. "www.google.com"), never the full referring URL.
	referrerHost text,
	utmSource text,
	utmMedium text,
	utmCampaign text,
	utmTerm text,
	utmContent text,
	-- Which ad click id was present (gclid | fbclid | msclkid | li_fat_id), not its value.
	clickIdKind text,
	-- request.cf.country, two letters.
	country text,
	-- Set once, when this browser first signs in. One visitor maps to at most one
	-- user; a user may have several visitors (devices, cleared cookies).
	idUser text,
	linkedAt integer
);

create index if not exists idxVisitorsUser on visitors (idUser);

create table if not exists events (
	idEvent text primary key,
	-- A name from ZEventName in packages/persistence/src/events.ts.
	name text not null,
	occurredAt integer not null,
	idVisitor text,
	idUser text,
	idOrganization text,
	-- Path only, never the query string.
	path text,
	-- web (a request), api (apps/api), webhook (Stripe), email, cron.
	source text not null,
	-- Small JSON of primitives, validated per event name before it is written.
	propsJson text
);

create index if not exists idxEventsOccurredAt on events (occurredAt);
create index if not exists idxEventsNameOccurredAt on events (name, occurredAt);
create index if not exists idxEventsUser on events (idUser, occurredAt);
create index if not exists idxEventsOrganization on events (idOrganization, occurredAt);
create index if not exists idxEventsVisitor on events (idVisitor, occurredAt);
