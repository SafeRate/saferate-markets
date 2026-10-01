/**
 * The shared, read-only demo organization (migration 0006, written by
 * scripts/demo-seed.ts). A signed-in account without a paid plan reads ITS
 * portfolios, liability stream and plan instead of its own, and can write
 * nothing: apps/web lib/session.server.ts requireDashboard. No user belongs
 * to it, so no one can sign in as it.
 */
export const DEMO_ORGANIZATION_ID = "demo";
