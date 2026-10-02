/**
 * `auctionsBetween` rows in the shape treasury-api SENDS (snake_case,
 * `SELECT a.*, d.maturity_date, d.interest_rate` plus a derived `kind`), for
 * the auction tests here and in apps/api/tests.
 *
 * THE 4-WEEK HISTORY IS REAL: the seven most recent 4-week bill auctions to
 * 2026-10-01, bid-to-cover and primary-dealer share as treasury-integration
 * read them from production (2026-10-02). saferate.com, over six priors,
 * publishes bid-to-cover +0.00 and dealers -0.8863 pt for 912797VP9; the tests
 * hold our analysis to the same figures. An eighth, older auction is added
 * with outlying figures, so a window that wrongly took seven priors would show.
 */

type TRow = Record<string, unknown>;

/** A held auction with competitive shares summing to 100 (in $bn), so share = figure. */
export const auctionRow = (
	over: TRow & { cusip: string; auction_date: string },
): TRow => ({
	issue_date: over.auction_date,
	original_security_term: "17-Week",
	security_term: "4-Week",
	reopening: 1,
	kind: "Bill",
	maturity_date: "2026-11-03",
	interest_rate: 0,
	offering_amount: 100e9,
	total_tendered: 283e9,
	total_accepted: 100e9,
	bid_to_cover_ratio: 2.83,
	high_yield: null,
	high_discount_rate: 3.89,
	low_discount_rate: 3.8,
	average_median_discount_rate: 3.84,
	high_investment_rate: 3.956,
	average_median_yield: null,
	low_yield: null,
	high_discount_margin: null,
	primary_dealer_accepted: 31.3649e9,
	direct_bidder_accepted: 4.7351e9,
	indirect_bidder_accepted: 63.9e9,
	noncompetitive_accepted: 0.5e9,
	soma_accepted: 7.1e9,
	fima_noncompetitive_accepted: 0,
	allocation_percentage: 43.5,
	price_per100: 99.7,
	...over,
});

/** dealer share, percent -> the three competitive awards (sum 100, in $bn). */
const shares = (dealerPercent: number) => ({
	primary_dealer_accepted: dealerPercent * 1e9,
	indirect_bidder_accepted: (95.2649 - dealerPercent) * 1e9,
	direct_bidder_accepted: 4.7351e9,
});

/** The real seven, newest first, plus an outlying eighth. */
export const FOUR_WEEK = [
	["912797VP9", "2026-10-01", "2026-10-06", 2.83, 31.3649],
	["912797VN4", "2026-09-24", "2026-09-29", 2.61, 50.3773],
	["912797VM6", "2026-09-17", "2026-09-22", 3.02, 27.0261],
	["912797VL8", "2026-09-10", "2026-09-15", 2.81, 24.3023],
	["912797VK0", "2026-09-03", "2026-09-08", 2.97, 29.038],
	["912797VJ3", "2026-08-27", "2026-09-01", 2.73, 31.4896],
	["912797VH7", "2026-08-20", "2026-08-25", 2.84, 31.2736],
	["912797VG9", "2026-08-13", "2026-08-18", 9.99, 90.0],
].map(([cusip, auction_date, issue_date, cover, dealer]) =>
	auctionRow({
		cusip: cusip as string,
		auction_date: auction_date as string,
		issue_date: issue_date as string,
		bid_to_cover_ratio: cover as number,
		...shares(dealer as number),
	}),
);

/** The newest priced day these tests stand on: VP9 is held but not issued. */
export const ON = "2026-10-02";

/** A NEW 3-year note, announced: no details row yet, no results. */
export const NEW_THREE_YEAR = auctionRow({
	cusip: "91282CRQ6",
	auction_date: "2026-10-06",
	issue_date: "2026-10-15",
	original_security_term: "3-Year",
	security_term: "3-Year",
	reopening: 0,
	kind: "Note",
	maturity_date: null,
	interest_rate: null,
	offering_amount: 58e9,
	total_tendered: null,
	total_accepted: null,
	bid_to_cover_ratio: null,
	high_discount_rate: null,
	low_discount_rate: null,
	average_median_discount_rate: null,
	high_investment_rate: null,
	primary_dealer_accepted: null,
	direct_bidder_accepted: null,
	indirect_bidder_accepted: null,
	soma_accepted: null,
	allocation_percentage: null,
	price_per100: null,
});

/** A reopened 10-year, settled: groups as a 10-year, prices on yield. */
export const TEN_YEAR = auctionRow({
	cusip: "91282CRF0",
	auction_date: "2026-09-09",
	issue_date: "2026-09-15",
	original_security_term: "10-Year",
	security_term: "9-Year 11-Month",
	reopening: 1,
	kind: "Note",
	maturity_date: "2036-08-15",
	interest_rate: 4.625,
	offering_amount: 39e9,
	bid_to_cover_ratio: 2.71,
	high_yield: 4.834,
	average_median_yield: 4.769,
	high_discount_rate: null,
	low_discount_rate: null,
	average_median_discount_rate: null,
	high_investment_rate: null,
});

/** A floating-rate note: discount margin, no median. */
export const FRN = auctionRow({
	cusip: "91282CRA1",
	auction_date: "2026-09-24",
	issue_date: "2026-09-26",
	original_security_term: "2-Year",
	security_term: "1-Year 10-Month",
	kind: "FRN",
	maturity_date: "2028-07-31",
	interest_rate: 0.12,
	high_discount_margin: 0.15,
	high_discount_rate: null,
	low_discount_rate: null,
	average_median_discount_rate: null,
	high_investment_rate: null,
});

export const ALL_ROWS = [...FOUR_WEEK, NEW_THREE_YEAR, TEN_YEAR, FRN];

/** A fake TREASURY whose auctionsBetween filters ALL_ROWS by date, as upstream. */
export const fakeAuctionTreasury = (rows: TRow[] = ALL_ROWS) => ({
	latestPriceDate: async () => ON,
	auctionsBetween: async ({ from, to }: { from: string; to: string }) =>
		rows.filter(
			(r) =>
				(r.auction_date as string) >= from && (r.auction_date as string) <= to,
		),
});
