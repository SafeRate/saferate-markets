-- Billing: the Better Auth Stripe plugin's mirror, and our entitlement record.
--
-- Ported from saferate-oklocate migrations 0002, 0003 and 0008, folded and cut
-- down to one plan. OKLocate sells several products per organization; this
-- sells one, so the product dimension is gone and an organization has at most
-- one subscription row (decided 2026-09-28: one subscription per company).

-- The STRIPE MIRROR. Better Auth owns it, so its names break our conventions.
-- Columns read from the INSTALLED @better-auth/stripe@1.7.1 schema block
-- (dist/index.mjs, `const subscriptions`), not from the docs, which OKLocate
-- found wrong in three places. Diff against the package when bumping it.
--
-- Dates are TEXT: the adapter declares supportsDates: false, so Better Auth
-- writes toISOString() (see the header of 0001). Booleans are INTEGER 0/1.
--
-- This is NOT what decides access. organizationSubscriptions below is, and the
-- webhook callbacks in auth.server.ts are its only writer. Two tables that can
-- each answer "what plan is this account on" is how a customer ends up with two
-- answers.
create table if not exists subscription (
	id text primary key,
	plan text not null,
	-- Our idOrganization. authorizeReference checks the caller owns it, because
	-- it arrives in a request body and is attacker-supplied.
	referenceId text not null,
	stripeCustomerId text,
	stripeSubscriptionId text,
	status text not null default 'incomplete',
	periodStart text,
	periodEnd text,
	trialStart text,
	trialEnd text,
	cancelAtPeriodEnd integer default 0,
	cancelAt text,
	canceledAt text,
	endedAt text,
	seats integer,
	billingInterval text,
	stripeScheduleId text
);

create index if not exists idxSubscriptionReference on subscription (referenceId);
create index if not exists idxSubscriptionStripeId on subscription (stripeSubscriptionId);

-- The plugin adds this to the user model whether or not it is used for billing.
alter table user add column stripeCustomerId text;

-- THE ENTITLEMENT RECORD. authenticateApiKey joins this on every request.
create table if not exists organizationSubscriptions (
	idOrganizationSubscription text primary key,
	-- unique: one subscription per organization, enforced here rather than in
	-- checkout, so a double-clicked subscribe cannot produce a second one.
	idOrganization text not null unique references organizations(idOrganization),
	-- A PLANS id from @markets/schema. Free text, so adding a plan is not a
	-- migration.
	idPlan text not null,
	idStripeSubscription text,
	-- Stripe's vocabulary, mirrored: active | trialing | past_due | canceled |
	-- unpaid | incomplete | incomplete_expired.
	statusSubscription text not null,
	-- Epoch ms. startedAt is when WE first saw it live.
	startedAt integer not null,
	-- Set when the subscription is genuinely gone. A pending cancellation leaves
	-- this null and sets cancelsAt instead: the customer has paid through the
	-- period and keeps access until it ends.
	endedAt integer,
	-- From Stripe's cancel_at, NOT cancel_at_period_end, which Stripe leaves
	-- false for a period-end cancellation (OKLocate measured this on a live
	-- subscription, 2026-09-23). Cleared on resubscribe.
	cancelsAt integer,
	updatedAt integer not null
);
