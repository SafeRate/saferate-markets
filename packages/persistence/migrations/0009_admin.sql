-- Support access (asked for by Dylan 2026-10-20): an admin can open /support
-- and sign in as a customer to see what they see. Better Auth's admin plugin
-- does the impersonation; these are the columns it reads and writes, from the
-- INSTALLED better-auth@1.7.1 (dist/plugins/admin/schema.mjs), not the docs.
--
-- Dates are TEXT and booleans INTEGER 0/1, as everywhere else Better Auth
-- writes through the D1 adapter (supportsDates and supportsBooleans false).
alter table user add column role text;
alter table user add column banned integer default 0;
alter table user add column banReason text;
alter table user add column banExpires text;

-- Set on a session an admin started as someone else: the admin's user id.
-- Null on every ordinary session. The audit trail of who looked at what.
alter table session add column impersonatedBy text;

-- The one admin. Others are added the same way, by hand, on purpose: there is
-- no screen that grants admin.
update user set role = 'admin' where lower(email) = 'dylan@saferate.com';
