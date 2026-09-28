import type { TSurface } from "@markets/persistence";

/**
 * The Hono environment for this Worker.
 *
 * `Variables` is the contract between middleware and handlers. `auth` is set
 * BEFORE a handler runs; `operation` and `outcome` are set BY the handler and
 * read afterwards by the meter, which is why they are optional: a handler that
 * throws never sets them, and the meter must cope.
 */

export type TApiKeyAuth = {
	idOrganization: string;
	idApiKey: string;
	lastUsedAt: number | null;
	/** The live subscription's plan, which sets the rate limit. */
	idPlan: string | null;
};

export type AppEnv = {
	Bindings: Env;
	Variables: {
		auth: TApiKeyAuth;
		startedAt: number;
		surface: TSurface;
		/** What the meter records. Defaults to the matched route pattern. */
		operation?: string;
		/**
		 * Set only when the HTTP status does not tell the truth about the work.
		 * An MCP tool that THREW still answers HTTP 200, because JSON-RPC carries
		 * the error in the body; the meter would count it as served without this.
		 */
		statusOverride?: number;
	};
};
