-- Email alerts (decided with Dylan 2026-10-09): the Treasury daily rundown,
-- auction results and auction announcements. All free.
--
-- A user with NO row here gets the defaults: the rundown on, the auction
-- alerts off. That is how every existing account receives the rundown without
-- a backfill ("Daily rundown for all existing accounts is great"), and why a
-- row is only written when someone changes a setting or signs up with choices.
create table if not exists alertPreferences (
	idUser text primary key references user(id),
	rundown integer not null default 1,
	auctionResults integer not null default 0,
	auctionAnnouncements integer not null default 0,
	-- JSON array of term groups ("Note 10-Year"); null means every term.
	terms text,
	-- Stops everything without losing the choices above.
	paused integer not null default 0,
	-- Where the subscription came from ("saferate.com/treasury/auctions").
	source text,
	createdAt integer not null,
	updatedAt integer not null
);

-- One row per email per recipient, written BEFORE the send is attempted and
-- finished after it. The primary key is the exactly-once guarantee: a retry,
-- a second cron tick or an overlapping run cannot claim an event twice, and an
-- event with no row has not been sent. eventKey is the rundown's date, or an
-- auction's cusip|auctionDate.
create table if not exists alertSends (
	kind text not null,
	eventKey text not null,
	idUser text not null references user(id),
	-- claimed | sent | failed | withheld
	status text not null,
	reason text,
	createdAt integer not null,
	updatedAt integer not null,
	primary key (kind, eventKey, idUser)
);

create index if not exists alertSendsByEvent on alertSends (kind, eventKey);

-- Double opt-in for sign-ups from outside Markets (saferate.com's auctions
-- page). Nothing is subscribed until the emailed link is followed. The id is
-- a hash of the link's token, so the table never holds a usable link.
create table if not exists alertSignups (
	idAlertSignup text primary key,
	email text not null,
	rundown integer not null,
	auctions integer not null,
	source text,
	-- The visitor's address as the caller reported it, for rate limiting.
	ipAddress text,
	createdAt integer not null,
	expiresAt integer not null,
	confirmedAt integer
);

create index if not exists alertSignupsByEmail on alertSignups (email, createdAt);
create index if not exists alertSignupsByIp on alertSignups (ipAddress, createdAt);

-- Every event the sweep has seen, and when it first saw it. An event is sent
-- only while it is fresh (services/alertSweep.server.ts), so a new subscriber
-- is not sent a backlog, and a run cut short finishes the rest on the next
-- tick. The first sweep of a kind records what already exists as long since
-- seen (firstSeenAt 0) and sends none of it.
create table if not exists alertEvents (
	kind text not null,
	eventKey text not null,
	firstSeenAt integer not null,
	primary key (kind, eventKey)
);
