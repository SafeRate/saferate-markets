import {
	isTreasuryMethodMissing,
	isTreasuryRefusal,
	treasuryRefusalCode,
	treasuryRefusalMessage,
	type TTreasuryEnv,
} from "@saferate/treasury-client/client";
import { TREASURY_COVERAGE_START } from "@saferate/treasury-client/types";
import { TreasuryAbsent } from "../reads/treasury";

/**
 * The parts every treasury tool shares.
 *
 * ── WHY THESE TOOLS ARE THIN ──────────────────────────────────────────────────
 * The package they call already parses every upstream row and already enforces
 * the redistribution gate in SQL upstream. So a tool here does four things and
 * nothing else: check the binding, translate a refusal into an answer, rename
 * keys for the model, and say what the number is not. Business logic that looks
 * like it belongs here belongs in @saferate/treasury-client instead, upstream
 * in saferate-treasury, where every consumer gets it.
 *
 * ── TWO PACKAGE FUNCTIONS ARE DELIBERATELY NOT WRAPPED ────────────────────────
 * `getLatestCurveOptional` and `getSavingsBondRatesOptional` exist so a React
 * Router page can swallow a 503 and render a degraded widget instead of failing
 * the whole route. That is right for a web page and wrong here. An assistant
 * told `null` will say "Safe Rate has no Treasury curve", which is a claim about
 * our coverage; the truth in that moment is that the upstream service is down.
 * Reporting an outage as missing data is the one failure mode these tools must
 * not have, so the non-Optional versions are used throughout and a real outage
 * is allowed to surface as an error.
 */

/** Treasury data is public record; none of it is advice or an offer to trade. */
export const DISCLOSURE_TREASURY =
	"Source data is published by the U.S. Department of the Treasury and its fiscal agents. Figures are historical or end-of-day records, not live trading prices, and are for information only — nothing here is investment advice, a quote, or an offer to buy or sell any security. Yields and valuations are computed by Safe Rate from that published data.";

/**
 * The public treasury pages on saferate.com, so a response can point at the
 * reviewed page. Deliberately saferate.com and not this portal: those pages are
 * the published, citable ones, and they carry the methodology.
 */
export const SITE_ORIGIN = "https://saferate.com";

/** Canonical treasury pages, so a response can point at the reviewed page. */
export const TREASURY_URLS = {
	auctions: `${SITE_ORIGIN}/treasury/auctions`,
	calculator: `${SITE_ORIGIN}/treasury/calculator`,
	curves: `${SITE_ORIGIN}/treasury/curves`,
	home: `${SITE_ORIGIN}/treasury`,
	indices: `${SITE_ORIGIN}/treasury/indices`,
	marketStatistics: `${SITE_ORIGIN}/treasury/market-statistics`,
	methodology: `${SITE_ORIGIN}/treasury/curves/methodology`,
	onTheRun: `${SITE_ORIGIN}/treasury/on-the-run`,
	rates: `${SITE_ORIGIN}/treasury/rates`,
	savingsBonds: `${SITE_ORIGIN}/treasury/savings-bonds`,
	securities: `${SITE_ORIGIN}/treasury/securities`,
	strips: `${SITE_ORIGIN}/treasury/strips`,
} as const;

export type TDepsTreasury = { env: TTreasuryEnv };

/** The envelope every treasury tool returns on the unhappy path. */
export type TTreasuryFailure = {
	ok: false;
	error: string;
	message: string;
};

/**
 * COVERAGE IS A REAL BOUNDARY, not a soft preference.
 *
 * The fitted curve history starts the day Lehman week began, because that is
 * where the price series starts. Asking for 2003 is not a sparse answer, it is
 * no answer, and saying so costs one round trip less than a 503.
 */
export const coverageStart = TREASURY_COVERAGE_START;

/**
 * Turn an upstream refusal into an answer rather than a protocol error.
 *
 * Refusals are the 4xx of this service — an unknown index code, a bond too old
 * to value, a range running off the end of coverage. The package re-throws them
 * untouched precisely so a caller can decide, and for an assistant the right
 * decision is always a readable message it can pass on, never an exception that
 * ends the turn. Anything that is NOT a refusal is re-thrown: a transport
 * failure has already been retried once inside the package, and swallowing it
 * here would report "no data" for what is really an outage.
 */
export const runTreasury = async <T>(
	run: () => Promise<T>,
): Promise<T | TTreasuryFailure> => {
	try {
		return await run();
	} catch (error) {
		if (!isTreasuryRefusal(error)) throw readableOutage(error);
		return {
			ok: false,
			error: treasuryRefusalCode(error) ?? "refused",
			message:
				error instanceof Error
					? treasuryRefusalMessage(error)
					: "The Treasury service refused that request.",
		};
	}
};

/**
 * Still a throw, but one that reads.
 *
 * The package signals an outage by throwing a `Response` — control flow that
 * React Router understands and the MCP SDK does not. The SDK stringifies
 * whatever it catches, so a 503 reached the assistant as the literal text
 * "[object Response]": no indication of what failed, and nothing it could tell
 * the user. Observed on staging 2026-09-17 before this existed.
 *
 * It is deliberately NOT converted into an `ok: false` envelope. An outage must
 * stay a failure, because the envelope is how these tools say "no such data" —
 * and reporting a service being down as missing data is the one confusion worth
 * this much care. The name is set so the tool-call tracker records something
 * better than "unknown".
 */
export const readableOutage = (error: unknown) => {
	// Deploy skew: the treasury service is older than this server. Still a
	// failure, never "no data", but one that says what it is.
	if (isTreasuryMethodMissing(error) || error instanceof TreasuryAbsent) {
		const readable = new Error(
			"This Treasury data is not available from the service yet (it is older than this server). This is a fault on Safe Rate's side, NOT an absence of data.",
		);
		readable.name = "TreasuryMethodMissing";
		return readable;
	}
	if (!(error instanceof Response)) return error;
	const readable = new Error(
		`The Treasury data service is unavailable (HTTP ${error.status}). This is an outage, NOT an absence of data — do not tell the user Safe Rate has no Treasury data for what they asked. Retrying in a moment is reasonable.`,
	);
	readable.name = "TreasuryUnavailable";
	return readable;
};

/** A `null` from the package means "nothing on that date", not a failure. */
export const noData = (what: string, when?: string): TTreasuryFailure => ({
	ok: false,
	error: "no_data",
	message: when
		? `Safe Rate has no ${what} for ${when}. Treasury publishes on business days only, so weekends, federal holidays and dates ahead of the last published day return nothing. Coverage starts ${coverageStart}.`
		: `Safe Rate has no ${what}.`,
});

/**
 * Keys the model sees, from keys the package produces.
 *
 * Applied to whole result objects rather than hand-mapped field by field, which
 * is the opposite of what the mortgage tools do and is deliberate. Those return
 * a dozen curated fields and rename each one on purpose. These return fitted
 * curves and TIPS analytics with thirty-odd fields apiece, where hand-mapping
 * buys nothing and guarantees that the next field added upstream is silently
 * dropped instead of passed through. Casing is the only thing being changed.
 */
export const snakeKeys = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(snakeKeys);
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	// Map and Set BEFORE the plain-object branch, and this is not defensive
	// tidying: getQueueYields returns both, and `JSON.stringify` renders either
	// as `{}` without erroring. An assistant would have been handed an empty
	// object where the yields were and had no way to know.
	if (value instanceof Map) {
		// VALUES are converted, KEYS are not. A Map here is keyed by data —
		// getQueueYields keys its yields and residuals by CUSIP — and a CUSIP is
		// an identifier, not a field name. Running the rename over it turned
		// "912810TW8" into "912810_tw8", which is a corrupted security id that
		// still looks plausible enough to be quoted back to someone.
		const out: Record<string, unknown> = {};
		for (const [key, inner] of value) out[String(key)] = snakeKeys(inner);
		return out;
	}
	if (value instanceof Set) return snakeKeys([...value]);
	const out: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
		out[toSnake(key)] = snakeKeys(inner);
	}
	return out;
};

/**
 * camelCase -> snake_case, splitting an acronym run from the word after it.
 *
 * The first version lowercased each capital RUN as one piece, so `residualZScore`
 * became `residual_zscore` and `marginZScore` `margin_zscore`, where upstream's
 * own columns (and every reader) say `residual_z_score`. Found 2026-09-28 while
 * pinning the securities schemas. Digits stay attached (`lambda1`, `dv01`,
 * `krd_10y` are unchanged).
 */
export const toSnake = (key: string) =>
	key
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase();

/** Today in UTC as YYYY-MM-DD — the default "on" for every dated lookup. */
export const todayIso = () => new Date().toISOString().slice(0, 10);
