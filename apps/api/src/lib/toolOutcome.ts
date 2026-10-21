/**
 * How an MCP tool call ended, read from what its handler returned. Same rules as
 * saferate-ai/apps/mcp/src/track.ts `envelopeOutcome`, so the two servers'
 * figures mean the same thing:
 *
 * - `inputRequests` present (MRTR): the tool asked for a missing argument. Not a
 *   failure, recorded as "input_required".
 * - A text-content envelope whose JSON says `ok: false`: a refusal, recorded as
 *   its `error` code (or "error" when it gives none).
 * - MCP's own `isError: true` with no such code: "tool_error". Markets' tools
 *   answer this way when the Treasury binding is older than the tool (plain
 *   text, not JSON), which Safe Rate's tools never do, hence this extra case.
 * - Anything else: success, recorded as null.
 *
 * Never throws: a tool that changes its response shape loses a metric, it does
 * not start failing.
 */
export const toolErrorCode = (result: unknown) => {
	if (typeof result !== "object" || result === null) return null;
	const envelope = result as Record<string, unknown>;
	if (envelope.inputRequests !== undefined) return "input_required";
	const fallback = envelope.isError === true ? "tool_error" : null;
	const content = envelope.content;
	if (!Array.isArray(content)) return fallback;
	const text = (content[0] as { text?: unknown } | undefined)?.text;
	if (typeof text !== "string") return fallback;
	try {
		const payload = JSON.parse(text) as { error?: unknown; ok?: unknown } | null;
		if (payload?.ok !== false) return fallback;
		return typeof payload.error === "string" ? payload.error.slice(0, 64) : "error";
	} catch {
		return fallback;
	}
};
