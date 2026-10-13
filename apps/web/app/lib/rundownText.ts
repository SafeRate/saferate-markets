import type { TRundown } from "@/services/dailyRundown.server";
import { unrankedCaption } from "./demandCaption";

/**
 * The words of the Treasury daily rundown, shared by its page and its email so
 * the two cannot drift: dates, signed basis points, how an auction is named
 * and how its clearing rate reads, and the one-sentence summary that opens
 * both (and is the page's meta description and the email's preview text).
 */

export const RUNDOWN_PATH = "/daily-rundown/treasury";
/** The page for an edition, dated by the morning it goes out. */
export const rundownPath = (edition: string) => `${RUNDOWN_PATH}/${edition}`;

export const longDate = (iso: string) =>
	new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});

/** "Thursday". */
export const weekday = (iso: string) =>
	new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
		weekday: "long",
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

/** "+0.12%", "−0.05%", "0.00%"; "—" when unknown. Inputs in percent. */
export const signedPct = (value: number | null, digits = 2) => {
	if (value === null) return "—";
	const r = Number(value.toFixed(digits));
	return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(digits)}%`;
};

/** An index's page on saferate.com. */
export const indexUrl = (slug: string) =>
	`https://saferate.com/treasury/indices/${slug}`;

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

/** "3-Year Note and 52-Week Bill", "4-Week, 8-Week and 17-Week Bill". */
const listOf = (names: string[]) =>
	names.length <= 1
		? (names[0] ?? "")
		: `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const shortName = (a: { term: string; kind: string | null }) =>
	`${a.term} ${a.kind ?? ""}`.trim();

/** "No auctions later this week", "4 auctions next week". */
const laterText = (r: TRundown) => {
	const n = r.later.auctions.length;
	return `${n === 0 ? "no" : n} ${n === 1 ? "auction" : "auctions"} ${n === 0 ? `announced for ${r.later.week}` : r.later.week === "this week" ? "later this week" : "next week"}`;
};

/** What the morning holds: today's auctions, then the rest of the week. */
export const aheadSentence = (r: TRundown) =>
	r.today.length === 0
		? `No Treasury auctions today; ${laterText(r)}.`
		: `Auctions today: ${listOf(r.today.map((a) => `${shortName(a)} (${billions(a.offering_amount)})`))}; ${laterText(r)}.`;

/** "10-Year Note strong, 4-Week Bill average": the close's results. */
export const resultsSentence = (r: TRundown) =>
	r.results.length === 0
		? null
		: `${weekday(r.date)}'s results: ${r.results
				.map(
					({ auction, demand }) =>
						`${shortName(auction)}${demand?.verdict ? `, ${demand.verdict} demand` : ""}`,
				)
				.join("; ")}.`;

type TSpread = TRundown["spreads"][number];

/** "2-year to 10-year". */
export const spreadLabel = (s: TSpread) => `${s.short} to ${s.long}`;

/** What the shape section says before its table, for the reader new to it. */
export const SHAPE_NOTE =
	"How much more long-term Treasuries yield than shorter ones. A wider gap is a steeper curve, a narrower one flatter; below zero, the curve is inverted.";

/**
 * The gap in plain words: "The 10-year yields 0.46% more than the 2-year;
 * flatter on the day."
 */
export const spreadReads = (s: TSpread) => {
	const gap = Math.abs(s.bp / 100).toFixed(2);
	const level =
		Math.round(s.bp) === 0
			? `The ${s.long} yields the same as the ${s.short}`
			: `The ${s.long} yields ${gap}% ${s.bp > 0 ? "more" : "less"} than the ${s.short}${s.bp < 0 ? " (inverted)" : ""}`;
	const move =
		s.changeBp === null
			? ""
			: Math.round(s.changeBp) === 0
				? "; unchanged on the day"
				: `; ${s.changeBp > 0 ? "steeper" : "flatter"} on the day`;
	return `${level}${move}.`;
};

/** What the breakeven line says before its numbers. */
export const BREAKEVEN_NOTE =
	"The 10-year nominal yield less the 10-year real (TIPS) yield: the inflation rate at which the two pay the same. It carries risk premiums too, so it is the market's price for inflation, not a forecast.";

/** "The market prices 2.31% a year of inflation over 10 years; up 2 bp on the day." */
export const breakevenReads = (b: NonNullable<TRundown["breakeven"]>) => {
	const move =
		b.changeBp === null
			? ""
			: Math.round(b.changeBp) === 0
				? "; unchanged on the day"
				: `; ${b.changeBp > 0 ? "up" : "down"} ${Math.abs(Math.round(b.changeBp))} bp on the day`;
	return `The market prices ${b.rate.toFixed(2)}% a year of inflation over ${b.years} years${move}.`;
};

/** The close in a sentence: the 10-year and the 2-to-10-year gap. */
export const closeSentence = (r: TRundown) => {
	const ten = r.tenors.find((t) => t.years === 10);
	const twos = r.spreads.find((s) => s.name === "2s10s");
	if (!ten) return null;
	return `The 10-year par yield closed ${weekday(r.date)} at ${pct(ten.parYield, 2)}${ten.changeBp === null ? "" : ` (${signedBp(ten.changeBp)})`}${twos ? `; the 2-to-10-year gap at ${signedBp(twos.bp).replace(/^\+/, "")}${twos.changeBp === null ? "" : ` (${signedBp(twos.changeBp)})`}` : ""}.`;
};

/**
 * The opening paragraph, the page's meta description and the email's
 * preview text: what is ahead first, then the results, then the close. The
 * email lands the next morning after rates have moved, so the close comes
 * last, as a recap.
 */
export const rundownSummary = (r: TRundown) =>
	[aheadSentence(r), resultsSentence(r), closeSentence(r)]
		.filter((x): x is string => x !== null)
		.join(" ");

/** The email's subject after its date: today's auctions, then the 10-year. */
export const rundownHeadline = (r: TRundown) => {
	const ten = r.tenors.find((t) => t.years === 10);
	const today =
		r.today.length === 0
			? "no auctions today"
			: `${listOf(r.today.map(shortName))} today`;
	return `${today.replace(/^./, (c) => c.toUpperCase())}${ten ? `; 10y closed ${pct(ten.parYield, 2)}${ten.changeBp === null ? "" : ` (${signedBp(ten.changeBp)})`}` : ""}`;
};

/**
 * Why an auction read strong or weak, from treasury's own ranks: the
 * measures in the top and bottom thirds of the same term's window, the
 * thirds the verdict counts (>= 67, <= 33, as treasury's verdictFrom). An unranked term says why instead.
 */
export const demandStory = (
	d: TRundown["results"][number]["demand"],
): string | null => {
	if (d === null) return null;
	const caption = unrankedCaption(d);
	if (caption) return `${caption}.`;
	if (d.verdict === null) return null;
	const named = (ms: typeof d.measures) =>
		listOf(ms.map((m) => m.label.replace(/^./, (c) => c.toLowerCase())));
	const ranked = d.measures.filter((m) => m.percentile !== null);
	const top = ranked.filter((m) => (m.percentile ?? 0) >= 67);
	const bottom = ranked.filter((m) => (m.percentile ?? 100) <= 33);
	const against = `the last ${d.windowMonths} months' ${d.sampleSize} auctions of this term`;
	const parts = [
		top.length > 0 ? `${named(top)} in the strongest third` : null,
		bottom.length > 0 ? `${named(bottom)} in the weakest third` : null,
	].filter((x): x is string => x !== null);
	const verdict = `${d.verdict.replace(/^./, (c) => c.toUpperCase())} demand`;
	return parts.length === 0
		? `${verdict}: every measure in the middle third of ${against}.`
		: `${verdict}: ${parts.join("; ")} of ${against}.`;
};

/** "changes since Oct 7 (day), Oct 1 (week) and Sep 8 (month)". */
export const sinceText = (r: TRundown) => {
	const parts = [
		r.previousDate ? `${shortDate(r.previousDate)} (day)` : null,
		r.weekDate ? `${shortDate(r.weekDate)} (week)` : null,
		r.monthDate ? `${shortDate(r.monthDate)} (month)` : null,
	].filter((x): x is string => x !== null);
	if (parts.length === 0) return "no earlier close to compare";
	const list =
		parts.length === 1
			? parts[0]
			: `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
	return `changes since the closes of ${list}`;
};
