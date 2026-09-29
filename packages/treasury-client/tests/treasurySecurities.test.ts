import { describe, expect, test } from "bun:test";
import {
   ANALYSED_FAMILIES,
   BILL_ANNUALISATION_FLOOR_DAYS,
   KEY_RATE_TENORS,
   securityFamilyFromPriceType,
   ZSecurityAnalytics,
   ZSecurityDetail,
   ZSecurityPrice,
} from "@saferate/treasury-client/types";

// Rows copied VERBATIM from the treasury D1 store on 2026-09-09 for 912828U24,
// a 2% ten-year note issued 2016-11-15 and maturing 2026-11-15. Chosen because
// it exercises three things a synthetic row would not:
//
//   * its last analytics row (2026-08-13) PREDATES its last price (2026-09-01),
//     because analytics stop ~3 months before maturity while pricing continues
//   * its key rate durations are concentrated in one bucket, since it has one
//     cashflow left — the true shape, not missing data
//   * its residual_z_score is null despite 2,438 observations

const DETAIL = {
   cusip: "912828U24",
   security_type: "Note",
   original_security_term: "10-Year",
   maturity_date: "2026-11-15",
   dated_date: "2016-11-15",
   first_interest_payment_date: "2017-05-15",
   interest_rate: 2,
   interest_payment_frequency: "Semi-Annual",
   callable: 0,
   floating_rate: 0,
   spread: null,
} as const;

const AUCTION = {
   cusip: "912828U24",
   auction_date: "2016-11-09",
   issue_date: "2016-11-15",
   original_security_term: "10-Year",
   reopening: 0,
   offering_amount: 23000000000,
   total_accepted: 28035256900,
   bid_to_cover_ratio: 2.22,
   high_yield: 2.02,
} as const;

const ANALYTICS_LATEST = {
   date: "2026-08-13",
   cusip: "912828U24",
   ytm: 3.8538438315143626,
   dirty_price: 100.0258152173913,
   macaulay_duration: 0.25271739130434784,
   modified_duration: 0.250279832523068,
   dv01: 0.002503444428059204,
   convexity: 0.12527998913555,
   price_residual_cents: 1.799574078194155,
   residual_basis_points: -7.1883923526486075,
   residual_z_score: null,
   krd_03m: 0.24990805029086133,
   krd_06m: 0.004886470257083889,
   krd_01y: 0,
   krd_02y: 0,
   krd_03y: 0,
   krd_05y: 0,
   krd_07y: 0,
   krd_10y: 0,
   krd_15y: 0,
   krd_20y: 0,
   krd_25y: 0,
   krd_30y: 0,
} as const;

const PRICE_LATEST = {
   cusip: "912828U24",
   date: "2026-09-01",
   security_type: "MARKET BASED NOTE",
   rate: 0.02,
   maturity_date: "2026-11-15",
   call_date: null,
   buy: 0,
   sell: 99.59375,
   close: 99.59375,
} as const;

describe("ZSecurityDetail", () => {
   test("parses a real note and renames the units-ambiguous fields", () => {
      const detail = ZSecurityDetail.parse({ ...DETAIL, auctions: [AUCTION] });

      // `interest_rate` is a PERCENT here (2 for a 2% note) while the price
      // row's `rate` is a DECIMAL (0.02). Same security, same concept, two
      // units on near-identical names — hence couponPercent on both sides.
      expect(detail.couponPercent).toBe(2);
      expect(detail.maturityDate).toBe("2026-11-15");
      expect(detail.originalSecurityTerm).toBe("10-Year");
      expect(detail.paymentFrequency).toBe("Semi-Annual");
      expect(detail.isCallable).toBe(false);
      expect(detail.hasFloatingRate).toBe(false);
      expect(typeof detail.isCallable).toBe("boolean");
   });

   test("auctions default to empty rather than undefined", () => {
      const detail = ZSecurityDetail.parse(DETAIL);
      expect(detail.auctions).toEqual([]);
   });

   test("parses the auction, including the reopening flag as a boolean", () => {
      const detail = ZSecurityDetail.parse({ ...DETAIL, auctions: [AUCTION] });
      const auction = detail.auctions[0];

      expect(auction.auctionDate).toBe("2016-11-09");
      expect(auction.isReopening).toBe(false);
      expect(auction.bidToCoverRatio).toBeCloseTo(2.22, 2);
      expect(auction.offeringAmount).toBe(23_000_000_000);
   });

   test("a row from before the result columns leaves them null, not missing", () => {
      const auction = ZSecurityDetail.parse({ ...DETAIL, auctions: [AUCTION] })
         .auctions[0];
      expect(auction.primaryDealerAccepted).toBeNull();
      expect(auction.indirectBidderAccepted).toBeNull();
      expect(auction.medianYield).toBeNull();
      expect(auction.securityTerm).toBeNull();
   });

   test("keeps who bought it and the rates it cleared at", () => {
      // The columns upstream's ZSecurityAuctionRow carries after the results
      // were added; until 2026-09-29 this schema dropped them on parse.
      const auction = ZSecurityDetail.parse({
         ...DETAIL,
         auctions: [
            {
               ...AUCTION,
               security_term: "10-Year",
               total_tendered: 62_300_000_000,
               primary_dealer_accepted: 4_100_000_000,
               direct_bidder_accepted: 4_500_000_000,
               indirect_bidder_accepted: 14_400_000_000,
               noncompetitive_accepted: 30_000_000,
               soma_accepted: 5_000_000_000,
               fima_noncompetitive_accepted: 0,
               allocation_percentage: 41.53,
               low_yield: 1.9,
               average_median_yield: 1.98,
               price_per100: 99.8,
            },
         ],
      }).auctions[0];
      expect(auction.primaryDealerAccepted).toBe(4_100_000_000);
      expect(auction.indirectBidderAccepted).toBe(14_400_000_000);
      expect(auction.somaAccepted).toBe(5_000_000_000);
      expect(auction.allocationPercentage).toBeCloseTo(41.53, 2);
      expect(auction.medianYield).toBeCloseTo(1.98, 2);
      expect(auction.pricePer100).toBeCloseTo(99.8, 2);
      expect(auction.highDiscountMargin).toBeNull();
   });
});

describe("ZSecurityPrice", () => {
   test("parses a real price row and converts the coupon to percent", () => {
      const price = ZSecurityPrice.parse(PRICE_LATEST);

      expect(price.date).toBe("2026-09-01");
      expect(price.close).toBeCloseTo(99.59375, 5);
      // rate 0.02 -> 2%, matching the detail row's interest_rate of 2.
      expect(price.couponPercent).toBeCloseTo(2, 10);
      expect(price.securityType).toBe("MARKET BASED NOTE");
   });

   test("a zero bid becomes null, because it means NO bid", () => {
      // 118,359 of 1,700,678 rows carry buy = 0, about 7%, including 32 on
      // 2026-09-01. A real one: 912797RS8 that day had buy 0 against a close of
      // 99.99. Rendering 0 into a bid column would be the most visibly wrong
      // number on the page.
      const price = ZSecurityPrice.parse({ ...PRICE_LATEST, buy: 0 });

      expect(price.bid).toBeNull();
      expect(price.close).toBeCloseTo(99.59375, 5);
   });

   test("a real bid is preserved rather than being treated as missing", () => {
      const price = ZSecurityPrice.parse({ ...PRICE_LATEST, buy: 99.5 });
      expect(price.bid).toBeCloseTo(99.5, 5);
   });
});

describe("ZSecurityAnalytics", () => {
   test("parses a real analytics row", () => {
      const row = ZSecurityAnalytics.parse(ANALYTICS_LATEST);

      expect(row.date).toBe("2026-08-13");
      expect(row.ytm).toBeCloseTo(3.8538, 4);
      expect(row.modifiedDuration).toBeCloseTo(0.2503, 4);
      expect(row.dv01).toBeCloseTo(0.0025, 4);
      expect(row.keyRateDurations).toHaveLength(12);
      expect(row.keyRateDurations).toHaveLength(KEY_RATE_TENORS.length);
   });

   test("key rate durations concentrate in one bucket near maturity", () => {
      const row = ZSecurityAnalytics.parse(ANALYTICS_LATEST);
      const material = row.keyRateDurations.filter(
         (bucket) => Math.abs(bucket.value) >= 0.0005,
      );

      // Three months from maturity, essentially all sensitivity is at 3M. That
      // is the instrument, not a gap — which is why the profile renders it as
      // one filled bar rather than a row of dashes.
      expect(material).toHaveLength(2);
      expect(material[0].label).toBe("3M");
      expect(material[0].value).toBeCloseTo(0.2499, 4);
   });

   test("key rate durations stay in curve order", () => {
      const row = ZSecurityAnalytics.parse(ANALYTICS_LATEST);
      const years = row.keyRateDurations.map((bucket) => bucket.years);

      expect(years).toEqual([...years].sort((left, right) => left - right));
      expect(years[0]).toBe(0.25);
      expect(years[11]).toBe(30);
   });

   test("a null z-score parses as null and is not coerced to zero", () => {
      const row = ZSecurityAnalytics.parse(ANALYTICS_LATEST);

      // All 2,438 rows for this CUSIP are null. A zero would render as "0.00
      // standard deviations from its own residual", i.e. as fairly priced,
      // which is the opposite of "not scored".
      expect(row.residualZScore).toBeNull();
      expect(row.residualZScore).not.toBe(0);
   });

   test("a WITHHELD row parses, with only the yield null", () => {
      // Upstream declines to publish a yield inside a month of maturity: the
      // quote is a rounding of par and 0.156 of a point over two days
      // annualises to 34.71%. 16,918 rows carry this as of the 2026-09-10
      // correction.
      const withheld = ZSecurityAnalytics.parse({
         ...ANALYTICS_LATEST,
         ytm: null,
      });

      expect(withheld.ytm).toBeNull();
   });

   test("a withheld row keeps every other column, duration included", () => {
      // Measured upstream across all 16,918 withheld rows: zero nulls in
      // duration, DV01 or convexity. They are not yield-derived in the way that
      // matters — duration annualises nothing, so it stays true — which is why
      // the schema declares them non-nullable rather than defensively nullable.
      const withheld = ZSecurityAnalytics.parse({
         ...ANALYTICS_LATEST,
         ytm: null,
      });

      expect(withheld.modifiedDuration).toBeCloseTo(0.2503, 4);
      expect(withheld.dv01).toBeCloseTo(0.0025, 4);
      expect(withheld.dirtyPrice).toBeCloseTo(100.0258, 4);
      expect(withheld.residualBasisPoints).toBeCloseTo(-7.1884, 4);
      expect(withheld.keyRateDurations).toHaveLength(12);
   });

   test("a null DURATION fails loudly rather than rendering as withheld", () => {
      // The invariant the schema states. If upstream ever does null one of
      // these, "withheld" would be the wrong word for a reason nobody has
      // established, and a plausible-looking wrong label is worse than a 503.
      expect(() =>
         ZSecurityAnalytics.parse({
            ...ANALYTICS_LATEST,
            modified_duration: null,
         }),
      ).toThrow();
      expect(() =>
         ZSecurityAnalytics.parse({ ...ANALYTICS_LATEST, dv01: null }),
      ).toThrow();
   });

   test("a present z-score is preserved", () => {
      const row = ZSecurityAnalytics.parse({
         ...ANALYTICS_LATEST,
         residual_z_score: -2.31,
      });
      expect(row.residualZScore).toBeCloseTo(-2.31, 2);
   });
});

describe("security family classification", () => {
   test("maps every price-file type to a family", () => {
      expect(securityFamilyFromPriceType("MARKET BASED BILL")).toBe("bill");
      expect(securityFamilyFromPriceType("MARKET BASED NOTE")).toBe("note");
      expect(securityFamilyFromPriceType("MARKET BASED BOND")).toBe("bond");
      expect(securityFamilyFromPriceType("MARKET BASED FRN")).toBe("frn");
      expect(securityFamilyFromPriceType("TIPS")).toBe("tips");
   });

   test("an unrecognised type is null rather than a wrong guess", () => {
      expect(securityFamilyFromPriceType("MARKET BASED STRIP")).toBeNull();
      expect(securityFamilyFromPriceType("")).toBeNull();
   });

   test("bills, notes and bonds are rendered with nominal analytics", () => {
      // Bills were added on 2026-09-11. They had been excluded on the stated
      // grounds that their rows "are not in production yet", which was out of
      // date: security_analytics holds 177,747 bill rows over 1,439 CUSIPs from
      // 2008-09-02, with ytm, duration, DV01, convexity and both residuals on
      // every one. The panel saying analytics were not published yet was
      // covering a complete dataset.
      expect([...ANALYSED_FAMILIES].sort()).toEqual(["bill", "bond", "note"]);
   });

   test("linkers and floaters stay OUT of the nominal set", () => {
      // They need different measures, not the same ones with blanks. A TIPS is
      // stored in security_details as an ordinary "Bond" with no inflation
      // flag, so if this ever included "tips" a linker would silently render as
      // a nominal bond with a meaningless yield to maturity. Each has its own
      // block on the page instead.
      expect(ANALYSED_FAMILIES).not.toContain("tips");
      expect(ANALYSED_FAMILIES).not.toContain("frn");
   });

   test("the bill annualisation floor matches upstream's coupon floor", () => {
      // Thirty days, deliberately the same number upstream uses to withhold a
      // coupon's yield, rather than an independent judgement about bills. It is
      // applied here because upstream never applied it to bills: all 177,746
      // bill rows carry a yield, so the ytm gate cannot fire on one, and inside
      // thirty days the residual reaches 1,435 bp on a z-score of 1,039 while
      // the price residual on the same row is 3.9 cents.
      expect(BILL_ANNUALISATION_FLOOR_DAYS).toBe(30);
   });
});
