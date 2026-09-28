-- Safe Rate Markets baseline schema.
--
-- Ported from saferate-oklocate, whose eight migrations are folded into one here
-- because nothing has been deployed yet. Conventions are OKLocate's: plural
-- camelCase table names, primary key named id<TableSingular>, camelCase columns.
--
-- Scope is accounts, API keys and usage. Billing tables arrive with billing
-- (migration 0002); a table nothing writes yet is a table that looks like a
-- feature.
--
-- DATES ARE TWO SHAPES, and this header said otherwise until 2026-09-28.
--
--   Better Auth's tables (user, session, account, verification) hold ISO 8601
--   TEXT. d1Adapter.ts declares supportsDates: false, so Better Auth converts a
--   date with toISOString() before it reaches D1. The columns below are declared
--   integer and SQLite's dynamic typing stores the string anyway. Measured on
--   the local D1 that day: typeof(user.createdAt) = 'text',
--   '2026-09-28T17:04:05.654Z'. OKLocate's migration 0003 records the same.
--
--   Our own tables (organizations onward) hold INTEGER epoch milliseconds,
--   written by our code with Date.now().
--
-- The integer declarations on Better Auth's columns are left as they are rather
-- than changed here, because staging applied this file the same day and an
-- edited migration makes new databases differ from old ones. Nothing reads those
-- columns as numbers. New Better Auth tables (0002 onward) declare dates TEXT.
--
-- Booleans are INTEGER 0/1 everywhere (supportsBooleans: false).

-- Better Auth owns these four. Column names are Better Auth's, so they break the
-- id<Table> convention above on purpose. OKLocate's `role` column is omitted:
-- nothing here has an admin surface yet.
create table if not exists user (
	id text primary key,
	name text,
	email text not null unique,
	emailVerified integer not null default 0,
	image text,
	createdAt integer not null,
	updatedAt integer not null
);

create table if not exists session (
	id text primary key,
	token text not null unique,
	userId text not null references user(id),
	expiresAt integer not null,
	ipAddress text,
	userAgent text,
	createdAt integer not null,
	updatedAt integer not null
);

create table if not exists account (
	id text primary key,
	userId text not null references user(id),
	accountId text not null,
	providerId text not null,
	accessToken text,
	refreshToken text,
	idToken text,
	accessTokenExpiresAt integer,
	refreshTokenExpiresAt integer,
	scope text,
	password text,
	createdAt integer not null,
	updatedAt integer not null
);

create table if not exists verification (
	id text primary key,
	identifier text not null,
	value text not null,
	expiresAt integer not null,
	createdAt integer not null,
	updatedAt integer not null
);

-- The billing subject and the API-key boundary. Carried from the first
-- migration even though every organization has exactly one member today,
-- because retrofitting tenancy under existing keys and subscriptions is the
-- expensive direction.
create table if not exists organizations (
	idOrganization text primary key,
	nameOrganization text not null,
	slug text not null unique,
	-- Set when the organization first reaches Stripe checkout. Write-once.
	idStripeCustomer text,
	createdAt integer not null,
	updatedAt integer not null
);

create table if not exists organizationMembers (
	idOrganizationMember text primary key,
	idOrganization text not null references organizations(idOrganization),
	idUser text not null references user(id),
	-- 'owner' | 'member'
	roleMember text not null default 'owner',
	createdAt integer not null,
	unique (idOrganization, idUser)
);

-- ONE SEAT PER ORGANIZATION, decided 2026-09-28, enforced here rather than in
-- the dashboard so no code path can add a second member by accident. Allowing
-- colleagues later is dropping this index, not a schema change.
create unique index if not exists idxOrganizationMembersOneSeat
	on organizationMembers (idOrganization);

-- A user belongs to one organization. ensureOrganization relies on it.
create unique index if not exists idxOrganizationMembersOneOrganization
	on organizationMembers (idUser);

-- API keys. The secret is NEVER stored: a sha-256 hash, plus a short prefix the
-- dashboard can show so a customer knows which key is which.
--
-- NO modeApiKey column. OKLocate carried one from migration 0001 that nothing
-- read for months, so a "test" key spent the paid allowance. There is no test
-- mode here, and a column that promises one is worse than its absence. Test
-- keys arrive with a column AND a separate data path together.
create table if not exists apiKeys (
	idApiKey text primary key,
	idOrganization text not null references organizations(idOrganization),
	nameApiKey text not null,
	prefixApiKey text not null,
	-- The lookup path on every authenticated request. unique is the index.
	hashApiKey text not null unique,
	idUserCreatedBy text not null references user(id),
	lastUsedAt integer,
	-- TWO death columns, and they are not interchangeable (OKLocate 0005):
	--   revokedAt   killed, immediately and deliberately. Always past.
	--   expiresAt   scheduled to stop. Future during a rotation's grace period.
	-- A key authenticates when revokedAt is null and (expiresAt is null or
	-- expiresAt > now), and both live in authenticateApiKey's WHERE clause.
	revokedAt integer,
	expiresAt integer,
	-- Which key this one replaced. Traceability only; nothing branches on it.
	idApiKeyRotatedFrom text references apiKeys(idApiKey),
	createdAt integer not null
);

create index if not exists idxApiKeysOrganizationCreated
	on apiKeys (idOrganization, createdAt);

-- One row per authenticated request. D1 is the record; Analytics Engine carries
-- the same events for exploration and is sampled, so it never feeds a figure a
-- customer is shown.
create table if not exists apiUsageEvents (
	idApiUsageEvent text primary key,
	idOrganization text not null references organizations(idOrganization),
	idApiKey text not null references apiKeys(idApiKey),
	-- 'rest' | 'mcp'
	surface text not null,
	-- REST: the matched route pattern, e.g. /v1/curves/{date}.
	-- MCP: the JSON-RPC method, and the tool for tools/call.
	operation text not null,
	statusCode integer not null,
	durationMs integer,
	createdAt integer not null
);

create index if not exists idxApiUsageEventsOrganizationCreated
	on apiUsageEvents (idOrganization, createdAt);

-- Monthly rollup, written in the same batch as the event, so the dashboard is
-- one indexed read rather than a scan.
create table if not exists apiUsageMonthly (
	idApiUsageMonthly text primary key,
	idOrganization text not null references organizations(idOrganization),
	-- 'YYYY-MM', UTC
	periodMonth text not null,
	surface text not null,
	countRequests integer not null default 0,
	-- 2xx only. A request we could not answer is not a request we served.
	countSucceeded integer not null default 0,
	updatedAt integer not null,
	unique (idOrganization, periodMonth, surface)
);
