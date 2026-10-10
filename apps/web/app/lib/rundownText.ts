import type { TRundown } from "@/services/dailyRundown.server";

/**
 * The words of the Treasury daily rundown, shared by its page and its email so
 * the two cannot drift: dates, signed basis points, how an auction is named
 * and how its clearing rate reads, and the one-sentence summary that opens
 * both (and is the page's meta description and the email's preview text).
 */

export const RUNDOWN_PATH = "/daily-rundown/treasury";
export const rundownPath = (date: string) => `${RUNDOWN_PATH}/${date}`;

export const longDate = (iso: string) =>
	new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});

export const shortDate = (iso: string) =>
	new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});

/** "+3 bp", "−12 bp", "0 bp"; "—" when unknown. Rounded to whole bp. */
export const signedBp = (value: number | null) => {
	if (value === null) return "—";
	const r = Math.round(value);
	return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)} bp`;
};

/** "4.123%", or "—". Inputs are already in percent. */
export const pct = (value: number | null, digits = 3) =>
	value === null ? "—" : `${value.toFixed(digits)}%`;

type TResultAuction = TRundown["results"][number]["auction"];

/** "10-Year Note" or "4-Week Bill"; a reopening says so. */
export const auctionName = (a: TResultAuction) =>
	`${a.term} ${a.kind ?? "security"}${a.is_reopening ? " (reopening)" : ""}`;

/**
 * The headline clearing rate as the auctions page reads it: a bill's discount
 * rate with its investment rate, a note's or bond's high yield, a TIPS's real
 * yield, an FRN's discount margin.
 */
export const clearingText = (a: TResultAuction) => {
	const c = a.clearing_rate;
	if (c.high_percent === null) return "—";
	if (c.measure === "discount")
		return `${pct(c.high_percent)} discount (${pct(c.investment_rate_percent)} investment)`;
	if (c.measure === "discount margin")
		return `${pct(c.high_percent)} discount margin`;
	return `${pct(c.high_percent)}${c.measure === "real yield" ? " real yield" : ""}`;
};

/** Offering size, "$95B" or "$16B". */
export const billions = (dollars: number | null) =>
	dollars === null ? "—" : `$${Math.round(dollars / 1e9)}B`;

/** One sentence: the 10-year, 2s10s, and what the auctions did. */
export const rundownSummary = (r: TRundown) => {
	const ten = r.tenors.find((t) => t.years === 10);
	const twos = r.spreads.find((s) => s.name === "2s10s");
	const parts: string[] = [];
	if (ten)
		parts.push(
			`The 10-year Treasury par yield closed at ${pct(ten.parYield, 2)}${ten.changeBp === null ? "" : ` (${signedBp(ten.changeBp)})`}`,
		);
	if (twos)
		parts.push(
			`2s10s at ${signedBp(twos.bp).replace(/^\+/, "")}${twos.changeBp === null ? "" : ` (${signedBp(twos.changeBp)})`}`,
		);
	const auctions =
		r.results.length === 0
			? "no auctions settled results"
			: `${r.results.length} auction ${r.results.length === 1 ? "result" : "results"}: ${r.results
					.map((x) => `${x.auction.term} ${x.auction.kind ?? ""}`.trim())
					.join(", ")}`;
	return `${parts.join(", ")}; ${auctions}. ${r.ahead.length} ${r.ahead.length === 1 ? "auction" : "auctions"} announced for the next ${r.aheadDays} days.`;
};

/** "change since Oct 7; a week ago is Oct 1, a month ago Sep 8". */
export const sinceText = (r: TRundown) =>
	[
		r.previousDate ? `change since ${shortDate(r.previousDate)}` : null,
		r.weekDate ? `a week ago is the close of ${shortDate(r.weekDate)}` : null,
		r.monthDate ? `a month ago ${shortDate(r.monthDate)}` : null,
	]
		.filter((x): x is string => x !== null)
		.join("; ");
