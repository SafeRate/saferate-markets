# saferate-markets

Safe Rate Markets: U.S. Treasury market data for institutions, over a REST API
and an MCP server, at [saferate.markets](https://saferate.markets).

- `apps/api` — api.saferate.markets: `/v1/*` REST, `/mcp`, generated reference at `/reference`
- `apps/web` — saferate.markets: sign-in, dashboard, API keys, docs
- `packages/mcp-tools` — the Treasury MCP tools (the authority for them)
- `packages/treasury-client` — vendored from saferate-treasury

Start with `CLAUDE.md`.

```bash
bun install
bash scripts/bash/migrate-local.sh
bash scripts/bash/dev-api.sh    # :5320
bash scripts/bash/dev-web.sh    # :3020
```
