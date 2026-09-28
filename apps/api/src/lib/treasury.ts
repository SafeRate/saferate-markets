import {
	isTreasuryMethodMissing,
	isTreasuryRefusal,
	treasuryRefusalCode,
	treasuryRefusalMessage,
} from "@saferate/treasury-client/client";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { TreasuryAbsent } from "@markets/mcp-tools";

/**
 * The client returns null when the TREASURY binding is absent, the same null it
 * returns for "no curve that day". Over HTTP that would report a
 * misconfiguration as missing data: a 404 on every date, indistinguishable from
 * a weekend. So the binding is checked here, first, and its absence is a 503
 * that names itself.
 */
export const treasuryUnbound = (c: Context<AppEnv>) =>
	c.env.TREASURY === undefined
		? c.json(
				{
					error: "unavailable" as const,
					message:
						"The Treasury data service is not connected to this deployment. This is a fault on our side, not an absence of data.",
				},
				503,
			)
		: null;

/**
 * An error from the client, as an HTTP answer.
 *
 * Refusals are the service's 4xx (a malformed or uncovered date) and become 400
 * with the service's own message. A thrown 503 `Response` is the client's
 * outage signal after one retry; it is a React Router idiom, so it is caught
 * here rather than reaching Hono as a non-Error throw. Anything else is a bug and
 * is re-thrown to the error handler.
 */
export const treasuryErrorResponse = (c: Context<AppEnv>, error: unknown) => {
	// The deployed treasury-api lacks a method this route calls: deploy skew
	// between repos. Logged, because it is always our fault and always fixable.
	if (error instanceof TreasuryAbsent || isTreasuryMethodMissing(error)) {
		console.error("[treasury]", (error as Error).message);
		return c.json(
			{
				error: "unavailable" as const,
				message:
					"This data is not available from the Treasury service yet. This is a fault on our side, not an absence of data.",
			},
			503,
		);
	}
	if (error instanceof Response) {
		return c.json(
			{
				error: "unavailable" as const,
				message:
					"The Treasury data service is temporarily unavailable. This is an outage, not an absence of data; retrying shortly is reasonable.",
			},
			503,
		);
	}
	if (isTreasuryRefusal(error)) {
		return c.json(
			{
				error: "bad_request" as const,
				code: treasuryRefusalCode(error) ?? "refused",
				message:
					error instanceof Error
						? treasuryRefusalMessage(error)
						: "The Treasury service refused that request.",
			},
			400,
		);
	}
	throw error;
};
