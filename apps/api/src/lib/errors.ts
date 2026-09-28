import { z } from "@hono/zod-openapi";

/** One error envelope for every refusal, so a caller parses a single shape. */
export const ZError = z
	.object({
		error: z.enum([
			"bad_request",
			"unauthorized",
			"no_data",
			"unavailable",
			"rate_limited",
			"internal",
		]),
		message: z.string(),
		code: z.string().optional(),
	})
	.openapi("Error");
