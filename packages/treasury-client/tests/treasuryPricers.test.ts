import { describe, expect, test } from "bun:test";
import type { TTreasuryEnv } from "@saferate/treasury-client/client";
import {
   priceBill,
   priceCouponSecurity,
} from "@saferate/treasury-client/client";
import { ZBillPrice, ZCouponPrice } from "@saferate/treasury-client/types";

// The bill figures are Treasury's OWN published auction numbers for 912797WP8,
// a 17-week bill at a 3.895% discount over 119 days: price 98.712486, discount
// 3.895000, investment rate 4.001. Using the issuer's numbers rather than ours
// means this fails if either side's convention drifts, not just the transform.
//
// VERIFIED END TO END against the deployed pricer on 2026-09-09: entering
// 3.895% for a 119-day bill returns 98.712486 and 4.001 through the page, and
// feeding a coupon security's own yield back in returns its starting clean
// price to six decimals.
const BILL_ROW = {
   daysInYear: 365,
   daysToMaturity: 119,
   discountRate: 0.03895,
   investmentRate: 0.04001,
   maturityDate: "2027-01-07",
   price: 98.712486,
   settlementDate: "2026-09-10",
};

// A coupon row in the shape upstream returns. NOTE THE UNITS ASYMMETRY:
// couponRate is a DECIMAL and yieldToMaturity is a PERCENTAGE, deliberately, so
// that couponPrice agrees with security_analytics.ytm for the same security.
const COUPON_ROW = {
   accruedInterest: 0.601_09,
   cleanPrice: 99.59375,
   convexity: 0.125_28,
   couponRate: 0.02,
   couponsRemaining: 1,
   cusip: "912828U24",
   dirtyPrice: 100.194_84,
   dv01: 0.002_503,
   isFinalPeriod: true,
   macaulayDuration: 0.252_717,
   maturityDate: "2026-11-15",
   modifiedDuration: 0.250_28,
   settlementDate: "2026-09-10",
   yieldToMaturity: 4.024_565,
};

describe("ZBillPrice", () => {
   test("keeps Treasury's own published figures intact", () => {
      const bill = ZBillPrice.parse(BILL_ROW);

      expect(bill.price).toBeCloseTo(98.712486, 6);
      expect(bill.discountRatePercent).toBeCloseTo(3.895, 4);
      expect(bill.investmentRatePercent).toBeCloseTo(4.001, 3);
   });

   test("the investment rate exceeds the discount rate, always", () => {
      // Different denominators and different day counts: the discount rate is
      // ACT/360 against FACE, the investment rate ACT/365 against PRICE. Showing
      // the discount rate as "the yield" understates what a bill earns.
      const bill = ZBillPrice.parse(BILL_ROW);
      expect(bill.investmentRatePercent).toBeGreaterThan(
         bill.discountRatePercent,
      );
   });

   test("reports the day-count year, which is keyed off the issue date", () => {
      const bill = ZBillPrice.parse(BILL_ROW);
      expect(bill.daysInYear).toBe(365);
      expect(
         ZBillPrice.parse({ ...BILL_ROW, daysInYear: 366 }).daysInYear,
      ).toBe(366);
   });

   test("reports the settlement date actually used, not the trade date", () => {
      const bill = ZBillPrice.parse(BILL_ROW);
      expect(bill.settlementDate).toBe("2026-09-10");
   });

   test("passes a holiday-shifted settlement through untouched", () => {
      // Verified live: a Friday 2026-09-04 trade settles Tuesday 2026-09-08,
      // because T+1 lands on Labor Day. The transform must not recompute or
      // normalise this — a holiday calendar is not reproducible here, which is
      // exactly why upstream returns the date it used.
      const shifted = ZBillPrice.parse({
         ...BILL_ROW,
         settlementDate: "2026-09-08",
      });

      expect(shifted.settlementDate).toBe("2026-09-08");
   });
});

describe("ZCouponPrice", () => {
   test("converts the coupon to percent but leaves the yield alone", () => {
      const coupon = ZCouponPrice.parse(COUPON_ROW);

      // couponRate 0.02 -> 2%. yieldToMaturity 4.024565 stays 4.024565: it is
      // ALREADY a percentage upstream. Multiplying it would report 402%.
      expect(coupon.couponRatePercent).toBeCloseTo(2, 6);
      expect(coupon.yieldToMaturityPercent).toBeCloseTo(4.024565, 6);
      expect(coupon.yieldToMaturityPercent).toBeLessThan(100);
   });

   test("dirty price is clean plus accrued", () => {
      const coupon = ZCouponPrice.parse(COUPON_ROW);
      expect(coupon.cleanPrice + coupon.accruedInterest).toBeCloseTo(
         coupon.dirtyPrice,
         4,
      );
   });

   test("carries the final-period flag and the coupon count", () => {
      const coupon = ZCouponPrice.parse(COUPON_ROW);
      expect(coupon.isFinalPeriod).toBe(true);
      expect(coupon.couponsRemaining).toBe(1);
   });

   test("a security not in its final period says so", () => {
      const coupon = ZCouponPrice.parse({
         ...COUPON_ROW,
         couponsRemaining: 14,
         isFinalPeriod: false,
      });
      expect(coupon.isFinalPeriod).toBe(false);
   });

   test("a CUSIP-less result parses, since terms can be supplied directly", () => {
      const coupon = ZCouponPrice.parse({ ...COUPON_ROW, cusip: null });
      expect(coupon.cusip).toBeNull();
   });
});

const envReturning = (row: unknown) =>
   ({
      TREASURY: {
         billPrice: async () => row,
         couponPrice: async () => row,
      },
   }) as unknown as TTreasuryEnv;

describe("priceBill input handling", () => {
   test("converts a percent rate to the decimal upstream expects", async () => {
      let seen: { discountRate?: number } = {};
      const env = {
         TREASURY: {
            billPrice: async (input: { discountRate?: number }) => {
               seen = input;
               return BILL_ROW;
            },
         },
      } as unknown as TTreasuryEnv;

      await priceBill({
         discountRatePercent: 3.895,
         env,
         maturityDate: "2027-01-07",
      });

      // 3.895 in, 0.03895 out. Passing the percent straight through would ask
      // upstream to price a 389.5% bill.
      expect(seen.discountRate).toBeCloseTo(0.03895, 8);
   });

   test("refuses both sides at once, before any RPC call", async () => {
      let wasCalled = false;
      const env = {
         TREASURY: {
            billPrice: async () => {
               wasCalled = true;
               return BILL_ROW;
            },
         },
      } as unknown as TTreasuryEnv;

      expect(
         priceBill({
            discountRatePercent: 3.895,
            env,
            maturityDate: "2027-01-07",
            price: 98.7,
         }),
      ).rejects.toThrow();
      expect(wasCalled).toBe(false);
   });

   test("refuses neither side", async () => {
      expect(
         priceBill({ env: envReturning(BILL_ROW), maturityDate: "2027-01-07" }),
      ).rejects.toThrow();
   });
});

describe("priceCouponSecurity input handling", () => {
   test("converts a percent yield to a decimal", async () => {
      let seen: { yieldRate?: number } = {};
      const env = {
         TREASURY: {
            couponPrice: async (input: { yieldRate?: number }) => {
               seen = input;
               return COUPON_ROW;
            },
         },
      } as unknown as TTreasuryEnv;

      await priceCouponSecurity({
         cusip: "912828U24",
         env,
         yieldPercent: 4.02,
      });
      expect(seen.yieldRate).toBeCloseTo(0.0402, 8);
   });

   test("requires coupon and maturity when no CUSIP is given", async () => {
      expect(
         priceCouponSecurity({
            cleanPrice: 99.5,
            env: envReturning(COUPON_ROW),
         }),
      ).rejects.toThrow();
   });

   test("accepts terms without a CUSIP", async () => {
      const result = await priceCouponSecurity({
         cleanPrice: 99.5,
         couponRatePercent: 2,
         env: envReturning(COUPON_ROW),
         maturityDate: "2026-11-15",
      });
      expect(result?.ok).toBe(true);
   });

   test("refuses a price and a yield together", async () => {
      expect(
         priceCouponSecurity({
            cleanPrice: 99.5,
            cusip: "912828U24",
            env: envReturning(COUPON_ROW),
            yieldPercent: 4.02,
         }),
      ).rejects.toThrow();
   });
});
