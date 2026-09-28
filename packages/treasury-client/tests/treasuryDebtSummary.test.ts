import { describe, expect, test } from "bun:test";
import {
   canonicalDebtClass,
   DEBT_SUMMARY_TIE_TOLERANCE,
   ZDebtSummaryLine,
   ZSavingsBondStock,
   ZTreasuryDirectSale,
} from "@saferate/treasury-client/types";

/**
 * Rows copied VERBATIM from `debt_summary` in the local treasury store for the
 * 2026-08-31 statement, at FULL PRECISION. The three total rows and the six
 * marketable classes, which is what makes the tie-out below a real arithmetic
 * check rather than an invented one.
 *
 * The precision is load-bearing and the first version of this fixture got it
 * wrong: figures rounded to a tenth of a billion for display tie only to
 * 3.14e-6, which fails the 1e-6 tolerance and looks like the tolerance being
 * too tight rather than the fixture being rounded. At full precision the six
 * classes sum to 31,828,001,463,612.64 against a Total Marketable row of
 * 31,828,001,463,612.6 — the same figure to the cent.
 */
const STATEMENT = [
   {
      debt_held_public: 7247855589800,
      intragovernmental: 214430900,
      record_date: "2026-08-31",
      security_class: "Bills",
      security_type: "Marketable",
      total: 7248070020700,
   },
   {
      debt_held_public: 16214682012600,
      intragovernmental: 3738925100,
      record_date: "2026-08-31",
      security_class: "Notes",
      security_type: "Marketable",
      total: 16218420937700,
   },
   {
      debt_held_public: 5512728520300,
      intragovernmental: 12555574000,
      record_date: "2026-08-31",
      security_class: "Bonds",
      security_type: "Marketable",
      total: 5525284094300,
   },
   {
      debt_held_public: 2151956986348.23,
      intragovernmental: 702857764.41,
      record_date: "2026-08-31",
      security_class: "Treasury Inflation-Protected Securities",
      security_type: "Marketable",
      total: 2152659844112.64,
   },
   {
      debt_held_public: 679918001300,
      intragovernmental: 57600000,
      record_date: "2026-08-31",
      security_class: "Floating Rate Notes",
      security_type: "Marketable",
      total: 679975601300,
   },
   {
      debt_held_public: 0,
      intragovernmental: 3590965500,
      record_date: "2026-08-31",
      security_class: "Federal Financing Bank",
      security_type: "Marketable",
      total: 3590965500,
   },
   {
      debt_held_public: 31807141110348.2,
      intragovernmental: 20860353264.41,
      record_date: "2026-08-31",
      security_class: "_",
      security_type: "Total Marketable",
      total: 31828001463612.6,
   },
   {
      debt_held_public: 607847699606.01,
      intragovernmental: 7739791966214.71,
      record_date: "2026-08-31",
      security_class: "_",
      security_type: "Total Nonmarketable",
      total: 8347639665820.72,
   },
   {
      debt_held_public: 32414988809954.2,
      intragovernmental: 7760652319479.12,
      record_date: "2026-08-31",
      security_class: "_",
      security_type: "Total Public Debt Outstanding",
      total: 40175641129433.3,
   },
];

describe("debt summary totals", () => {
   test("a total row is flagged as one, and a class row is not", () => {
      // TRAP 1. 924 of the 4,659 rows in the store are Treasury's own totals,
      // shipped in the same table as the detail rows. Summing everything double
      // counts, and there is nothing in the numbers to reveal it: the result is
      // simply twice the debt, which is a plausible-looking figure.
      const lines = STATEMENT.map((row) => ZDebtSummaryLine.parse(row));
      const totals = lines.filter((line) => line.isTotal);
      const details = lines.filter((line) => !line.isTotal);

      expect(totals).toHaveLength(3);
      expect(details).toHaveLength(6);
      for (const line of totals)
         expect(line.securityType).toStartWith("Total ");
      for (const line of details) expect(line.securityClass).not.toBe("_");
   });

   test("the marketable classes tie to Treasury's own total within tolerance", () => {
      const lines = STATEMENT.map((row) => ZDebtSummaryLine.parse(row));
      const summed = lines
         .filter((line) => !line.isTotal && line.securityType === "Marketable")
         .reduce((running, line) => running + line.total, 0);
      const published =
         lines.find((line) => line.securityType === "Total Marketable")
            ?.total ?? 0;

      // TRAP 2. A RELATIVE tolerance, not an equality. At this statement the two
      // agree to the cent on the full-precision figures, but across all 308
      // statements 25 marketable months differ — worst $1,000,000, and the gaps
      // repeat as round numbers across consecutive months, which is an artefact
      // in Treasury's own file rather than a dropped row on our side.
      expect(Math.abs(summed - published) / published).toBeLessThan(
         DEBT_SUMMARY_TIE_TOLERANCE,
      );
   });

   test("the tolerance would still catch a dropped class", () => {
      // The check is worthless if a real defect slips under the threshold. The
      // SMALLEST marketable class is Federal Financing Bank at $3.6bn, which is
      // 1.1e-4 of the total — two orders of magnitude above the tolerance. So
      // losing even the smallest row fails.
      const lines = STATEMENT.map((row) => ZDebtSummaryLine.parse(row));
      const published =
         lines.find((line) => line.securityType === "Total Marketable")
            ?.total ?? 0;
      const withoutSmallest = lines
         .filter(
            (line) =>
               !line.isTotal &&
               line.securityType === "Marketable" &&
               line.securityClass !== "Federal Financing Bank",
         )
         .reduce((running, line) => running + line.total, 0);

      expect(Math.abs(withoutSmallest - published) / published).toBeGreaterThan(
         DEBT_SUMMARY_TIE_TOLERANCE,
      );
   });

   test("the headline total is found under either of its two labels", () => {
      // TRAP 4. 2001-01-31 and 2001-02-28 are labelled Total Treasury Securities
      // Outstanding; the other 306 statements are Total Public Debt Outstanding.
      // Keying on one label opens a two-month hole at the start of a 25-year
      // series, which reads as missing data rather than as a rename.
      const current = ZDebtSummaryLine.parse({
         ...STATEMENT[8],
         security_type: "Total Public Debt Outstanding",
      });
      const original = ZDebtSummaryLine.parse({
         ...STATEMENT[8],
         record_date: "2001-01-31",
         security_type: "Total Treasury Securities Outstanding",
      });

      expect(current.isHeadlineTotal).toBe(true);
      expect(original.isHeadlineTotal).toBe(true);
      // A group total is NOT the headline. Both are totals; only one is the
      // whole debt, and treating Total Marketable as the headline understates
      // it by the $8.35tn of non-marketable debt.
      expect(ZDebtSummaryLine.parse(STATEMENT[6]).isHeadlineTotal).toBe(false);
   });
});

describe("canonicalDebtClass", () => {
   test("folds the two pre-2004 linker labels into the current one", () => {
      // TRAP 3. Inflation-Indexed Notes ($152.78bn) plus Inflation-Indexed Bonds
      // ($46.95bn) end at 2004-05-31 on $199.73bn; Treasury Inflation-Protected
      // Securities begins 2004-06-30 on $200.39bn. One continuous history under
      // three labels, reproduced from the store rather than taken on report. A
      // naive group-by draws TIPS starting in 2004 beside two lines that die.
      expect(canonicalDebtClass("Inflation-Indexed Notes")).toBe(
         "Treasury Inflation-Protected Securities",
      );
      expect(canonicalDebtClass("Inflation-Indexed Bonds")).toBe(
         "Treasury Inflation-Protected Securities",
      );
   });

   test("leaves every other class alone, including the current TIPS name", () => {
      for (const name of [
         "Bills",
         "Bonds",
         "Domestic Series",
         "Foreign Series",
         "Notes",
         "Treasury Inflation-Protected Securities",
      ]) {
         expect(canonicalDebtClass(name)).toBe(name);
      }
   });
});

describe("savings bond stock", () => {
   /**
    * The same total-inside-the-detail trap as trap 1, in a different table with
    * a different sentinel, and it shipped a wrong figure before being caught:
    * summing every row rendered 542,264,326 bonds outstanding against
    * Treasury's published 271,132,163. Exactly double, and entirely plausible
    * on the page. Rows verbatim from the 2026-07-31 report.
    */
   const REPORT = [
      {
         issued: 6861014435,
         matured: 0,
         matured_unredeemed: 102720578,
         outstanding: 271132163,
         record_date: "2026-07-31",
         redeemed: 6589882272,
         series: "ALL",
         series_description: "All Series",
      },
      {
         issued: 1976146478,
         matured: 0,
         matured_unredeemed: 82236813,
         outstanding: 226434073,
         record_date: "2026-07-31",
         redeemed: 1749712405,
         series: "EE",
         series_description: "Series EE",
      },
      {
         issued: 179339685,
         matured: 0,
         matured_unredeemed: 0,
         outstanding: 24205123,
         record_date: "2026-07-31",
         redeemed: 155134562,
         series: "I",
         series_description: "Series I",
      },
   ];

   test("the ALL row is Treasury's total, and summing past it doubles the stock", () => {
      const rows = REPORT.map((row) => ZSavingsBondStock.parse(row));
      const total = rows.find((row) => row.series === "ALL");
      const series = rows.filter((row) => row.series !== "ALL");

      expect(total?.outstanding).toBe(271132163);
      // The whole report sums to roughly twice its own total, which is what the
      // page printed before the split moved into the reader.
      const naive = rows.reduce((running, row) => running + row.outstanding, 0);
      expect(naive).toBeGreaterThan((total?.outstanding ?? 0) * 1.9);
      // Only the three series shown here, so these do not add to ALL: the real
      // report carries fifteen. What must hold is that no series exceeds it.
      for (const row of series) {
         expect(row.outstanding).toBeLessThan(total?.outstanding ?? 0);
      }
   });
});

describe("TreasuryDirect sales", () => {
   /**
    * THE FILTER IS ON `securityType`, NOT ON A NON-EMPTY `securityClass`, and
    * this pins the correction. The first attempt assumed the marketable lines
    * carried no class, on the strength of an upstream schema comment. 774 of
    * the 778 marketable rows carry one — Bill 249, Note 248, Bond 218, TIPS 59
    * — so that filter summed bill sales averaging $3.7bn a month into a
    * savings-bond chart, producing $13-17bn a month against a true figure near
    * $200m. It rendered as a smooth, plausible, entirely wrong series.
    */
   const MONTH = [
      {
         gross_sales: 43000000,
         net_sales: 42500000,
         record_date: "2026-08-31",
         returned_sales: 500000,
         securities_sold: 43656,
         security_class: "I",
         security_type: "Savings Bond",
      },
      {
         gross_sales: 2200000,
         net_sales: 2200000,
         record_date: "2026-08-31",
         returned_sales: 0,
         securities_sold: 10282,
         security_class: "EE",
         security_type: "Savings Bond",
      },
      {
         gross_sales: 3900000000,
         net_sales: 3900000000,
         record_date: "2026-08-31",
         returned_sales: 0,
         securities_sold: 1,
         security_class: "Bill",
         security_type: "Marketable",
      },
   ];

   test("a marketable line carries a class, so a class filter does not exclude it", () => {
      const rows = MONTH.map((row) => ZTreasuryDirectSale.parse(row));
      const bill = rows.find((row) => row.securityClass === "Bill");

      expect(bill?.securityType).toBe("Marketable");
      // The assumption the first filter rested on, stated as a failing claim.
      expect(bill?.securityClass).not.toBe("");
   });

   test("filtering on securityType keeps the savings bonds and drops the bills", () => {
      const rows = MONTH.map((row) => ZTreasuryDirectSale.parse(row));
      const savings = rows.filter((row) => row.securityType === "Savings Bond");
      const net = savings.reduce((running, row) => running + row.netSales, 0);

      expect(savings).toHaveLength(2);
      // $44.7m, not the $3.94bn the class filter produced for the same month.
      expect(net).toBe(44700000);
      expect(net).toBeLessThan(100000000);
   });
});
