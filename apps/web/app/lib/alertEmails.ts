import type { TPublishedAuction } from "@markets/mcp-tools";
import type { TRundown } from "@/services/dailyRundown.server";
import {
	rankedAgainst,
	type TDemandWords,
	unrankedCaption,
} from "./demandCaption";
import {
	auctionName,
	billions,
	clearingText,
	demandStory,
	indexUrl,
	longDate,
	pct,
	rundownHeadline,
	rundownPath,
	rundownSummary,
	shortDate,
	signedBp,
	SHAPE_NOTE,
	signedPct,
	sinceText,
	spreadLabel,
	spreadReads,
} from "./rundownText";

/**
 * The alert emails: the daily rundown, an auction result and an auction
 * announcement. Plain text AND HTML on every one (a lone HTML part scores
 * worse with spam filters), inline styles only, no images and no tracking.
 * The words come from rundownText and demandCaption, which the page and the
 * auctions board use, so an email never reads differently from the site.
 *
 * Every email ends with why it was sent, a link to manage alerts, and a
 * one-click unsubscribe for that kind of email (the caller signs the links).
 */

export type TEmailLinks = {
	/** https://saferate.markets, or staging. */
	site: string;
	manage: string;
	unsubscribe: string;
};

export type TRenderedEmail = { subject: string; text: string; html: string };

const esc = (v: string) =>
	v
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

const FONT =
	"-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const cell = "padding:6px 8px;border-top:1px solid #e2e8f0;font-size:13px";
const head =
	"padding:6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;text-align:left";

const layout = (input: {
	eyebrow: string;
	title: string;
	preheader: string;
	body: string;
	why: string;
	links: TEmailLinks;
}) => `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f8fafc">
<span style="display:none;max-height:0;overflow:hidden">${esc(input.preheader)}</span>
<div style="font-family:${FONT};max-width:640px;margin:0 auto;padding:32px 20px;color:#0f172a">
<p style="margin:0 0 6px;font:600 12px/1.4 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#4f46e5">${esc(input.eyebrow)}</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${esc(input.title)}</h1>
${input.body}
<p style="margin:32px 0 0;font-size:12px;line-height:1.6;color:#64748b">${esc(input.why)} These are calculations derived from publicly available U.S. Treasury data. They are not investment advice or a recommendation to buy or sell any security.</p>
<p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:#64748b"><a href="${esc(input.links.manage)}" style="color:#4f46e5">Manage email alerts</a> · <a href="${esc(input.links.unsubscribe)}" style="color:#4f46e5">Unsubscribe</a></p>
<p style="margin:8px 0 0;font-size:12px;color:#94a3b8">Safe Rate Markets · saferate.markets</p>
</div>
</body>
</html>`;

const footerText = (why: string, links: TEmailLinks) =>
	[
		"",
		"—",
		why,
		"These are calculations derived from publicly available U.S. Treasury data. They are not investment advice or a recommendation to buy or sell any security.",
		`Manage email alerts: ${links.manage}`,
		`Unsubscribe: ${links.unsubscribe}`,
	].join("\n");

const demandText = (d: TDemandWords | null) => {
	if (d === null) return "—";
	const caption = unrankedCaption(d);
	if (caption) return caption;
	return d.verdict === null ? "—" : `${d.verdict} (${rankedAgainst(d)})`;
};

const button = (href: string, label: string) =>
	`<p style="margin:20px 0 0"><a href="${esc(href)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 22px;border-radius:9999px;text-decoration:none;font-weight:600;font-size:14px">${esc(label)}</a></p>`;

// ── The daily rundown ─────────────────────────────────────────────────────────

/**
 * The email lands the next morning, after rates have traded, so the close
 * comes last and says what it is.
 */
const RECAP_NOTE =
	"Closing levels. Rates have traded since; these are where the day ended.";

/** "Later this week, through Fri, Oct 16" or "Next week, through Fri, Oct 23". */
const laterHeading = (r: TRundown) =>
	`${r.later.week === "this week" ? "Later this week" : "Next week"}, through ${shortDate(r.later.through)}`;

/** Changes on the day, the week and the month. */
const pastRowsHtml = (
	cols: {
		changeBp: number | null;
		weekBp: number | null;
		monthBp: number | null;
	}[],
) =>
	(
		[
			["1 day", (c) => signedBp(c.changeBp)],
			["1 week", (c) => signedBp(c.weekBp)],
			["1 month", (c) => signedBp(c.monthBp)],
		] as [string, (c: (typeof cols)[number]) => string][]
	)
		.map(
			([label, show]) =>
				`<tr><td style="${cell};color:#475569">${label}</td>${cols.map((c) => `<td style="${cell};text-align:right;color:#475569">${esc(show(c))}</td>`).join("")}</tr>`,
		)
		.join("");

export const rundownEmail = (
	r: TRundown,
	links: TEmailLinks,
): TRenderedEmail => {
	const url = `${links.site}${rundownPath(r.edition)}`;
	const summary = rundownSummary(r);
	const why =
		"You're receiving the Treasury daily rundown because you have a Safe Rate Markets account or subscribed to it.";
	const curve = `<table role="presentation" style="border-collapse:collapse;width:100%;margin-top:8px"><tr><th style="${head}">Tenor</th>${r.tenors.map((t) => `<th style="${head};text-align:right">${t.years}y</th>`).join("")}</tr><tr><td style="${cell}">Par yield</td>${r.tenors.map((t) => `<td style="${cell};text-align:right;font-weight:600">${pct(t.parYield)}</td>`).join("")}</tr>${pastRowsHtml(r.tenors)}<tr><td style="${cell}">Zero</td>${r.tenors.map((t) => `<td style="${cell};text-align:right">${pct(t.zeroRate)}</td>`).join("")}</tr><tr><td style="${cell}">Real (TIPS)</td>${r.tenors.map((t) => `<td style="${cell};text-align:right">${pct(t.realRate)}</td>`).join("")}</tr></table><p style="margin:6px 0 0;font-size:11px;color:#94a3b8">${esc(sinceText(r).replace(/^./, (c) => c.toUpperCase()))}. Zero and real rates are continuously compounded.${r.real ? "" : " The real curve is not available for this date."}</p>`;
	const mm = r.moneyMarket;
	const moneyMarket = mm
		? `<table role="presentation" style="border-collapse:collapse;width:100%;margin-top:8px"><tr><th style="${head}">Tenor</th>${mm.rates.map((m) => `<th style="${head};text-align:right">${m.label}</th>`).join("")}</tr><tr><td style="${cell}">Yield</td>${mm.rates.map((m) => `<td style="${cell};text-align:right;font-weight:600">${pct(m.rate)}</td>`).join("")}</tr>${pastRowsHtml(mm.rates)}</table><p style="margin:6px 0 0;font-size:11px;color:#94a3b8">Fitted to ${mm.billCount} bills, ${esc(mm.convention)}.</p>`
		: `<p style="font-size:14px;color:#475569">The money market curve is not available for this date.</p>`;
	const shape =
		r.spreads.length === 0
			? ""
			: `<p style="margin:0;font-size:13px;color:#64748b">${esc(SHAPE_NOTE)}</p><table role="presentation" style="border-collapse:collapse;width:100%;margin-top:8px"><tr><th style="${head}">Gap</th><th style="${head};text-align:right">Now</th><th style="${head};text-align:right">1 day</th><th style="${head};text-align:right">1 week</th><th style="${head};text-align:right">1 month</th></tr>${r.spreads
					.map(
						(s) =>
							`<tr><td style="${cell}">${esc(spreadLabel(s))} <a href="${esc(links.site + s.path)}" style="color:#4f46e5;font-size:11px">${s.name}</a></td><td style="${cell};text-align:right;font-weight:600">${esc(signedBp(s.bp).replace(/^\+/, ""))}</td><td style="${cell};text-align:right">${esc(signedBp(s.changeBp))}</td><td style="${cell};text-align:right">${esc(signedBp(s.weekBp))}</td><td style="${cell};text-align:right">${esc(signedBp(s.monthBp))}</td></tr><tr><td colspan="5" style="padding:0 8px 8px;font-size:13px;color:#475569">${esc(spreadReads(s))}</td></tr>`,
					)
					.join("")}</table>`;
	const results =
		r.results.length === 0
			? `<p style="font-size:14px;color:#475569">No auction results on ${esc(shortDate(r.date))}.</p>`
			: `<table role="presentation" style="border-collapse:collapse;width:100%"><tr><th style="${head}">Auction</th><th style="${head}">Clearing rate</th><th style="${head};text-align:right">Cover</th><th style="${head}">Demand</th></tr>${r.results
					.map(({ auction: a, demand }) => {
						const story = demandStory(demand);
						return `<tr><td style="${cell}">${esc(auctionName(a))}<br><span style="color:#64748b;font-size:11px">${a.cusip}</span></td><td style="${cell}">${esc(clearingText(a))}</td><td style="${cell};text-align:right">${a.bid_to_cover_ratio?.toFixed(2) ?? "—"}</td><td style="${cell}">${esc(demandText(demand))}</td></tr>${story ? `<tr><td colspan="4" style="padding:0 8px 8px;font-size:13px;color:#475569">${esc(story)}</td></tr>` : ""}`;
					})
					.join("")}</table>`;
	const upcoming = (
		auctions: TRundown["today"],
		none: string,
		dated: boolean,
	) =>
		auctions.length === 0
			? `<p style="font-size:14px;color:#475569">${esc(none)}</p>`
			: `<table role="presentation" style="border-collapse:collapse;width:100%">${auctions
					.map(
						(a) =>
							`<tr>${dated ? `<td style="${cell}">${esc(shortDate(a.auction_date))}</td>` : ""}<td style="${cell}">${esc(auctionName(a))}<br><span style="color:#64748b;font-size:11px">${a.cusip}</span></td><td style="${cell};text-align:right">${esc(billions(a.offering_amount))}</td></tr>`,
					)
					.join("")}</table>`;
	const today = upcoming(r.today, "No Treasury auctions today.", false);
	const later = upcoming(
		r.later.auctions,
		`None announced yet for ${r.later.week}.`,
		true,
	);
	const ix = r.indices;
	const indices = ix
		? `<table role="presentation" style="border-collapse:collapse;width:100%;margin-top:8px"><tr><th style="${head}">Index</th><th style="${head};text-align:right">Level</th><th style="${head};text-align:right">1 day</th><th style="${head};text-align:right">1 week</th><th style="${head};text-align:right">1 month</th></tr>${ix
				.map(
					(i) =>
						`<tr><td style="${cell}"><a href="${indexUrl(i.slug)}" style="color:#0f172a">${esc(i.name)}</a><br><span style="font-family:monospace;font-size:11px;color:#64748b">${esc(i.ticker)}</span></td><td style="${cell};text-align:right;font-weight:600">${i.level.toFixed(2)}</td><td style="${cell};text-align:right">${signedPct(i.changePct)}</td><td style="${cell};text-align:right">${signedPct(i.weekPct)}</td><td style="${cell};text-align:right">${signedPct(i.monthPct)}</td></tr>`,
				)
				.join(
					"",
				)}</table><p style="margin:6px 0 0;font-size:11px;color:#94a3b8">Total return over the same closes as the curve.${ix.some((i) => i.isProvisional) ? " This month's levels are provisional until it closes." : ""} <a href="${links.site}/indices" style="color:#94a3b8">About the indices</a>.</p>`
		: `<p style="margin:8px 0 0;font-size:13px;color:#64748b">Index levels for this close are not published yet. <a href="${links.site}/indices">See the indices</a>.</p>`;
	const h2 = (t: string) =>
		`<h2 style="margin:24px 0 4px;font-size:16px">${esc(t)}</h2>`;
	const h3 = (t: string) =>
		`<h3 style="margin:18px 0 2px;font-size:14px;color:#334155">${esc(t)}</h3>`;
	const body = `<p style="margin:0;font-size:15px;line-height:1.6;color:#334155">${esc(summary)}</p>
${h2(`Auctions today, ${shortDate(r.edition)}`)}${today}
${h2(laterHeading(r))}${later}
${h2(`Auction results, ${shortDate(r.date)}`)}${results}
${h2(`Recap: the close, ${shortDate(r.date)}`)}<p style="margin:0;font-size:13px;color:#64748b">${esc(RECAP_NOTE)}</p>
${h3("The curve")}${curve}
${shape ? `${h3("Curve shape")}${shape}` : ""}
${h3("Money market")}${moneyMarket}
${h3("Safe Rate Treasury indices")}${indices}
${button(url, "View on the web")}`;
	const text = [
		`Treasury daily rundown: ${longDate(r.edition)}`,
		"",
		summary,
		"",
		`AUCTIONS TODAY, ${shortDate(r.edition).toUpperCase()}`,
		...(r.today.length === 0
			? ["  None."]
			: r.today.map(
					(a) => `  ${auctionName(a)}, ${billions(a.offering_amount)} (${a.cusip})`,
				)),
		"",
		laterHeading(r).toUpperCase(),
		...(r.later.auctions.length === 0
			? ["  None announced yet."]
			: r.later.auctions.map(
					(a) =>
						`  ${shortDate(a.auction_date)}: ${auctionName(a)}, ${billions(a.offering_amount)}`,
				)),
		"",
		`AUCTION RESULTS, ${shortDate(r.date).toUpperCase()}`,
		...(r.results.length === 0
			? ["  None."]
			: r.results.flatMap(({ auction: a, demand }) => {
					const story = demandStory(demand);
					return [
						`  ${auctionName(a)}: ${clearingText(a)}, bid-to-cover ${a.bid_to_cover_ratio?.toFixed(2) ?? "—"}, demand ${demandText(demand)}`,
						...(story ? [`    ${story}`] : []),
					];
				})),
		"",
		`RECAP: THE CLOSE, ${shortDate(r.date).toUpperCase()}`,
		`  ${RECAP_NOTE}`,
		"",
		"The curve (par yield; change on the day, week, month; zero; real)",
		...r.tenors.map(
			(t) =>
				`  ${`${t.years}y`.padEnd(4)} ${pct(t.parYield)}  ${signedBp(t.changeBp).padEnd(7)} ${signedBp(t.weekBp).padEnd(7)} ${signedBp(t.monthBp).padEnd(7)}  ${pct(t.zeroRate)}  ${pct(t.realRate)}`,
		),
		`  ${sinceText(r)}.`,
		"  Zero and real rates are continuously compounded.",
		"",
		"Curve shape (gap now; change on the day, week, month)",
		`  ${SHAPE_NOTE}`,
		...r.spreads.flatMap((s) => [
			`  ${`${spreadLabel(s)} (${s.name})`.padEnd(28)} ${signedBp(s.bp).replace(/^\+/, "").padEnd(7)} ${signedBp(s.changeBp).padEnd(7)} ${signedBp(s.weekBp).padEnd(7)} ${signedBp(s.monthBp)}`,
			`    ${spreadReads(s)}`,
		]),
		"",
		"Money market (yield; change on the day, week, month)",
		...(r.moneyMarket
			? r.moneyMarket.rates.map(
					(m) =>
						`  ${m.label.padEnd(4)} ${pct(m.rate)}  ${signedBp(m.changeBp).padEnd(7)} ${signedBp(m.weekBp).padEnd(7)} ${signedBp(m.monthBp)}`,
				)
			: ["  Not available for this date."]),
		"",
		"Safe Rate Treasury indices (level; total return on the day, week, month)",
		...(ix
			? [
					...ix.map(
						(i) =>
							`  ${i.name.padEnd(22)} ${i.level.toFixed(2).padStart(8)}  ${signedPct(i.changePct).padEnd(7)} ${signedPct(i.weekPct).padEnd(7)} ${signedPct(i.monthPct)}`,
					),
					`  About the indices: ${links.site}/indices`,
				]
			: ["  Not published yet for this close."]),
		"",
		`On the web: ${url}`,
		footerText(why, links),
	].join("\n");
	return {
		subject: `Treasury rundown, ${shortDate(r.edition)}: ${rundownHeadline(r)}`,
		text,
		html: layout({
			eyebrow: "Treasury daily rundown",
			title: longDate(r.edition),
			preheader: summary,
			body,
			why,
			links,
		}),
	};
};

// ── One auction's result ─────────────────────────────────────────────────────

export const auctionResultEmail = (
	input: { auction: TPublishedAuction; demand: TDemandWords | null },
	links: TEmailLinks,
): TRenderedEmail => {
	const a = input.auction;
	const name = auctionName(a);
	const demand = demandText(input.demand);
	const why =
		"You're receiving this because auction results alerts are on for your Safe Rate Markets account.";
	const rows: [string, string][] = [
		["Clearing rate", clearingText(a)],
		["Bid to cover", a.bid_to_cover_ratio?.toFixed(2) ?? "—"],
		[
			"High less median",
			a.high_less_median_basis_points === null
				? "—"
				: `${a.high_less_median_basis_points.toFixed(1)} bp`,
		],
		["Indirect", pct(a.bidders?.indirect_percent ?? null, 1)],
		["Direct", pct(a.bidders?.direct_percent ?? null, 1)],
		["Dealers", pct(a.bidders?.primary_dealer_percent ?? null, 1)],
		["Offering", billions(a.offering_amount)],
		["Demand", demand],
	];
	const board = `${links.site}/dashboard/auctions`;
	const headline = `${clearingText(a)}, bid-to-cover ${a.bid_to_cover_ratio?.toFixed(2) ?? "—"}`;
	return {
		subject: `${name} auction: ${headline}${input.demand?.verdict ? `, demand ${input.demand.verdict}` : ""}`,
		text: [
			`${name} auction, ${longDate(a.auction_date)} (${a.cusip})`,
			"",
			...rows.map(([k, v]) => `  ${k}: ${v}`),
			"",
			`All terms: ${board}`,
			footerText(why, links),
		].join("\n"),
		html: layout({
			eyebrow: "Auction result",
			title: `${name}, ${shortDate(a.auction_date)}`,
			preheader: headline,
			body: `<p style="margin:0 0 8px;font-size:13px;color:#64748b">${a.cusip}</p><table role="presentation" style="border-collapse:collapse;width:100%">${rows
				.map(
					([k, v]) =>
						`<tr><td style="${cell};color:#475569">${esc(k)}</td><td style="${cell};text-align:right;font-weight:600">${esc(v)}</td></tr>`,
				)
				.join("")}</table>${button(board, "See every term")}`,
			why,
			links,
		}),
	};
};

// ── One auction's announcement ───────────────────────────────────────────────

export const auctionAnnouncementEmail = (
	auction: TPublishedAuction,
	links: TEmailLinks,
): TRenderedEmail => {
	const a = auction;
	const name = auctionName(a);
	const why =
		"You're receiving this because auction announcement alerts are on for your Safe Rate Markets account.";
	const rows: [string, string][] = [
		["Auction date", longDate(a.auction_date)],
		["Issue date", longDate(a.issue_date)],
		["Offering", billions(a.offering_amount)],
		["Matures", a.maturity_date ? longDate(a.maturity_date) : "Set at auction"],
		[
			"Coupon",
			a.coupon_percent === null ? "Set at auction" : pct(a.coupon_percent),
		],
	];
	const board = `${links.site}/dashboard/auctions`;
	return {
		subject: `Announced: ${name}, ${billions(a.offering_amount)}, auctions ${shortDate(a.auction_date)}`,
		text: [
			`${name} announced (${a.cusip})`,
			"",
			...rows.map(([k, v]) => `  ${k}: ${v}`),
			"",
			`The schedule: ${board}`,
			footerText(why, links),
		].join("\n"),
		html: layout({
			eyebrow: "Auction announced",
			title: name,
			preheader: `${billions(a.offering_amount)}, auctions ${shortDate(a.auction_date)}`,
			body: `<p style="margin:0 0 8px;font-size:13px;color:#64748b">${a.cusip}</p><table role="presentation" style="border-collapse:collapse;width:100%">${rows
				.map(
					([k, v]) =>
						`<tr><td style="${cell};color:#475569">${esc(k)}</td><td style="${cell};text-align:right;font-weight:600">${esc(v)}</td></tr>`,
				)
				.join("")}</table>${button(board, "See the schedule")}`,
			why,
			links,
		}),
	};
};

// ── Confirming a sign-up from outside Markets ────────────────────────────────

export const confirmSignupEmail = (input: {
	confirmUrl: string;
	rundown: boolean;
	auctions: boolean;
}): TRenderedEmail => {
	const what = [
		input.auctions ? "auction results and announcements" : null,
		input.rundown ? "the Treasury daily rundown" : null,
	]
		.filter(Boolean)
		.join(" and ");
	const lead = `Confirm your email to receive ${what || "Treasury alerts"} from Safe Rate Markets.`;
	return {
		subject: "Confirm your Treasury email alerts",
		text: [
			"Confirm your Treasury email alerts",
			"",
			lead,
			"",
			input.confirmUrl,
			"",
			"The link works for 48 hours. If you did not ask for this, you can ignore this email.",
		].join("\n"),
		html: `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f8fafc">
<div style="font-family:${FONT};max-width:480px;margin:0 auto;padding:40px 24px;color:#0f172a">
<p style="margin:0 0 8px;font:600 13px/1.4 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#4f46e5">Safe Rate Markets</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">Confirm your Treasury email alerts</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#475569">${esc(lead)}</p>
${button(input.confirmUrl, "Confirm")}
<p style="margin:28px 0 0;font-size:13px;line-height:1.6;color:#64748b;word-break:break-all">Or paste this into your browser:<br>${esc(input.confirmUrl)}</p>
<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#94a3b8">The link works for 48 hours. If you did not ask for this, you can ignore this email.</p>
</div>
</body>
</html>`,
	};
};
