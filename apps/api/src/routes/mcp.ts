import { registerTreasuryTools, type TWrapTool } from "@markets/mcp-tools";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../env";
import { readClientIdentity } from "../lib/clientIdentity";
import { apiKeyAuth } from "../middleware/apiKey";
import { meterUsage } from "../middleware/meter";

/**
 * The Safe Rate Markets MCP server: MCP v2 (revision 2026-07-28), Streamable
 * HTTP, stateless, at /mcp.
 *
 * The protocol handling is saferate-ai/apps/mcp's, unchanged: createMcpHandler
 * per request, no Durable Object, `legacy: "stateless"` so 2025-era clients
 * still connect. What differs is that this one is AUTHENTICATED and METERED, by
 * the same key and the same meter as the REST API, because it serves paying
 * institutions rather than the public.
 *
 * Authentication is the Bearer key for now. OAuth, which claude.ai and Claude
 * Desktop connectors prefer, is a later phase; saferate-ai's MCP_V2_DELTA.md
 * records that it should target Client ID Metadata Documents, not the
 * deprecated Dynamic Client Registration.
 */

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Delivered to the connecting assistant at discovery. Rewritten from the general
 * server's, which leads with mortgages: every word here costs context on every
 * connection, so it says only what a model gets wrong BEFORE choosing a tool.
 */
const SERVER_INSTRUCTIONS =
	"Safe Rate Markets serves U.S. Treasury market data: fitted yield curves (zero, par, money-market, TIPS real, breakeven), individual securities and their analytics, price and yield conversion, total-return indices, savings bond valuations and the federal debt statement. Figures are end-of-day records for business days from 2008-09-02 onward, not live trading prices; state the date any figure is as of. Index levels are TOTAL RETURNS, not yields, and a rising level usually means yields fell; the indices are constructed by Safe Rate and are not official U.S. Treasury statistics. Nothing returned is investment advice or an offer to trade.";

const buildServer = (env: Env, wrap: TWrapTool) => {
	const server = new McpServer(
		{ name: "saferate-markets", version: "0.1.0" },
		{
			instructions: SERVER_INSTRUCTIONS,
			// Listings are static per deploy and identical for every caller, so a
			// long public TTL is safe. There is no way to cache a tools/call, nor
			// should there be.
			cacheHints: {
				"tools/list": { ttlMs: ONE_HOUR_MS, cacheScope: "public" },
				"server/discover": { ttlMs: ONE_HOUR_MS, cacheScope: "public" },
			},
		},
	);
	registerTreasuryTools(server, { env }, wrap);
	return server;
};

/** `params.name` of a tools/call, read from a clone so the handler gets the body. */
const toolNameFromBody = async (request: Request) => {
	try {
		const body = (await request.clone().json()) as {
			params?: { name?: unknown };
		};
		const name = body?.params?.name;
		return typeof name === "string" && name.length <= 96 ? name : undefined;
	} catch {
		return undefined;
	}
};

export const registerMcpRoute = (app: OpenAPIHono<AppEnv>) => {
	app.use("/mcp", apiKeyAuth(), meterUsage("mcp"));

	app.all("/mcp", async (c) => {
		const client = await readClientIdentity(c.req.raw);
		// What the meter records: the JSON-RPC method, and the tool for a call.
		// The tool comes from the v2 `Mcp-Name` header when sent, else from the
		// body: measured 2026-09-28, a plain client sends no header, and every
		// call was recorded as a bare "tools/call" that said nothing about use.
		// Best effort throughout: an unparseable request is still counted.
		const tool =
			client.name_header ??
			(client.method === "tools/call"
				? await toolNameFromBody(c.req.raw)
				: undefined);
		c.set(
			"operation",
			[client.method ?? "unknown", tool].filter(Boolean).join(" "),
		);

		// JSON-RPC reports a thrown tool as an error INSIDE a 200. Without this
		// the meter would count a failed tool call as served.
		const wrap: TWrapTool =
			(_tool, run) =>
			async (...args) => {
				try {
					return await run(...args);
				} catch (error) {
					c.set("statusOverride", 500);
					throw error;
				}
			};

		const handler = createMcpHandler(() => buildServer(c.env, wrap), {
			legacy: "stateless",
		});
		return handler.fetch(c.req.raw);
	});
};
