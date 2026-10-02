import { beforeEach, describe, expect, test } from "bun:test";
import {
	analyseAuctions,
	loadAuctionWindow,
	publishAuction,
	publishLatestByTerm,
	readAuctionsBetween,
	resetAuctionWindowCache,
} from "../src/reads/auctions";
import {
	ALL_ROWS,
	auctionRow,
	FOUR_WEEK,
	FRN,
	fakeAuctionTreasury,
	NEW_THREE_YEAR,
	ON,
	TEN_YEAR,
} from "./auctionRows";

const env = (treasury: unknown = fakeAuctionTreasury()) =>
	({ TREASURY: treasury }) as never;

const read = () =>
	readAuctionsBetween(env(), { from: "2026-01-01", to: "2026-12-31" });

beforeEach(() => resetAuctionWindowCache());

describe("reading auctionsBetween", () => {
	test("keeps a new issue with no details, its maturity and coupon null", async () => {
		const rows = await read();
		const fresh = rows.find((a) => a.cusip === "91282CRQ6");
		expect(fresh).toBeDefined();
		expect(fresh?.maturityDate).toBeNull();
		expect(fresh?.couponPercent).toBeNull();
		expect(fresh?.kind).toBe("Note");
	});

	test("comes back newest auction first", async () => {
		const dates = (await read()).map((a) => a.auctionDate);
		expect(dates).toEqual([...dates].sort().reverse());
	});

	test("a treasury-api without the method is null from the window, not an empty schedule", async () => {
		const stubLike = {
			latestPriceDate: async () => ON,
			auctionsBetween: async () => {
				throw new TypeError(
					'The RPC receiver does not implement the method "auctionsBetween".',
				);
			},
		};
		expect(await loadAuctionWindow(env(stubLike))).toBeNull();
	});
});

describe("the analysis", () => {
	test("groups a 4-week reopening of a 17-week bill as a 4-week auction", async () => {
		const { terms } = analyseAuctions(await read(), ON);
		expect(terms.map((t) => t.key)).toContain("Bill 4-Week");
		expect(terms.map((t) => t.key)).not.toContain("Bill 17-Week");
	});

	test("groups a reopened 10-year under 10-Year, not its offered term", async () => {
		const { terms } = analyseAuctions(await read(), ON);
		expect(terms.map((t) => t.key)).toContain("Note 10-Year");
		expect(terms.map((t) => t.key)).not.toContain("Note 9-Year 11-Month");
	});

	test("orders bills first, then notes, then FRNs", async () => {
		const { terms } = analyseAuctions(await read(), ON);
		const kinds = terms.map((t) => t.kind);
		expect(kinds.indexOf("Bill")).toBeLessThan(kinds.indexOf("Note"));
		expect(kinds.indexOf("Note")).toBeLessThan(kinds.indexOf("FRN"));
	});

	test("matches saferate.com for 912797VP9: six priors, +0.00 cover, -0.8863 pt dealers", async () => {
		const { latestByTerm } = analyseAuctions(await read(), ON);
		const fourWeek = latestByTerm.find((r) => r.key === "Bill 4-Week");
		expect(fourWeek?.auction.cusip).toBe("912797VP9");
		expect(fourWeek?.coverComparedWith).toBe(6);
		expect(fourWeek?.dealersComparedWith).toBe(6);
		expect(fourWeek?.coverVsPrior ?? Number.NaN).toBeCloseTo(0, 6);
		expect((fourWeek?.dealersVsPrior ?? Number.NaN) * 100).toBeCloseTo(
			-0.8863,
			3,
		);
	});

	test("counts each change's priors apart, skipping an auction missing the figure", async () => {
		const gappy = FOUR_WEEK.map((row, i) =>
			i === 2 ? { ...row, bid_to_cover_ratio: null } : row,
		);
		const rows = await readAuctionsBetween(env(fakeAuctionTreasury(gappy)), {
			from: "2026-01-01",
			to: "2026-12-31",
		});
		const [row] = analyseAuctions(rows, ON).latestByTerm;
		expect(row.coverComparedWith).toBe(5);
		expect(row.dealersComparedWith).toBe(6);
	});

	test("with no prior auction, the change is null and compared with zero", async () => {
		const rows = await readAuctionsBetween(env(fakeAuctionTreasury([TEN_YEAR])), {
			from: "2026-01-01",
			to: "2026-12-31",
		});
		const [row] = analyseAuctions(rows, ON).latestByTerm;
		expect(row.coverVsPrior).toBeNull();
		expect(row.coverComparedWith).toBe(0);
	});

	test("an announced auction is never a term's latest result", async () => {
		const { latestByTerm, announced } = analyseAuctions(await read(), ON);
		expect(announced.map((a) => a.cusip)).toEqual(["91282CRQ6"]);
		expect(latestByTerm.find((r) => r.key === "Note 3-Year")).toBeUndefined();
	});

	test("auctioned-not-settled is held on or before the day and issued after it", async () => {
		const { settling } = analyseAuctions(await read(), ON);
		expect(settling.map((a) => a.cusip)).toEqual(["912797VP9"]);
	});
});

describe("the published record", () => {
	const published = async (cusip: string) => {
		const auction = (await read()).find((a) => a.cusip === cusip);
		if (!auction) throw new Error(`${cusip} not in the fixture`);
		return publishAuction(auction, ON);
	};

	test("a bill leads with its discount rate, the investment rate beside it", async () => {
		const bill = await published("912797VP9");
		expect(bill.clearing_rate).toEqual({
			measure: "discount",
			high_percent: 3.89,
			median_percent: 3.84,
			investment_rate_percent: 3.956,
		});
		expect(bill.high_less_median_basis_points).toBeCloseTo(5, 6);
		expect(bill.term).toBe("4-Week");
		expect(bill.status).toBe("auctioned");
	});

	test("a note clears on yield, high less median from the yield pair", async () => {
		const note = await published("91282CRF0");
		expect(note.clearing_rate.measure).toBe("yield");
		expect(note.clearing_rate.investment_rate_percent).toBeNull();
		expect(note.high_less_median_basis_points).toBeCloseTo(6.5, 6);
		expect(note.term).toBe("10-Year");
		expect(note.status).toBe("settled");
		expect(note.coupon_percent).toBe(4.625);
	});

	test("an FRN clears on discount margin, with no median and so no spread to it", async () => {
		const frn = await published(FRN.cusip as string);
		expect(frn.clearing_rate.measure).toBe("discount margin");
		expect(frn.clearing_rate.median_percent).toBeNull();
		expect(frn.high_less_median_basis_points).toBeNull();
	});

	test("bidder shares are of the competitive award, leaving out SOMA", async () => {
		const bill = await published("912797VP9");
		expect(bill.bidders?.primary_dealer_percent).toBeCloseTo(31.3649, 4);
		const sum =
			(bill.bidders?.primary_dealer_percent ?? 0) +
			(bill.bidders?.direct_percent ?? 0) +
			(bill.bidders?.indirect_percent ?? 0);
		expect(sum).toBeCloseTo(100, 6);
	});

	test("a new issue is published announced, with nulls rather than guesses", async () => {
		const fresh = await published(NEW_THREE_YEAR.cusip as string);
		expect(fresh.status).toBe("announced");
		expect(fresh.maturity_date).toBeNull();
		expect(fresh.coupon_percent).toBeNull();
		expect(fresh.bidders).toBeNull();
		expect(fresh.clearing_rate.high_percent).toBeNull();
	});

	test("unreported bidder figures are null, not zero shares", async () => {
		const row = auctionRow({
			cusip: "912797ZZ1",
			auction_date: "2026-09-29",
			primary_dealer_accepted: null,
		});
		const [auction] = await readAuctionsBetween(env(fakeAuctionTreasury([row])), {
			from: "2026-09-01",
			to: "2026-09-30",
		});
		expect(publishAuction(auction, ON).bidders).toBeNull();
	});

	test("the latest-by-term record says how many priors it averaged", async () => {
		const { latestByTerm } = analyseAuctions(await read(), ON);
		const row = latestByTerm.find((r) => r.key === "Bill 4-Week");
		if (!row) throw new Error("no 4-week row");
		const out = publishLatestByTerm(row, ON);
		expect(out.group).toBe("Bill 4-Week");
		expect(out.bid_to_cover_compared_with).toBe(6);
		expect(out.primary_dealer_change_points).toBeCloseTo(-0.8863, 3);
		expect(out.auction.cusip).toBe("912797VP9");
	});
});

test("the fixture covers every case it claims to", () => {
	expect(
		ALL_ROWS.some((r) => r.reopening === 0 && r.maturity_date === null),
	).toBe(true);
});
