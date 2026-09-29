-- Liability streams and saved Builder plans, per organization (2026-09-29).
--
-- Like portfolios (0003), these are customer data and live only here, scoped
-- to an organization in every statement. The privacy policy's "Portfolio
-- holdings, liabilities and plans" category describes them; change it with them.

-- A named schedule of amounts owed: a fund's payouts, a pension's benefits.
create table if not exists liabilityStreams (
	idLiabilityStream text primary key,
	idOrganization text not null references organizations(idOrganization),
	nameLiabilityStream text not null,
	createdAt integer not null,
	updatedAt integer not null
);

create index if not exists idxLiabilityStreamsOrganization on liabilityStreams (idOrganization);

create table if not exists liabilityCashflows (
	idLiabilityCashflow text primary key,
	idLiabilityStream text not null references liabilityStreams(idLiabilityStream) on delete cascade,
	-- ISO date the money is due, and the dollars due.
	dueDate text not null,
	amount real not null check (amount > 0),
	label text
);

create index if not exists idxLiabilityCashflowsStream on liabilityCashflows (idLiabilityStream, dueDate);

-- A Builder result as it was recommended: the inputs that produced it, and the
-- positions at the prices used then. A snapshot on purpose: prices move, and an
-- order sheet must say what was proposed, not what would be proposed today.
create table if not exists builderPlans (
	idPlan text primary key,
	idOrganization text not null references organizations(idOrganization),
	namePlan text not null,
	-- 'match' | 'immunise' | 'horizon' | 'index' | 'strategy' | 'custom'
	method text not null,
	idLiabilityStream text references liabilityStreams(idLiabilityStream) on delete set null,
	-- The price date the plan was costed on, and its settlement date.
	asOf text not null,
	settleDate text not null,
	-- JSON: the form inputs (budget, markup, horizon, template...) and the
	-- positions [{cusip, faceAmount, planPrice, dirtyPrice, cost}].
	inputsJson text not null,
	positionsJson text not null,
	cost real not null,
	idUserCreatedBy text not null,
	createdAt integer not null
);

create index if not exists idxBuilderPlansOrganization on builderPlans (idOrganization, createdAt);
