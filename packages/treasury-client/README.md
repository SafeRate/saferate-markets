# @saferate/treasury-client

Typed, zod-parsed reads over the `TreasuryService` RPC entrypoint in
`apps/treasury-api`, for Workers that bind it as `TREASURY`.

Copied from `saferate-ai/packages/treasury` on 2026-09-28 (saferate-ai at
8e009c24) so that the repo owning the RPC methods also owns their client.
saferate-ai still carries its own copy and the two will drift until it moves
onto this one. This copy is the authority.

What this repo adds that the original could not have: `apps/treasury-api/src/clientContract.ts`
fails `tsc` when `TTreasuryService` stops describing the real class. On the day
it was copied that check found four methods whose client type promised a row
shape the service never declared (`indexAnalytics`, `indexReturns`,
`frnAnalytics`, `tipsAnalytics`); all four are zod-parsed on arrival, so the
fix was to declare `unknown`, which is what the service returns.

The check covers SOURCE drift only. The optional (`?`) methods exist for
DEPLOY skew, a consumer running against a worker older than this source, which
no compile step can see. Keep them optional.

`tests/` are the 14 of saferate-ai's consumer tests that exercise only this
package; the seven that also import consumer-app code stayed there.

One inherited behaviour to know before using it outside React Router:
`treasuryRead` throws a `Response` (503) after a failed retry, which is a
loader idiom. A Hono or MCP caller must catch it rather than letting it reach
the framework as a non-Error throw.
