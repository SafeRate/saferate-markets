import { z } from "zod";

// Copied verbatim from saferate-ai/apps/mcp/src/clientIdentity.ts (8e009c24).

/**
 * Who is calling — read at the HTTP layer, not from the SDK context.
 *
 * MCP v2 carries the caller's self-description in the request `_meta` under
 * reverse-DNS keys (`io.modelcontextprotocol/clientInfo`,
 * `io.modelcontextprotocol/protocolVersion`) rather than in an `initialize`
 * handshake — the protocol is stateless, so there is no session for the server to
 * have remembered it from. Every request that wants it must read it off the wire.
 *
 * We parse it here from a CLONE of the request rather than reaching into the
 * server SDK's request context. The SDK does expose `CLIENT_INFO_META_KEY`, but
 * its published types are minified to single-letter aliases, so binding tracking
 * to that surface means depending on shapes that are not part of the documented
 * API and can move between patch releases. The `_meta` key names, by contrast,
 * are specified by the protocol. Cloning is cheap: MCP request bodies are small
 * JSON documents, and the clone is read only for metadata.
 *
 * Everything here is best-effort. A caller may send no `_meta` at all, and the
 * legacy 2025 fallback path sends a different envelope. Missing identity must
 * degrade to `null` dimensions on a metric, never to a failed tool call — so this
 * module has no throwing path.
 */

// Reverse-DNS `_meta` keys, per the v2 spec.
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";

/**
 * Lenient by design — a projector over untrusted input, not a validator.
 * `.catch()` on each field means a hostile or malformed value yields `undefined`
 * instead of rejecting the envelope and losing the fields that WERE well-formed.
 */
const ZClientIdentity = z.object({
	name: z.string().min(1).max(64).optional().catch(undefined),
	version: z.string().min(1).max(32).optional().catch(undefined),
	protocolVersion: z.string().min(1).max(32).optional().catch(undefined),
	/** The JSON-RPC method, so a `tools/call` can be told from a `tools/list`. */
	method: z.string().min(1).max(64).optional().catch(undefined),
	/** `Mcp-Name` — the tool/resource name, available even before the body parses. */
	name_header: z.string().min(1).max(96).optional().catch(undefined),
});
export type TClientIdentity = z.infer<typeof ZClientIdentity>;

export async function readClientIdentity(request: Request) {
	// Headers first: MCP v2 is HTTP-native, so these are present even when the body
	// is unparseable, and they cost nothing to read.
	const fromHeaders = {
		method: request.headers.get("Mcp-Method") ?? undefined,
		name_header: request.headers.get("Mcp-Name") ?? undefined,
	};

	if (request.method !== "POST") {
		return ZClientIdentity.parse(fromHeaders);
	}

	try {
		// Clone so the real handler still gets an unconsumed body.
		const body: unknown = await request.clone().json();
		const meta = _metaOf(body);
		const clientInfo = _objectAt(meta, META_CLIENT_INFO);

		return ZClientIdentity.parse({
			...fromHeaders,
			name: _stringAt(clientInfo, "name"),
			version: _stringAt(clientInfo, "version"),
			protocolVersion: _stringAt(meta, META_PROTOCOL_VERSION),
			method: _stringAt(body, "method") ?? fromHeaders.method,
		});
	} catch {
		// Unparseable or empty body — headers are still worth having.
		return ZClientIdentity.parse(fromHeaders);
	}
}

/**
 * `_meta` lives INSIDE `params`, not beside it. A sibling `_meta` is rejected by
 * the protocol as an invalid JSON-RPC message, so `params._meta` is the only
 * correct place to look; we check the top level too purely to be forgiving of
 * clients that get it wrong.
 */
function _metaOf(body: unknown) {
	const params = _objectAt(body, "params");
	return _objectAt(params, "_meta") ?? _objectAt(body, "_meta");
}

function _objectAt(source: unknown, key: string) {
	if (typeof source !== "object" || source === null) return undefined;
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function _stringAt(source: unknown, key: string) {
	if (typeof source !== "object" || source === null) return undefined;
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}
