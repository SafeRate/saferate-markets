import { resolveEmailProvider } from "@markets/email";
import {
	demandKey,
	groupOf,
	publishAuction,
	readAuctionDemand,
	readAuctionsBetween,
	shiftDays,
	type TAuction,
} from "@markets/mcp-tools";
import {
	claimAlertSend,
	claimedAlertUsers,
	finishAlertSend,
	listAlertRecipients,
	observeAlertEvents,
	type TAlertKind,
	type TAlertRecipient,
} from "@markets/persistence";
import { resolveMarketsEnv, SENDER_ADDRESS, SITE_HOSTS } from "@markets/schema";
import {
	auctionAnnouncementEmail,
	auctionResultEmail,
	rundownEmail,
	type TEmailLinks,
	type TRenderedEmail,
} from "@/lib/alertEmails";
import { latestRundownDate, loadRundown } from "./dailyRundown.server";

/**
 * Sending the email alerts: one sweep, run by the web Worker's cron every few
 * minutes, that finds what is new and mails whoever wants it.
 *
 * EXACTLY ONCE. Each email is claimed in alertSends (primary key kind, event,
 * user) before it is sent, so a second tick, an overlapping run or a retry
 * cannot send it again; a claim that failed to send stays failed rather than
 * being retried into a duplicate.
 *
 * NO BACKLOG. An event is mailed only while it is FRESH, within FRESH_MS of
 * when the sweep first saw it (alertEvents). Someone who turns alerts on gets
 * the next result, not last week's; a run cut short by the per-tick budget
 * finishes on the next tick, inside that window. The first sweep ever records
 * what already exists and sends none of it.
 *
 * NO PROMISED SPEED. An auction result is mailed on the first tick after it
 * reaches treasury's store, and the copy says only that.
 */

const FRESH_MS = 6 * 60 * 60 * 1000;
/** Emails per tick: inside a Worker's subrequest limit, and the daily quota. */
const BUDGET = 80;

type TSweepEnv = Env & {
	BETTER_AUTH_SECRET?: string;
	EMAIL_RECIPIENT_ALLOWLIST?: string;
};

// ── Signed links ─────────────────────────────────────────────────────────────

export type TUnsubscribeScope = TAlertKind | "all";

const toBase64Url = (bytes: ArrayBuffer) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

/** An HMAC over the user and scope, so an unsubscribe link cannot be forged. */
export const signUnsubscribe = async (
	secret: string,
	idUser: string,
	scope: TUnsubscribeScope,
) => {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`alerts-unsubscribe:${idUser}:${scope}`),
	);
	return toBase64Url(mac).slice(0, 32);
};

export const verifyUnsubscribe = async (
	secret: string,
	idUser: string,
	scope: TUnsubscribeScope,
	signature: string,
) => {
	const expected = await signUnsubscribe(secret, idUser, scope);
	if (expected.length !== signature.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++)
		diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	return diff === 0;
};

export const siteFor = (env: Env) =>
	SITE_HOSTS[resolveMarketsEnv(env.MARKETS_ENV)].web;

export const unsubscribeUrl = async (
	env: TSweepEnv,
	idUser: string,
	scope: TUnsubscribeScope,
) => {
	if (!env.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is not set");
	const sig = await signUnsubscribe(env.BETTER_AUTH_SECRET, idUser, scope);
	const q = new URLSearchParams({ u: idUser, s: scope, t: sig });
	return `${siteFor(env)}/alerts/unsubscribe?${q}`;
};

// ── Sending one ──────────────────────────────────────────────────────────────

const sendOne = async (
	env: TSweepEnv,
	input: {
		kind: TAlertKind;
		eventKey: string;
		recipient: TAlertRecipient;
		render: (links: TEmailLinks) => TRenderedEmail;
	},
): Promise<"sent" | "skipped" | "failed" | "withheld"> => {
	const { kind, eventKey, recipient } = input;
	const claimed = await claimAlertSend({
		db: env.DB,
		kind,
		eventKey,
		idUser: recipient.idUser,
	});
	if (!claimed) return "skipped";
	try {
		const unsubscribe = await unsubscribeUrl(env, recipient.idUser, kind);
		const links: TEmailLinks = {
			site: siteFor(env),
			manage: `${siteFor(env)}/dashboard/alerts`,
			unsubscribe,
		};
		const email = input.render(links);
		const result = await resolveEmailProvider(env as never).send({
			to: recipient.email,
			from: SENDER_ADDRESS,
			subject: email.subject,
			text: email.text,
			html: email.html,
			// RFC 8058 one-click: Gmail and Yahoo POST to this URL.
			headers: {
				"List-Unsubscribe": `<${unsubscribe}>`,
				"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
			},
		});
		await finishAlertSend({
			db: env.DB,
			kind,
			eventKey,
			idUser: recipient.idUser,
			status: result.status,
			reason: result.status === "sent" ? null : result.reason,
		});
		return result.status;
	} catch (error) {
		await finishAlertSend({
			db: env.DB,
			kind,
			eventKey,
			idUser: recipient.idUser,
			status: "failed",
			reason: error instanceof Error ? error.message : String(error),
		});
		return "failed";
	}
};

const wantsTerm = (recipient: TAlertRecipient, group: string) =>
	recipient.preferences.terms === null ||
	recipient.preferences.terms.includes(group);

// ── The sweep ────────────────────────────────────────────────────────────────

type TTally = Record<"sent" | "skipped" | "failed" | "withheld", number>;

export const sweepAlerts = async (env: TSweepEnv, now = new Date()) => {
	const tally: TTally = { sent: 0, skipped: 0, failed: 0, withheld: 0 };
	let budget = BUDGET;
	const lines: string[] = [];
	const fresh = (firstSeenAt: number | undefined) =>
		firstSeenAt !== undefined &&
		firstSeenAt > 0 &&
		now.getTime() - firstSeenAt < FRESH_MS;

	/** Mail one event to everyone who wants it and has not had it. */
	const deliver = async (input: {
		kind: TAlertKind;
		eventKey: string;
		recipients: TAlertRecipient[];
		render: (links: TEmailLinks) => TRenderedEmail;
	}) => {
		const done = await claimedAlertUsers({
			db: env.DB,
			kind: input.kind,
			eventKey: input.eventKey,
		});
		const due = input.recipients.filter((r) => !done.has(r.idUser));
		for (const recipient of due) {
			if (budget <= 0) break;
			budget -= 1;
			tally[await sendOne(env, { ...input, recipient })] += 1;
		}
		if (due.length > 0)
			lines.push(`${input.kind} ${input.eventKey}: ${due.length} due`);
	};

	// Auctions first: a result is the most time-sensitive of the three.
	const today = now.toISOString().slice(0, 10);
	const auctions = await readAuctionsBetween(env, {
		from: shiftDays(today, -3),
		to: shiftDays(today, 60),
	});
	const keyOf = (a: TAuction) => demandKey(a.cusip, a.auctionDate);

	const results = auctions.filter(
		(a) => a.auctionDate <= today && a.bidToCoverRatio !== null,
	);
	const resultSeen = await observeAlertEvents({
		db: env.DB,
		kind: "auctionResult",
		eventKeys: results.map(keyOf),
		now: now.getTime(),
	});
	const freshResults = results.filter((a) => fresh(resultSeen.get(keyOf(a))));
	if (freshResults.length > 0) {
		const recipients = await listAlertRecipients({
			db: env.DB,
			kind: "auctionResult",
		});
		const demandByDate = new Map<
			string,
			Awaited<ReturnType<typeof readAuctionDemand>>
		>();
		for (const a of freshResults) {
			if (!demandByDate.has(a.auctionDate))
				demandByDate.set(
					a.auctionDate,
					await readAuctionDemand(env, a.auctionDate),
				);
			const demand = demandByDate.get(a.auctionDate)?.get(keyOf(a)) ?? null;
			const group = groupOf(a);
			await deliver({
				kind: "auctionResult",
				eventKey: keyOf(a),
				recipients: recipients.filter((r) => wantsTerm(r, group)),
				render: (links) =>
					auctionResultEmail({ auction: publishAuction(a, today), demand }, links),
			});
		}
	}

	const announced = auctions.filter((a) => a.auctionDate > today);
	const announcedSeen = await observeAlertEvents({
		db: env.DB,
		kind: "auctionAnnouncement",
		eventKeys: announced.map(keyOf),
		now: now.getTime(),
	});
	const freshAnnounced = announced.filter((a) =>
		fresh(announcedSeen.get(keyOf(a))),
	);
	if (freshAnnounced.length > 0) {
		const recipients = await listAlertRecipients({
			db: env.DB,
			kind: "auctionAnnouncement",
		});
		for (const a of freshAnnounced) {
			const group = groupOf(a);
			await deliver({
				kind: "auctionAnnouncement",
				eventKey: keyOf(a),
				recipients: recipients.filter((r) => wantsTerm(r, group)),
				render: (links) =>
					auctionAnnouncementEmail(publishAuction(a, today), links),
			});
		}
	}

	// The rundown: once a close's curve is in, for the day it was fitted on.
	const latest = await latestRundownDate(env, now);
	if (latest !== null) {
		const seen = await observeAlertEvents({
			db: env.DB,
			kind: "rundown",
			eventKeys: [latest],
			now: now.getTime(),
		});
		if (fresh(seen.get(latest))) {
			const rundown = await loadRundown(env, latest);
			if (rundown === null)
				lines.push(`rundown ${latest}: no curve after all; not sent`);
			else
				await deliver({
					kind: "rundown",
					eventKey: latest,
					recipients: await listAlertRecipients({ db: env.DB, kind: "rundown" }),
					render: (links) => rundownEmail(rundown, links),
				});
		}
	}

	return `alerts: sent ${tally.sent}, withheld ${tally.withheld}, failed ${tally.failed}${budget <= 0 ? ", budget spent (the rest next tick)" : ""}${lines.length ? `; ${lines.join("; ")}` : ""}`;
};
