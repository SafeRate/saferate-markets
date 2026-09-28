import { z } from "@hono/zod-openapi";
import { CHECKOUT_PLANS } from "@markets/schema";

/** One error envelope for every refusal, so a caller parses a single shape. */
export const ZError = z
	.object({
		error: z.enum([
			"bad_request",
			"unauthorized",
			"payment_required",
			"no_data",
			"unavailable",
			"rate_limited",
			"internal",
		]),
		message: z.string(),
		code: z.string().optional(),
		is_correctable: z.boolean().optional().openapi({
			description:
				"On a calculator refusal: whether different inputs can succeed (a bad date) or not (a valuation the series will never answer).",
		}),
	})
	.openapi("Error");

/**
 * The refusals the MIDDLEWARE can return on any /v1 route, before a handler
 * runs: apiKeyAuth (401, 402) and rateLimit (429). Every route spreads these
 * into its `responses`, so the published reference says what the Worker does.
 * tests/api.test.ts fails if a /v1 operation in the spec lacks any of them.
 *
 * Headers are documented too, so a client can discover its own limits from the
 * spec rather than from prose (OKLocate documents its quota headers this way).
 */
export const GATE_RESPONSES = {
	401: {
		content: { "application/json": { schema: ZError } },
		description: "No API key, or not a valid one.",
		headers: {
			"WWW-Authenticate": {
				schema: { type: "string" as const },
				description: 'Always `Bearer realm="saferate-markets"`.',
			},
		},
	},
	402: {
		content: { "application/json": { schema: ZError } },
		description:
			"A valid key whose organization has no active subscription. Subscribe in the dashboard; the same key then works.",
	},
	429: {
		content: { "application/json": { schema: ZError } },
		description: `Rate limit reached for your organization's plan (${CHECKOUT_PLANS.map((p) => `${p.name} ${p.sale.rateLimitPerMinute}/min`).join(", ")}), counting the REST API and MCP together.`,
		headers: {
			"Retry-After": {
				schema: { type: "integer" as const },
				description: "Seconds to wait. Always 60.",
			},
		},
	},
} as const;
