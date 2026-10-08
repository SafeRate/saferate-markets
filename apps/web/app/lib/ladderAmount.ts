/** The amount a public ladder page is built for: client-safe, so the form can show it. */
export const DEFAULT_AMOUNT = 100_000;
const MIN_AMOUNT = 10_000;
const MAX_AMOUNT = 10_000_000;

/** The amount from a query string, clamped; anything unreadable is the default. */
export const amountFrom = (raw: string | null) => {
	const value = Number((raw ?? "").replace(/[,$\s]/g, ""));
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_AMOUNT;
	return Math.min(MAX_AMOUNT, Math.max(MIN_AMOUNT, Math.round(value)));
};
