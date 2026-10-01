/**
 * Seed a user's example portfolios and drive every portfolio feature through
 * the REAL pages, as that user, on a deployed environment or the dev server.
 *
 *   doppler run -p saferate-markets -c stg -- bun scripts/exercise-portfolios.ts --env staging
 *   doppler run -p saferate-markets -c dev -- bun scripts/exercise-portfolios.ts --env development
 *
 * Flags: --email <address> (default dylan@saferate.com), --seed-only,
 * --exercise-only, --keep (leave the "Script test" stream, plan and portfolio),
 * --testing (also seed the twenty "Test NN" portfolios built to break things,
 * and run the import break tests), --only <text> (exercise only portfolios
 * whose name contains it), --timeout <seconds> per request (default 120).
 *
 * Sign-in without an email: a one-time magic-link token is written to the
 * `verification` table exactly as Better Auth's sign-in endpoint writes it, and
 * the app's own /api/auth/magic-link/verify spends it and sets the session
 * cookie. So the script is signed in by the app, not by a forged cookie, and
 * the session is an ordinary one that expires. Production is refused: its D1
 * is not ours to write (see CLAUDE.md, production freeze).
 *
 * Seeding goes through the pages too (create, then CSV import at each day's
 * FedInvest close from the markets API), so it tests import and validation on
 * the way. A seeded portfolio whose name already exists is left alone, so
 * reruns do not duplicate. Everything the exercise creates is named
 * "Script test" and deleted at the end unless --keep.
 *
 * Needs, from Doppler: CLOUDFLARE_API_TOKEN (wrangler, remote D1) and
 * MARKETS_SMOKE_KEY (closes from the REST API). Neither is printed.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { SITE_HOSTS } from "@markets/schema";

// ── Arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? null : (argv[i + 1] ?? null);
};
const ENV = option("env") ?? "staging";
if (ENV !== "staging" && ENV !== "development") {
	console.error("--env must be staging or development. Production is refused.");
	process.exit(2);
}
const EMAIL = option("email") ?? "dylan@saferate.com";
const WEB = SITE_HOSTS[ENV].web;
const API = SITE_HOSTS[ENV].api;
const KEY = process.env.MARKETS_SMOKE_KEY;
if (!KEY) {
	console.error("MARKETS_SMOKE_KEY is not set: run under doppler run.");
	process.exit(2);
}
const WEB_APP_DIR = resolve(import.meta.dir, "../apps/web");
const TEST = "Script test";
const REQUEST_TIMEOUT_MS = Number(option("timeout") ?? 120) * 1000;
/** --only <text>: exercise just the portfolios whose name contains it. */
const ONLY = option("only");
/** --dump <dir>: save each exercised portfolio's Tracking page there, to read. */
const DUMP = option("dump");

// ── Reporting ────────────────────────────────────────────────────────────────

let failures = 0;
const pass = (what: string, detail = "") =>
	console.info(`  ok    ${what}${detail ? `  ${detail}` : ""}`);
const fail = (what: string, detail: string) => {
	failures += 1;
	console.info(`  FAIL  ${what}  ${detail}`);
};
const heading = (what: string) => console.info(`\n${what}`);

// ── D1 through wrangler ──────────────────────────────────────────────────────

const d1 = (sql: string) => {
	const where =
		ENV === "staging"
			? ["--env", "staging", "--remote"]
			: ["--local", "--persist-to", "../../.wrangler/state"];
	const run = spawnSync(
		"bunx",
		["wrangler", "d1", "execute", "DB", ...where, "--json", "--command", sql],
		{ cwd: WEB_APP_DIR, encoding: "utf8" },
	);
	if (run.status !== 0)
		throw new Error(`wrangler d1 execute failed: ${run.stderr || run.stdout}`);
	return JSON.parse(run.stdout) as { results: Record<string, unknown>[] }[];
};
const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

// ── A browser: a cookie jar, no redirects followed ───────────────────────────

const jar = new Map<string, string>();
const remember = (response: Response) => {
	for (const cookie of response.headers.getSetCookie()) {
		const [pair] = cookie.split(";");
		const eq = pair.indexOf("=");
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (value === "" || /max-age=0/i.test(cookie)) jar.delete(name);
		else jar.set(name, value);
	}
};
const cookieHeader = () =>
	[...jar].map(([name, value]) => `${name}=${value}`).join("; ");

const request = async (
	path: string,
	init: { method?: string; body?: FormData } = {},
) => {
	let response: Response;
	try {
		response = await fetch(`${WEB}${path}`, {
			method: init.method ?? "GET",
			body: init.body,
			redirect: "manual",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: {
				cookie: cookieHeader(),
				origin: WEB,
				"user-agent": "saferate-markets exercise-portfolios script",
			},
		});
	} catch (error) {
		// No answer at all is a finding, not a crash of the script.
		return {
			status: 0,
			location: null,
			text: `no response: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	remember(response);
	return {
		status: response.status,
		location: response.headers.get("location"),
		text: await response.text(),
	};
};
const get = (path: string) => request(path);
const post = (path: string, fields: Record<string, string | Blob>) => {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) body.append(name, value);
	return request(path, { method: "POST", body });
};

/** The text of every red problem box on a page: what the user would read as an error. */
const problems = (html: string) =>
	[...html.matchAll(/<(div|p|ul)[^>]*bg-red-50[^>]*>([\s\S]*?)<\/\1>/g)].map(
		(m) =>
			m[2]
				.replace(/<[^>]+>/g, " ")
				.replace(/&#x27;|&#39;/g, "'")
				.replace(/&quot;/g, '"')
				.replace(/&amp;/g, "&")
				.replace(/\s+/g, " ")
				.trim(),
	);
const idFrom = (location: string | null, pattern: RegExp) =>
	location?.match(pattern)?.[1] ?? null;

/** A page that must render, carry `marker`, and show no problem box. */
const expectPage = async (what: string, path: string, marker: string) => {
	const started = Date.now();
	const page = await get(path);
	const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
	if (page.status !== 200)
		return fail(
			what,
			page.status === 0
				? `${page.text} after ${took} for ${path}`
				: `HTTP ${page.status} after ${took} for ${path}`,
		);
	const shown = problems(page.text);
	if (shown.length > 0) return fail(what, shown.join(" | ").slice(0, 400));
	// React's server render puts <!-- --> between adjacent text pieces
	// ("History: " and the term), so match on the text without them.
	if (!page.text.replace(/<!--.*?-->/g, "").includes(marker))
		return fail(what, `no "${marker}" on ${path}`);
	const broken = nonsense(page.text);
	if (broken.length > 0) return fail(what, broken.join(" | ").slice(0, 400));
	pass(what, took);
	return page.text;
};

/**
 * What a reader would see as a bug even on a page that rendered: a number
 * that is not one, a value the code never filled in, or an attribution whose
 * parts do not add up to its total (the page then says "unexplained").
 */
const nonsense = (html: string) => {
	const visible = html
		.replace(/<script[\s\S]*?<\/script>/g, " ")
		.replace(/<style[\s\S]*?<\/style>/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ");
	const found: string[] = [];
	for (const word of ["NaN", "Infinity", "undefined", "[object Object]"]) {
		const at = visible.indexOf(word);
		if (at !== -1)
			found.push(
				`"${word}" in: …${visible.slice(Math.max(0, at - 80), at + 40)}…`,
			);
	}
	const unexplained = visible.match(/unexplained: [^)]+/);
	if (unexplained) found.push(`attribution ${unexplained[0]}`);
	return found;
};

// ── Sign in ──────────────────────────────────────────────────────────────────

const signIn = async () => {
	heading(`Sign in as ${EMAIL} on ${WEB}`);
	const token = [...crypto.getRandomValues(new Uint8Array(32))]
		.map((b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"[b % 52])
		.join("");
	const now = new Date();
	const expires = new Date(now.getTime() + 5 * 60_000);
	d1(
		`insert into verification (id, identifier, value, expiresAt, createdAt, updatedAt) values (${[
			randomUUID(),
			token,
			JSON.stringify({ email: EMAIL }),
			expires.toISOString(),
			now.toISOString(),
			now.toISOString(),
		]
			.map(sqlString)
			.join(", ")})`,
	);
	const verified = await get(
		`/api/auth/magic-link/verify?token=${token}&callbackURL=${encodeURIComponent("/dashboard")}`,
	);
	if (verified.status !== 302 || jar.size === 0) {
		fail("sign in", `HTTP ${verified.status} ${verified.location ?? ""}`);
		process.exit(1);
	}
	const dashboard = await get("/dashboard");
	if (dashboard.status !== 200 || !dashboard.text.includes(EMAIL)) {
		fail("sign in", `dashboard answered ${dashboard.status}`);
		process.exit(1);
	}
	pass("signed in", "via a one-time magic-link token");
};

// ── Market data from the REST API ────────────────────────────────────────────

type TListed = {
	cusip: string;
	family: string;
	coupon_percent: number | null;
	maturity_date: string | null;
	price: number | null;
};
const listCache = new Map<string, { date: string; securities: TListed[] }>();

/** The API allows 60 requests a minute per organization: stay under it, and wait out a 429. */
let lastCall = 0;
const paced = async (url: string): Promise<Response> => {
	for (let attempt = 0; attempt < 5; attempt++) {
		const wait = lastCall + 1_100 - Date.now();
		if (wait > 0) await Bun.sleep(wait);
		lastCall = Date.now();
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${KEY}` },
		});
		if (response.status !== 429) return response;
		await Bun.sleep(15_000);
	}
	throw new Error(`${url}: still rate-limited after five tries`);
};

/** The securities priced on `date`, or on the next priced day within a week. */
const pricedOn = async (date: string) => {
	const cached = listCache.get(date);
	if (cached) return cached;
	const day = new Date(`${date}T00:00:00Z`);
	for (let i = 0; i < 7; i++) {
		const iso = day.toISOString().slice(0, 10);
		const response = await paced(`${API}/v1/securities?date=${iso}`);
		if (response.ok) {
			const body = (await response.json()) as { securities: TListed[] };
			const found = { date: iso, securities: body.securities };
			listCache.set(date, found);
			return found;
		}
		if (response.status !== 404)
			throw new Error(`${API}/v1/securities?date=${iso}: HTTP ${response.status}`);
		day.setUTCDate(day.getUTCDate() + 1);
	}
	throw new Error(`Nothing priced in the week from ${date}`);
};

const yearsAfter = (date: string, years: number) => {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + Math.round(years * 365.25));
	return d.toISOString().slice(0, 10);
};

/** The priced security of `families` maturing closest to `years` after the list's date. */
const pick = (
	list: { date: string; securities: TListed[] },
	families: string[],
	years: number,
	exclude: Set<string> = new Set(),
) => {
	const target = new Date(`${yearsAfter(list.date, years)}T00:00:00Z`).getTime();
	const candidates = list.securities.filter(
		(s) =>
			families.includes(s.family) &&
			s.price !== null &&
			s.maturity_date !== null &&
			!exclude.has(s.cusip),
	);
	const best = candidates.sort(
		(a, b) =>
			Math.abs(new Date(`${a.maturity_date}T00:00:00Z`).getTime() - target) -
			Math.abs(new Date(`${b.maturity_date}T00:00:00Z`).getTime() - target),
	)[0];
	if (best === undefined)
		throw new Error(`No ${families.join("/")} near ${years}y on ${list.date}`);
	exclude.add(best.cusip);
	return best;
};

const closeOf = async (cusip: string, date: string) => {
	const list = await pricedOn(date);
	const found = list.securities.find((s) => s.cusip === cusip);
	if (found?.price == null)
		throw new Error(`${cusip} has no close on ${list.date}`);
	return { date: list.date, price: found.price };
};

// ── The seeded portfolios ────────────────────────────────────────────────────

type TSeedTrade = {
	cusip: string;
	side: "buy" | "sell";
	date: string;
	face: number;
};
type TSeed = {
	name: string;
	benchmark: string;
	policy: "cash" | "reinvest" | "distribute";
	trades: () => Promise<TSeedTrade[]>;
	/**
	 * An independent expectation of the overview's tiles, where the answer is
	 * knowable from the trades alone. Returns a problem, or null.
	 */
	check?: (tiles: Record<string, string>) => Promise<string | null>;
};

const SEEDS: TSeed[] = [
	{
		name: "Core ladder, 1-5 years",
		benchmark: "0103",
		policy: "cash",
		trades: async () => {
			const list = await pricedOn("2025-10-01");
			const used = new Set<string>();
			return [1, 2, 3, 4, 5].map((years) => ({
				cusip: pick(list, ["note"], years, used).cusip,
				side: "buy" as const,
				date: list.date,
				face: 250_000,
			}));
		},
	},
	{
		name: "Bill roll",
		benchmark: "SHRT",
		policy: "cash",
		trades: async () => {
			const jan = await pricedOn("2026-01-05");
			const apr = await pricedOn("2026-04-06");
			const jul = await pricedOn("2026-07-06");
			const used = new Set<string>();
			return [
				{ cusip: pick(jan, ["bill"], 0.25, used).cusip, date: jan.date },
				{ cusip: pick(jan, ["bill"], 0.5, used).cusip, date: jan.date },
				{ cusip: pick(apr, ["bill"], 0.25, used).cusip, date: apr.date },
				{ cusip: pick(jul, ["bill"], 0.5, used).cusip, date: jul.date },
			].map((t) => ({ ...t, side: "buy" as const, face: 1_000_000 }));
		},
	},
	{
		name: "Long duration",
		benchmark: "1020",
		policy: "reinvest",
		trades: async () => {
			const nov = await pricedOn("2025-11-03");
			const ten = pick(nov, ["note"], 10).cusip;
			const thirty = pick(nov, ["bond"], 30).cusip;
			const jun = await pricedOn("2026-06-01");
			return [
				{ cusip: ten, side: "buy", date: nov.date, face: 2_000_000 },
				{ cusip: thirty, side: "buy", date: nov.date, face: 1_000_000 },
				{ cusip: thirty, side: "sell", date: jun.date, face: 500_000 },
			];
		},
	},
	{
		name: "Inflation and floaters",
		benchmark: "TIPS",
		policy: "distribute",
		trades: async () => {
			const feb = await pricedOn("2026-02-02");
			const used = new Set<string>();
			return [
				{ cusip: pick(feb, ["tips"], 5, used).cusip, face: 1_000_000 },
				{ cusip: pick(feb, ["tips"], 10, used).cusip, face: 500_000 },
				{ cusip: pick(feb, ["frn"], 2, used).cusip, face: 1_000_000 },
			].map((t) => ({ ...t, side: "buy" as const, date: feb.date }));
		},
	},
];

// ── The testing set (--testing): twenty portfolios chosen to break things ────

const addDays = (date: string, days: number) => {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
};
const addMonths = (date: string, months: number) => {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCMonth(d.getUTCMonth() + months);
	return d.toISOString().slice(0, 10);
};
/** Priced securities of `families` maturing between two horizons, shortest first. */
const between = (
	list: { date: string; securities: TListed[] },
	families: string[],
	fromYears: number,
	toYears: number,
) =>
	list.securities
		.filter(
			(s) =>
				families.includes(s.family) &&
				s.price !== null &&
				s.maturity_date !== null &&
				s.maturity_date >= yearsAfter(list.date, fromYears) &&
				s.maturity_date <= yearsAfter(list.date, toYears),
		)
		.sort((a, b) => (a.maturity_date ?? "").localeCompare(b.maturity_date ?? ""));
/** `k` items spread evenly along `xs`, first and last included. */
const spread = <T>(xs: T[], k: number) =>
	xs.length <= k
		? xs
		: Array.from(
				{ length: k },
				(_, i) => xs[Math.round((i * (xs.length - 1)) / (k - 1))],
			);
const dollars = (shown: string | undefined) =>
	shown === undefined ? Number.NaN : Number(shown.replace(/[$,\s]/g, ""));
const buy = (cusip: string, date: string, face: number): TSeedTrade => ({
	cusip,
	side: "buy",
	date,
	face,
});
const sell = (cusip: string, date: string, face: number): TSeedTrade => ({
	cusip,
	side: "sell",
	date,
	face,
});
const NOMINAL = ["bill", "note", "bond"];

/** Test 01's bill, re-derived for its check on any run. */
const test01Bill = async () => {
	const jan = await pricedOn("2026-01-05");
	return { date: jan.date, bill: pick(jan, ["bill"], 0.5) };
};

const TESTING: TSeed[] = [
	{
		name: "Test 01: One bill, held to maturity",
		benchmark: "BILL",
		policy: "distribute",
		trades: async () => {
			const { date, bill } = await test01Bill();
			return [buy(bill.cusip, date, 1_000_000)];
		},
		// Distributed and matured: nothing held, and the gain is exactly face less cost.
		check: async (tiles) => {
			const { bill } = await test01Bill();
			const expected = 1_000_000 - (1_000_000 * (bill.price as number)) / 100;
			const gain = dollars(tiles["Total gain"]);
			if (Math.abs(gain - expected) > 2)
				return `total gain ${tiles["Total gain"]}, expected $${expected.toFixed(0)}: face less cost`;
			if (dollars(tiles["Market value"]) !== 0)
				return `market value ${tiles["Market value"]} after maturity, expected $0`;
			return null;
		},
	},
	{
		name: "Test 02: One 30-year bond",
		benchmark: "20PL",
		policy: "cash",
		trades: async () => {
			const mar = await pricedOn("2026-03-02");
			return [buy(pick(mar, ["bond"], 30).cusip, mar.date, 1_000_000)];
		},
	},
	{
		name: "Test 03: The same 10-year note, bought monthly",
		benchmark: "0710",
		policy: "reinvest",
		trades: async () => {
			const first = await pricedOn("2025-10-01");
			const note = pick(first, ["note"], 10).cusip;
			const trades: TSeedTrade[] = [];
			for (let k = 0; k < 12; k++)
				trades.push(
					buy(note, (await pricedOn(addMonths("2025-10-01", k))).date, 100_000),
				);
			return trades;
		},
	},
	{
		name: "Test 04: In and out of one note, FIFO lots",
		benchmark: "0307",
		policy: "cash",
		trades: async () => {
			const on = async (d: string) => (await pricedOn(d)).date;
			const note = pick(await pricedOn("2025-11-03"), ["note"], 5).cusip;
			// Held: 500k, 800k, 400k, 600k, 0 (closed), then 100k reopened.
			return [
				buy(note, await on("2025-11-03"), 500_000),
				buy(note, await on("2026-01-05"), 300_000),
				sell(note, await on("2026-03-02"), 400_000),
				buy(note, await on("2026-05-01"), 200_000),
				sell(note, await on("2026-07-01"), 600_000),
				buy(note, await on("2026-09-01"), 100_000),
			];
		},
	},
	{
		name: "Test 05: Round trip, all sold",
		benchmark: "0103",
		policy: "distribute",
		trades: async () => {
			const feb = await pricedOn("2026-02-02");
			const note = pick(feb, ["note"], 2).cusip;
			return [
				buy(note, feb.date, 1_000_000),
				sell(note, (await pricedOn("2026-06-01")).date, 1_000_000),
			];
		},
		check: async (tiles) =>
			dollars(tiles["Market value"]) === 0
				? null
				: `market value ${tiles["Market value"]} with everything sold and distributed, expected $0`,
	},
	{
		name: "Test 06: Forty securities across the curve",
		benchmark: "AGG",
		policy: "cash",
		trades: async () => {
			const jan = await pricedOn("2026-01-05");
			return spread(between(jan, NOMINAL, 0.1, 30), 40).map((s) =>
				buy(s.cusip, jan.date, 250_000),
			);
		},
	},
	{
		name: "Test 07: A hundred odd lots of $1,000",
		benchmark: "broad",
		policy: "cash",
		trades: async () => {
			const apr = await pricedOn("2026-04-01");
			return spread(between(apr, NOMINAL, 0.05, 30), 100).map((s) =>
				buy(s.cusip, apr.date, 1_000),
			);
		},
	},
	{
		name: "Test 08: TIPS ladder",
		benchmark: "TIPS",
		policy: "cash",
		trades: async () => {
			const oct = await pricedOn("2025-10-01");
			const used = new Set<string>();
			return [2, 4, 6, 8, 10, 20].map((years) =>
				buy(pick(oct, ["tips"], years, used).cusip, oct.date, 500_000),
			);
		},
	},
	{
		name: "Test 09: Every floating-rate note",
		benchmark: "FRN",
		policy: "cash",
		trades: async () => {
			const jan = await pricedOn("2026-01-05");
			const aug = await pricedOn("2026-08-03");
			const held = jan.securities.filter((s) => s.family === "frn");
			const fresh = aug.securities.filter(
				(s) => s.family === "frn" && !held.some((h) => h.cusip === s.cusip),
			);
			const latest = [...aug.securities.filter((s) => s.family === "frn")].sort(
				(a, b) => (b.maturity_date ?? "").localeCompare(a.maturity_date ?? ""),
			)[0];
			return [
				...held.map((s) => buy(s.cusip, jan.date, 1_000_000)),
				...fresh.map((s) => buy(s.cusip, aug.date, 1_000_000)),
				...(latest ? [buy(latest.cusip, aug.date, 500_000)] : []),
			];
		},
	},
	{
		name: "Test 10: Bills, TIPS, floaters and a long bond",
		benchmark: "AGG",
		policy: "distribute",
		trades: async () => {
			const mar = await pricedOn("2026-03-02");
			const used = new Set<string>();
			return [
				pick(mar, ["bill"], 0.25, used),
				pick(mar, ["bill"], 1, used),
				pick(mar, ["tips"], 10, used),
				pick(mar, ["frn"], 2, used),
				pick(mar, ["bond"], 30, used),
			].map((s) => buy(s.cusip, mar.date, 1_000_000));
		},
	},
	{
		name: "Test 11: Bought in the 2008 crisis, held",
		benchmark: "broad",
		policy: "cash",
		trades: async () => {
			// Eighteen years of ledger, three maturities on the way (2010, 2013, 2018).
			const oct = await pricedOn("2008-10-01");
			const used = new Set<string>();
			return [
				pick(oct, ["note"], 2, used),
				pick(oct, ["tips"], 5, used),
				pick(oct, ["note"], 10, used),
				pick(oct, ["bond"], 30, used),
			].map((s) => buy(s.cusip, oct.date, 1_000_000));
		},
	},
	{
		name: "Test 12: Held through COVID",
		benchmark: "0307",
		policy: "reinvest",
		trades: async () => {
			const dec = await pricedOn("2019-12-02");
			const used = new Set<string>();
			const [two, five, seven] = [2, 5, 7].map(
				(y) => pick(dec, ["note"], y, used).cusip,
			);
			return [
				buy(two, dec.date, 1_000_000),
				buy(five, dec.date, 1_000_000),
				buy(seven, dec.date, 1_000_000),
				buy(five, (await pricedOn("2020-03-16")).date, 1_000_000),
				sell(seven, (await pricedOn("2022-06-01")).date, 1_000_000),
			];
		},
	},
	{
		name: "Test 13: Institutional block, $750M",
		benchmark: "0103",
		policy: "cash",
		trades: async () => {
			const jun = await pricedOn("2026-06-01");
			return [
				buy(pick(jun, ["note"], 2).cusip, jun.date, 500_000_000),
				buy(pick(jun, ["bill"], 0.25).cusip, jun.date, 250_000_000),
			];
		},
	},
	{
		name: "Test 14: $100 lots",
		benchmark: "broad",
		policy: "distribute",
		trades: async () => {
			const jul = await pricedOn("2026-07-01");
			const used = new Set<string>();
			return [
				pick(jul, ["bill"], 0.25, used),
				pick(jul, ["note"], 2, used),
				pick(jul, ["note"], 5, used),
				pick(jul, ["note"], 10, used),
				pick(jul, ["bond"], 30, used),
			].map((s) => buy(s.cusip, jul.date, 100));
		},
	},
	{
		name: "Test 15: New issues, bought on their first day",
		benchmark: "broad",
		policy: "cash",
		trades: async () => {
			let seen = new Set(
				(await pricedOn("2026-07-31")).securities.map((s) => s.cusip),
			);
			const trades: TSeedTrade[] = [];
			const wanted = new Set(["note", "bond", "tips"]);
			for (
				let d = "2026-08-03";
				d <= "2026-08-31" && wanted.size > 0;
				d = addDays(d, 1)
			) {
				const day = await pricedOn(d);
				if (day.date !== d) continue; // not a priced day
				for (const s of day.securities)
					if (!seen.has(s.cusip) && wanted.has(s.family) && s.price !== null) {
						trades.push(buy(s.cusip, day.date, 1_000_000));
						wanted.delete(s.family);
					}
				seen = new Set([...seen, ...day.securities.map((s) => s.cusip)]);
			}
			return trades;
		},
	},
	{
		name: "Test 16: Monthly bill roll, reinvested",
		benchmark: "BILL",
		policy: "reinvest",
		trades: async () => {
			const trades: TSeedTrade[] = [];
			for (let k = 0; k < 8; k++) {
				const list = await pricedOn(addMonths("2026-01-05", k));
				trades.push(buy(pick(list, ["bill"], 1 / 12).cusip, list.date, 1_000_000));
			}
			return trades;
		},
	},
	{
		name: "Test 17: Two-year note rolled quarterly since 2024",
		benchmark: "0103",
		policy: "cash",
		trades: async () => {
			const trades: TSeedTrade[] = [];
			let held: string | null = null;
			for (let k = 0; k < 11; k++) {
				const list = await pricedOn(addMonths("2024-01-02", 3 * k));
				const current = pick(list, ["note"], 2).cusip;
				if (current === held) continue;
				if (held !== null) trades.push(sell(held, list.date, 1_000_000));
				trades.push(buy(current, list.date, 1_000_000));
				held = current;
			}
			return trades;
		},
	},
	{
		name: "Test 18: Coupon date and a bill two days from maturity",
		benchmark: "0103",
		policy: "cash",
		trades: async () => {
			const may = await pricedOn("2026-05-15");
			const coupon = may.securities.find(
				(s) =>
					s.family === "note" &&
					s.price !== null &&
					/-(05|11)-15$/.test(s.maturity_date ?? "") &&
					(s.maturity_date ?? "") > "2028",
			);
			const jun = await pricedOn("2026-06-01");
			const soon = jun.securities
				.filter(
					(s) =>
						s.family === "bill" &&
						s.price !== null &&
						(s.maturity_date ?? "") > addDays(jun.date, 2),
				)
				.sort((a, b) =>
					(a.maturity_date ?? "").localeCompare(b.maturity_date ?? ""),
				)[0];
			return [
				...(coupon ? [buy(coupon.cusip, may.date, 1_000_000)] : []),
				...(soon ? [buy(soon.cusip, jun.date, 1_000_000)] : []),
			];
		},
	},
	{
		name: "Test 19: Ten TIPS, each against its nominal",
		benchmark: "TIPS",
		policy: "distribute",
		trades: async () => {
			const feb = await pricedOn("2026-02-02");
			const tips = spread(between(feb, ["tips"], 0.5, 30), 10);
			const nominals = between(feb, ["note", "bond"], 0.3, 31);
			return tips.flatMap((t) => {
				const near = [...nominals].sort(
					(a, b) =>
						Math.abs(
							Date.parse(a.maturity_date ?? "") - Date.parse(t.maturity_date ?? ""),
						) -
						Math.abs(
							Date.parse(b.maturity_date ?? "") - Date.parse(t.maturity_date ?? ""),
						),
				)[0];
				return [
					buy(t.cusip, feb.date, 1_000_000),
					buy(near.cusip, feb.date, 1_000_000),
				];
			});
		},
	},
	{
		name: "Test 20: Thirteen hundred trades",
		benchmark: "0307",
		policy: "cash",
		trades: async () => {
			// Ten notes, $10k of each every week for two years, and $20k of each
			// sold every fourth week.
			const start = await pricedOn("2024-10-01");
			const notes = spread(between(start, ["note"], 3, 10), 10).map(
				(s) => s.cusip,
			);
			const trades: TSeedTrade[] = [];
			for (let w = 0; w < 104; w++) {
				const day = (await pricedOn(addDays("2024-10-01", 7 * w))).date;
				for (const note of notes) trades.push(buy(note, day, 10_000));
				if (w % 4 === 3)
					for (const note of notes) trades.push(sell(note, day, 20_000));
			}
			return trades;
		},
	},
];

// ── Break tests (--testing): each in its own throwaway portfolio ────────────

/** The ISIN of a US CUSIP: "US" + CUSIP + the Luhn check digit on its digit expansion. */
const isinOf = (cusip: string) => {
	const body = `US${cusip}`;
	const digits = [...body]
		.map((ch) => (/[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)))
		.join("");
	let sum = 0;
	[...digits].reverse().forEach((ch, i) => {
		let d = Number(ch);
		if (i % 2 === 0) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
	});
	return `${body}${(10 - (sum % 10)) % 10}`;
};
const toThirtySeconds = (price: number) => {
	const whole = Math.floor(price);
	const ticks = Math.round((price - whole) * 32);
	return ticks === 32
		? `${whole + 1}-00`
		: `${whole}-${String(ticks).padStart(2, "0")}`;
};

type TBreak = {
	what: string;
	expect: "accept" | "refuse" | "report";
	csv: () => Promise<string>;
	/** Import once first; the outcome judged is the second import, with these fields. */
	again?: Record<string, string>;
};

const breakTests = async () => {
	heading("Break tests: what the trade import accepts and refuses");
	const sep = await pricedOn("2026-09-01");
	const note = pick(sep, ["note"], 5);
	const px = note.price as number;
	const { bill: matured } = await test01Bill();
	const header = "CUSIP,Side,Trade Date,Face Amount,Price";
	const row = (
		date: string,
		side = "buy",
		face = "100000",
		price = String(px),
		cusip = note.cusip,
	) => `${cusip},${side},${date},${face},${price}`;
	const today = new Date().toISOString().slice(0, 10);
	const cases: TBreak[] = [
		{
			what: "a Saturday trade date",
			expect: "refuse",
			csv: async () => `${header}\n${row("2026-08-29")}`,
		},
		{
			what: "a federal holiday (Labor Day)",
			expect: "refuse",
			csv: async () => `${header}\n${row("2026-09-07")}`,
		},
		{
			what: "a trade date in the future",
			expect: "refuse",
			csv: async () => `${header}\n${row(addDays(today, 7))}`,
		},
		{
			what: "a bill bought after it matured",
			expect: "refuse",
			csv: async () =>
				`${header}\n${row("2026-09-01", "buy", "100000", "100", matured.cusip)}`,
		},
		{
			what: "an unknown CUSIP",
			expect: "refuse",
			csv: async () =>
				`${header}\n${row("2026-09-01", "buy", "100000", String(px), "912828ZZ1")}`,
		},
		{
			what: "a negative face amount",
			expect: "refuse",
			csv: async () => `${header}\n${row("2026-09-01", "buy", "-100000")}`,
		},
		{
			what: "a zero price",
			expect: "refuse",
			csv: async () => `${header}\n${row("2026-09-01", "buy", "100000", "0")}`,
		},
		{
			what: "a price quoted per $1 (0.99)",
			expect: "refuse",
			csv: async () =>
				`${header}\n${row("2026-09-01", "buy", "100000", (px / 100).toFixed(4))}`,
		},
		{ what: "an empty file", expect: "refuse", csv: async () => "" },
		{ what: "a header and no rows", expect: "refuse", csv: async () => header },
		{
			// Padded with an account column so it is over 1 MB whatever the
			// price's length: the first version of this case came in just under
			// and so tested the row cap instead.
			what: "a file over 1 MB",
			expect: "refuse",
			csv: async () =>
				`${header},Account\n${Array.from({ length: 25_000 }, () => `${row("2026-09-01")},${"x".repeat(20)}`).join("\n")}`,
		},
		{
			what: "6,000 trades, under 1 MB",
			expect: "refuse",
			csv: async () =>
				`${header}\n${Array.from({ length: 6_000 }, () => row("2026-09-01")).join("\n")}`,
		},
		{
			what: "selling more than was bought",
			expect: "refuse",
			csv: async () =>
				`${header}\n${row("2026-09-01")}\n${row("2026-09-02", "sell", "200000")}`,
		},
		{
			what: "one bad row among good ones (all or nothing)",
			expect: "refuse",
			csv: async () =>
				`${header}\n${row("2026-09-01")}\n${row("2026-09-02", "buy", "abc")}`,
		},
		{
			what: "an ISIN instead of a CUSIP",
			expect: "accept",
			csv: async () =>
				`${header}\n${row("2026-09-01", "buy", "100000", String(px), isinOf(note.cusip))}`,
		},
		{
			what: "a price in 32nds",
			expect: "accept",
			csv: async () =>
				`${header}\n${row("2026-09-01", "buy", "100000", toThirtySeconds(px))}`,
		},
		{
			what: "a price with a dollar sign",
			expect: "accept",
			csv: async () =>
				`${header}\n${row("2026-09-01", "buy", "100000", `$${px}`)}`,
		},
		{
			what: "a US-style date (9/1/2026)",
			expect: "accept",
			csv: async () => `${header}\n${row("9/1/2026")}`,
		},
		{
			what: "a face amount with thousands commas, quoted",
			expect: "accept",
			csv: async () => `${header}\n${row("2026-09-01", "buy", '"100,000"')}`,
		},
		{
			what: "other column names, in another order",
			expect: "accept",
			csv: async () =>
				`Px,Qty,Trade Dt,Security ID,Action\n${px},100000,2026-09-01,${note.cusip},BOUGHT`,
		},
		{
			what: "a Windows file (BOM and CRLF)",
			expect: "accept",
			csv: async () => `﻿${header}\r\n${row("2026-09-01")}\r\n`,
		},
		{
			what: "an explicit settlement date",
			expect: "accept",
			csv: async () =>
				`CUSIP,Side,Trade Date,Settle Date,Face,Price\n${note.cusip},buy,2026-09-01,2026-09-03,100000,${px}`,
		},
		{
			what: "a sell listed before the same day's buy",
			expect: "report",
			csv: async () =>
				`${header}\n${row("2026-09-01", "sell")}\n${row("2026-09-01")}`,
		},
		{
			what: "the same file imported twice",
			expect: "refuse",
			csv: async () => `${header}\n${row("2026-09-01")}`,
			again: {},
		},
		{
			what: "the same file again, with Import anyway",
			expect: "accept",
			csv: async () => `${header}\n${row("2026-09-01")}`,
			again: { allowDuplicates: "yes" },
		},
	];
	for (const c of cases) {
		const id = await createPortfolio(`${TEST}: break`, "broad", "cash");
		if (id === null) {
			fail(c.what, "could not create a scratch portfolio");
			continue;
		}
		const csv = await c.csv();
		let result = await importCsv(id, csv);
		if (c.again !== undefined)
			result = await importCsv(id, csv, "trades.csv", c.again);
		const refused = problems(result.text);
		const accepted = refused.length === 0 && /trades? added/.test(result.text);
		const outcome =
			result.status >= 500
				? "crashed"
				: accepted
					? "accept"
					: refused.length > 0
						? "refuse"
						: "unclear";
		const said = refused.join(" | ").slice(0, 220);
		if (c.expect === "report")
			pass(c.what, `${outcome}${said ? `: ${said}` : ""}`);
		else if (outcome === c.expect)
			pass(c.what, `${outcome}${said ? `: ${said}` : ""}`);
		else
			fail(
				c.what,
				`expected ${c.expect}, got ${outcome} (HTTP ${result.status})${said ? `: ${said}` : ""}`,
			);
		// A duplicate warning must offer the way through it.
		if (c.again !== undefined && outcome === "refuse")
			result.text.includes('name="allowDuplicates"')
				? pass(`${c.what}: offers "Import anyway"`)
				: fail(`${c.what}: offers "Import anyway"`, "no checkbox on the page");
		// Whatever was accepted must still value.
		if (outcome === "accept") {
			const page = await get(`/dashboard/portfolios/${id}`);
			const broken = [...problems(page.text), ...nonsense(page.text)];
			if (page.status !== 200 || broken.length > 0)
				fail(
					`${c.what}: then values`,
					`HTTP ${page.status} ${broken.join(" | ").slice(0, 200)}`,
				);
		}
		await post(`/dashboard/portfolios/${id}/transactions`, {
			intent: "deletePortfolio",
			confirmName: `${TEST}: break`,
		});
	}
};

const tradesCsv = async (trades: TSeedTrade[]) => {
	const lines = ["CUSIP,Side,Trade Date,Face Amount,Price"];
	for (const t of trades) {
		const close = await closeOf(t.cusip, t.date);
		lines.push(`${t.cusip},${t.side},${close.date},${t.face},${close.price}`);
	}
	return lines.join("\n");
};

const importCsv = (
	idPortfolio: string,
	csv: string,
	name = "trades.csv",
	extra: Record<string, string> = {},
) =>
	post(`/dashboard/portfolios/${idPortfolio}/transactions`, {
		intent: "import",
		file: new File([csv], name, { type: "text/csv" }),
		...extra,
	});

const existingPortfolios = async () => {
	const page = await get("/dashboard/portfolios");
	const found = new Map<string, string>();
	for (const m of page.text.matchAll(
		/href="\/dashboard\/portfolios\/([^"/]+)"[^>]*>([^<]+)</g,
	))
		found.set(m[2].replace(/&amp;/g, "&").trim(), m[1]);
	return found;
};

const createPortfolio = async (
	name: string,
	benchmark: string,
	policy: string,
) => {
	const created = await post("/dashboard/portfolios", {
		namePortfolio: name,
		codeBenchmark: benchmark,
		policyIncome: policy,
	});
	return idFrom(
		created.location,
		/\/dashboard\/portfolios\/([^/]+)\/transactions/,
	);
};

const seed = async (seeds: TSeed[]) => {
	heading(`Seed ${seeds.length} portfolios`);
	const existing = await existingPortfolios();
	for (const s of seeds) {
		if (existing.has(s.name)) {
			pass(s.name, "already there, left alone");
			continue;
		}
		const id = await createPortfolio(s.name, s.benchmark, s.policy);
		if (id === null) {
			fail(s.name, "create did not redirect to the new portfolio");
			continue;
		}
		const trades = await s.trades();
		const imported = await importCsv(id, await tradesCsv(trades));
		const shown = problems(imported.text);
		if (imported.status >= 400 || shown.length > 0)
			fail(
				s.name,
				`import refused (HTTP ${imported.status}): ${shown.join(" | ").slice(0, 400)}`,
			);
		else pass(s.name, `${trades.length} trades imported (${id})`);
	}
	return existingPortfolios();
};

const ALL_SEEDS = [...SEEDS, ...TESTING];

// ── The exercise ─────────────────────────────────────────────────────────────

/** The overview's headline tiles, label to value, as the user reads them. */
const headline = (html: string) => {
	const tiles: Record<string, string> = {};
	for (const m of html.matchAll(
		/<p class="text-xs uppercase[^"]*">([^<]+)<\/p><p class="tabular[^"]*">([^<]+)<\/p>/g,
	))
		tiles[m[1]] = m[2];
	const periods: string[] = [];
	for (const m of html.matchAll(
		/<tr class="border-t border-slate-100"><td class="px-3 py-2">([^<]+)(?:<span[^>]*>[^<]*<\/span>)?<\/td><td class="tabular[^"]*">([^<]+)<\/td>(?:<td class="tabular[^"]*">([^<]+)<\/td>)?/g,
	))
		periods.push(`${m[1]} ${m[2]}${m[3] ? ` (index ${m[3]})` : ""}`);
	return { tiles, periods };
};
const figures: {
	name: string;
	tiles: Record<string, string>;
	periods: string[];
}[] = [];

const exercisePortfolios = async (ids: Map<string, string>) => {
	heading("Tracking, attribution, stress and the overview, per portfolio");
	for (const [name, id] of ids) {
		if (name.startsWith(TEST)) continue;
		if (ONLY !== null && !name.includes(ONLY)) continue;
		let tracking: string | undefined;
		for (const attr of ["mtd", "ytd", "1y", "inception"])
			tracking =
				(await expectPage(
					`${name}: tracking, ${attr} attribution`,
					`/dashboard/portfolios/${id}?attr=${attr}`,
					"Growth of $100",
				)) ?? tracking;
		await expectPage(
			`${name}: custom period`,
			`/dashboard/portfolios/${id}?attr=custom&from=2026-03-31&to=2026-06-30`,
			"Growth of $100",
		);
		await expectPage(
			`${name}: stress`,
			`/dashboard/stress?portfolio=${id}`,
			"Key-rate DV01",
		);
		const overview = await expectPage(
			`${name}: overview`,
			`/dashboard?portfolio=${id}`,
			"Return since inception",
		);
		if (DUMP !== null && tracking)
			await Bun.write(
				`${DUMP}/${name.replace(/[^A-Za-z0-9]+/g, "-")}.html`,
				tracking,
			);
		if (overview) {
			const shown = headline(overview);
			figures.push({ name, ...shown });
			// The overview and the Tracking page value with the same code; they
			// must show the same figures. Found 2026-09-29: the overview added
			// cash to a market value that already held it.
			if (tracking) {
				const there = headline(tracking).tiles;
				const differ = ["Market value", "Total gain"].filter(
					(label) => there[label] !== shown.tiles[label],
				);
				differ.length === 0
					? pass(`${name}: overview agrees with Tracking`)
					: fail(
							`${name}: overview agrees with Tracking`,
							differ.map((l) => `${l} ${shown.tiles[l]} vs ${there[l]}`).join("; "),
						);
			}
			const check = ALL_SEEDS.find((s) => s.name === name)?.check;
			if (check) {
				const problem = await check(shown.tiles);
				problem
					? fail(`${name}: figures`, problem)
					: pass(`${name}: figures`, "as computed independently");
			}
		}
	}
};

const exerciseMarkets = async () => {
	heading("Treasury Auctions and Rates");
	await expectPage("auctions", "/dashboard/auctions", "Latest result, by term");
	for (const term of [
		"Bill 4-Week",
		"Bill 13-Week",
		"Note 2-Year",
		"Bond 30-Year",
		"TIPS 10-Year",
		"FRN 2-Year",
	])
		await expectPage(
			`auctions: ${term} history`,
			`/dashboard/auctions?term=${encodeURIComponent(term)}`,
			`History: ${term}`,
		);
	await expectPage(
		"auctions: an unknown term falls back",
		"/dashboard/auctions?term=nonsense",
		"History: Note 10-Year",
	);
	await expectPage("rates", "/dashboard/rates", "Treasury Rates");
	await expectPage("rich / cheap", "/dashboard/rich-cheap", "scoreable");
	await expectPage(
		"rich / cheap on a past day",
		"/dashboard/rich-cheap?date=2025-06-02",
		"Jun 2, 2025",
	);
	const weekend = await get("/dashboard/rich-cheap?date=2026-09-26");
	problems(weekend.text).some((p) => /No curve analytics/.test(p))
		? pass("rich / cheap on a Saturday says there is nothing", "")
		: fail(
				"rich / cheap on a Saturday",
				problems(weekend.text).join(" | ") || `HTTP ${weekend.status}`,
			);
};

const exerciseBacktests = async () => {
	heading("Strategy backtests");
	const q = (params: Record<string, string>) =>
		`/dashboard/backtest?${new URLSearchParams({ run: "1", initial: "1000000", cost: "0.5", horizon: "10", ...params })}`;
	await expectPage(
		"backtest: all seven, five years quarterly",
		q({
			strategy: "all",
			start: "2021-09-28",
			end: "2026-09-28",
			frequency: "quarterly",
		}),
		"Growth of $100",
	);
	await expectPage(
		"backtest: a ladder, monthly over two years",
		q({
			strategy: "ladder",
			start: "2024-09-27",
			end: "2026-09-28",
			frequency: "monthly",
		}),
		"Rebalanced",
	);
	await expectPage(
		"backtest: long duration through 2008-2012, yearly",
		q({
			strategy: "long",
			start: "2008-10-01",
			end: "2012-12-31",
			frequency: "annual",
		}),
		"Worst drawdown",
	);
	await expectPage(
		"backtest: the Builder's link (no dates) runs five years",
		`/dashboard/backtest?${new URLSearchParams({ run: "1", strategy: "bullet", horizon: "7" })}`,
		"Rungs filled",
	);
	const refused = await get(
		q({
			strategy: "all",
			start: "2008-10-01",
			end: "2026-09-28",
			frequency: "monthly",
		}),
	);
	problems(refused.text).some((p) => /at most 5 years/.test(p))
		? pass("backtest: too long a monthly run is refused, and says why")
		: fail(
				"backtest: too long a monthly run is refused",
				problems(refused.text).join(" | ") || `HTTP ${refused.status}`,
			);
};

const PAYOUTS = Array.from(
	{ length: 10 },
	(_, i) => `${2027 + i}-06-30, 1,000,000, Year ${i + 1} payout`,
).join("\n");

const exerciseBuilder = async () => {
	const created: { plan?: string; stream?: string; portfolio?: string } = {};

	heading("Liabilities");
	const saved = await post("/dashboard/liabilities", {
		name: `${TEST}: pension payouts`,
		lines: PAYOUTS,
	});
	created.stream =
		idFrom(saved.location, /\/dashboard\/liabilities\/([^/?]+)/) ?? undefined;
	if (created.stream === undefined) {
		fail(
			"save a liability stream",
			problems(saved.text).join(" | ") || `HTTP ${saved.status}`,
		);
		return created;
	}
	pass("save a liability stream", `10 payouts of $1M (${created.stream})`);
	await expectPage(
		"open the stream",
		`/dashboard/liabilities/${created.stream}`,
		"Year 10 payout",
	);

	heading("Portfolio Builder, every method");
	const latest = await pricedOn(new Date().toISOString().slice(0, 10)).catch(
		async () => {
			const d = new Date();
			d.setUTCDate(d.getUTCDate() - 6);
			return pricedOn(d.toISOString().slice(0, 10));
		},
	);
	const used = new Set<string>();
	const customRows = [
		`${pick(latest, ["note"], 2, used).cusip}, 100000`,
		`${pick(latest, ["note"], 5, used).cusip}, 100000`,
		`${pick(latest, ["bill"], 0.5, used).cusip}, 50000`,
	].join("\n");
	const runs: [string, Record<string, string>][] = [
		[
			"cash-flow match, retail lots",
			{ mode: "match", stream: created.stream, lots: "retail" },
		],
		[
			"cash-flow match, Apex lots",
			{ mode: "match", stream: created.stream, lots: "apex" },
		],
		[
			"cash-flow match, institutional lots",
			{ mode: "match", stream: created.stream, lots: "institutional" },
		],
		[
			"cash-flow match, at most 6 positions",
			{ mode: "match", stream: created.stream, maxpos: "6" },
		],
		["immunise", { mode: "immunise", stream: created.stream }],
		[
			"horizon match, 5 years",
			{ mode: "horizon", stream: created.stream, horizon: "5" },
		],
		[
			"track the Aggregate index",
			{ mode: "index", index: "AGG", budget: "5000000" },
		],
		[
			"track 3-7 Year, $1M minimum position",
			{ mode: "index", index: "0307", budget: "5000000", minpos: "1000000" },
		],
		["custom plan", { mode: "custom", rows: customRows }],
		...[
			"billRoll",
			"shortEnd",
			"ladder",
			"intermediate",
			"long",
			"bullet",
			"barbell",
		].map(
			(strategy) =>
				[
					`strategy: ${strategy}`,
					{ mode: "strategy", strategy, budget: "2000000", horizon: "10" },
				] as [string, Record<string, string>],
		),
	];
	let toSave: URLSearchParams | null = null;
	for (const [what, params] of runs) {
		const query = new URLSearchParams({ run: "1", ...params });
		const html = await expectPage(
			what,
			`/dashboard/builder?${query}`,
			"Save this plan",
		);
		if (html && toSave === null && params.mode === "match") toSave = query;
	}
	const refused = await get(
		`/dashboard/builder?${new URLSearchParams({ run: "1", mode: "match" })}`,
	);
	if (problems(refused.text).some((p) => /liability stream/i.test(p)))
		pass("match with no liabilities is refused", "and says why");
	else fail("match with no liabilities is refused", "no explanation shown");

	heading("Save a plan, its order sheet, and track it");
	if (toSave === null) {
		fail("save a plan", "no successful match run to save");
		return created;
	}
	const plan = await post("/dashboard/builder", {
		query: toSave.toString(),
		namePlan: `${TEST}: matched payouts`,
	});
	created.plan =
		idFrom(plan.location, /\/dashboard\/plans\/([^/?]+)/) ?? undefined;
	if (created.plan === undefined) {
		fail("save a plan", problems(plan.text).join(" | ") || `HTTP ${plan.status}`);
		return created;
	}
	pass("save a plan", created.plan);
	await expectPage(
		"open the plan",
		`/dashboard/plans/${created.plan}`,
		"TreasuryDirect",
	);
	await expectPage(
		"execution lists it",
		"/dashboard/execution",
		`${TEST}: matched payouts`,
	);
	const csv = await get(`/dashboard/plans/${created.plan}/orders.csv`);
	const rows = csv.text.trim().split("\n");
	if (csv.status === 200 && rows.length > 1 && /cusip/i.test(rows[0]))
		pass(
			"order sheet CSV",
			`${rows.length - 1} orders; header: ${rows[0].slice(0, 80)}`,
		);
	else fail("order sheet CSV", `HTTP ${csv.status}, ${rows.length} lines`);

	const tracked = await post(`/dashboard/plans/${created.plan}`, {
		intent: "portfolio",
	});
	created.portfolio =
		idFrom(tracked.location, /\/dashboard\/portfolios\/([^/]+)\/transactions/) ??
		undefined;
	if (created.portfolio === undefined) {
		fail("track the plan as a portfolio", `HTTP ${tracked.status}`);
		return created;
	}
	pass("track the plan as a portfolio", created.portfolio);
	await expectPage(
		"the tracked plan values",
		`/dashboard/portfolios/${created.portfolio}`,
		"Holdings",
	);

	heading("Trade entry refuses what it should");
	const bad = await importCsv(
		created.portfolio,
		"CUSIP,Side,Trade Date,Face Amount,Price\nNOTACUSP1X,buy,2026-09-01,1000,99",
		"bad.csv",
	);
	if (problems(bad.text).length > 0) pass("a malformed CSV is refused whole");
	else fail("a malformed CSV is refused whole", "no error shown");
	const cusip = rows[1]?.match(/\b[0-9]{3}[0-9A-Z]{6}\b/)?.[0] ?? null;
	if (cusip) {
		const offMarket = await post(
			`/dashboard/portfolios/${created.portfolio}/transactions`,
			{
				intent: "add",
				cusip,
				side: "buy",
				tradeDate: latest.date,
				faceAmount: "10000",
				cleanPrice: "50",
			},
		);
		if (problems(offMarket.text).some((p) => /close/i.test(p)))
			pass("a price far from the close is refused");
		else
			fail(
				"a price far from the close is refused",
				problems(offMarket.text).join(" | ") || "accepted",
			);
		const oversold = await post(
			`/dashboard/portfolios/${created.portfolio}/transactions`,
			{
				intent: "add",
				cusip,
				side: "sell",
				tradeDate: latest.date,
				faceAmount: "900000000",
				cleanPrice: String(
					latest.securities.find((s) => s.cusip === cusip)?.price ?? 100,
				),
			},
		);
		if (problems(oversold.text).some((p) => /held|oversold|only/i.test(p)))
			pass("selling more than is held is refused");
		else
			fail(
				"selling more than is held is refused",
				problems(oversold.text).join(" | ") || "accepted",
			);
	} else
		fail("trade entry checks", "could not read a CUSIP from the order sheet");
	return created;
};

const cleanUp = async (created: {
	plan?: string;
	stream?: string;
	portfolio?: string;
}) => {
	heading("Clean up the script's own records");
	if (created.portfolio) {
		const r = await post(
			`/dashboard/portfolios/${created.portfolio}/transactions`,
			{
				intent: "deletePortfolio",
				confirmName: `${TEST}: matched payouts`,
			},
		);
		r.status === 302
			? pass("delete the test portfolio")
			: fail("delete the test portfolio", `HTTP ${r.status}`);
	}
	if (created.plan) {
		const r = await post(`/dashboard/plans/${created.plan}`, {
			intent: "delete",
			confirm: "yes",
		});
		r.status === 302
			? pass("delete the test plan")
			: fail("delete the test plan", `HTTP ${r.status}`);
	}
	if (created.stream) {
		const r = await post(`/dashboard/liabilities/${created.stream}`, {
			intent: "delete",
			confirm: "yes",
		});
		r.status === 302
			? pass("delete the test stream")
			: fail("delete the test stream", `HTTP ${r.status}`);
	}
};

// ── Run ──────────────────────────────────────────────────────────────────────

await signIn();
const portfolios = flag("exercise-only")
	? await existingPortfolios()
	: await seed(flag("testing") ? ALL_SEEDS : SEEDS);
if (!flag("seed-only")) {
	await exercisePortfolios(portfolios);
	heading("What the overview shows");
	for (const f of figures) {
		console.info(`  ${f.name}`);
		console.info(
			`    ${Object.entries(f.tiles)
				.map(([label, value]) => `${label}: ${value}`)
				.join(" · ")}`,
		);
		console.info(`    ${f.periods.join(" · ")}`);
	}
	await exerciseMarkets();
	await exerciseBacktests();
	if (flag("testing")) await breakTests();
	const created = await exerciseBuilder();
	if (!flag("keep")) await cleanUp(created);
	await expectPage(
		"overview after it all",
		"/dashboard",
		"Return since inception",
	);
}
console.info(
	failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
