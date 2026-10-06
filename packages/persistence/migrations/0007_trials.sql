-- The 30-day Team trial (TRIAL in @markets/schema, decided 2026-10-06).
--
-- When the trial ends, in epoch milliseconds like the rest of this table. Null
-- means no trial. Set by ensureOrganization for every new organization; an
-- extension is an UPDATE of this column and nothing else.
alter table organizations add column trialEndsAt integer;

-- Accounts that already existed get 30 days from launch: through 2026-11-05,
-- ending at 2026-11-06T00:00:00Z. Not the demo organization, which nobody owns.
update organizations
set trialEndsAt = 1793923200000
where idOrganization != 'demo';
