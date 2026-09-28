import { isTreasuryRefusal } from "@saferate/treasury-client/client";

/**
 * How every strict reader (indices, securities) calls TreasuryService. Split out
 * of indices.ts on 2026-09-28 when securities needed the same thing, so there is
 * one retry policy and one definition of "not deployed".
 */

export type TEnv = { TREASURY: unknown };

/** The service method this deployment lacks. A fault on our side, never data. */
export class TreasuryAbsent extends Error {
	constructor(method: string) {
		super(`treasury-api has no ${method} method in this deployment`);
		this.name = "TreasuryAbsent";
	}
}

const serviceOf = (env: TEnv) =>
	env.TREASURY as unknown as Record<string, (...args: unknown[]) => unknown>;

/**
 * How a deployment that LACKS a method shows itself, measured 2026-09-28
 * against the real binding: NOT as `undefined`. A Workers RPC stub answers
 * every property with a callable, so `typeof stub.anything` is "function", and
 * the failure only arrives on the call, as
 *   TypeError: The RPC receiver does not implement the method "<name>".
 * (Found by accident: an earlier version called `.bind` on the stub, and the
 * stub dutifully tried to invoke a remote method named "bind".) So the check
 * is on that error, not on the property; a typeof check passes only for fakes.
 */
const isMissingMethod = (error: unknown) =>
	error instanceof TypeError &&
	/does not implement the method/.test(error.message);

const RETRY_DELAY_MS = 50;

/**
 * treasuryRead's policy (refusals pass through; anything else retried once,
 * then a 503 Response), plus one thing it cannot do: a method this deployment
 * lacks becomes TreasuryAbsent at once, instead of being retried and reported as
 * an outage.
 */
const read = async (label: string, run: () => Promise<unknown>) => {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await run();
		} catch (error) {
			if (error instanceof TreasuryAbsent) throw error;
			if (isMissingMethod(error)) throw new TreasuryAbsent(label);
			if (isTreasuryRefusal(error)) throw error;
			console.error(
				`[treasury:${label}] read failed${attempt === 1 ? ", retrying once" : " after retry, serving 503"}:`,
				error,
			);
			if (attempt > 1) {
				throw new Response("Data temporarily unavailable", { status: 503 });
			}
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
		}
	}
};

/** Call a TreasuryService method by name, directly: never through a property. */
export const call =
	(env: { TREASURY: unknown }, name: string) =>
	(...args: unknown[]) =>
		read(name, async () => {
			const service = serviceOf(env);
			// Test fakes can genuinely lack the property.
			if (typeof service[name] !== "function") throw new TreasuryAbsent(name);
			return service[name](...args);
		});
