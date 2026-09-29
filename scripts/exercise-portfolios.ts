/**
 * Seed a user's example portfolios and drive every portfolio feature through
 * the REAL pages, as that user, on a deployed environment or the dev server.
 *
 *   doppler run -p saferate-markets -c stg -- bun scripts/exercise-portfolios.ts --env staging
 *   doppler run -p saferate-markets -c dev -- bun scripts/exercise-portfolios.ts --env development
 *
 * Flags: --email <address> (default dylan@saferate.com), --seed-only,
 * --exercise-only, --keep (leave the "Script test" stream, plan and portfolio).
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
	const response = await fetch(`${WEB}${path}`, {
		method: init.method ?? "GET",
		body: init.body,
		redirect: "manual",
		headers: {
			cookie: cookieHeader(),
			origin: WEB,
			"user-agent": "saferate-markets exercise-portfolios script",
		},
	});
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
	if (page.status !== 200) return fail(what, `HTTP ${page.status} for ${path}`);
	const shown = problems(page.text);
	if (shown.length > 0) return fail(what, shown.join(" | ").slice(0, 400));
	if (!page.text.includes(marker))
		return fail(what, `no "${marker}" on ${path}`);
	pass(what, took);
	return page.text;
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

/** The securities priced on `date`, or on the next priced day within a week. */
const pricedOn = async (date: string) => {
	const cached = listCache.get(date);
	if (cached) return cached;
	const day = new Date(`${date}T00:00:00Z`);
	for (let i = 0; i < 7; i++) {
		const iso = day.toISOString().slice(0, 10);
		const response = await fetch(`${API}/v1/securities?date=${iso}`, {
			headers: { authorization: `Bearer ${KEY}` },
		});
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

const tradesCsv = async (trades: TSeedTrade[]) => {
	const lines = ["CUSIP,Side,Trade Date,Face Amount,Price"];
	for (const t of trades) {
		const close = await closeOf(t.cusip, t.date);
		lines.push(`${t.cusip},${t.side},${close.date},${t.face},${close.price}`);
	}
	return lines.join("\n");
};

const importCsv = (idPortfolio: string, csv: string, name = "trades.csv") =>
	post(`/dashboard/portfolios/${idPortfolio}/transactions`, {
		intent: "import",
		file: new File([csv], name, { type: "text/csv" }),
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

const seed = async () => {
	heading("Seed example portfolios");
	const existing = await existingPortfolios();
	for (const s of SEEDS) {
		if (existing.has(s.name)) {
			pass(s.name, "already there, left alone");
			continue;
		}
		const id = await createPortfolio(s.name, s.benchmark, s.policy);
		if (id === null) {
			fail(s.name, "create did not redirect to the new portfolio");
			continue;
		}
		const imported = await importCsv(id, await tradesCsv(await s.trades()));
		const shown = problems(imported.text);
		if (imported.status >= 400 || shown.length > 0)
			fail(s.name, `import refused: ${shown.join(" | ") || imported.status}`);
		else pass(s.name, `created and imported (${id})`);
	}
	return existingPortfolios();
};

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
		for (const attr of ["mtd", "ytd", "1y", "inception"])
			await expectPage(
				`${name}: tracking, ${attr} attribution`,
				`/dashboard/portfolios/${id}?attr=${attr}`,
				"Growth of $1",
			);
		await expectPage(
			`${name}: custom period`,
			`/dashboard/portfolios/${id}?attr=custom&from=2026-03-31&to=2026-06-30`,
			"Growth of $1",
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
		if (overview) figures.push({ name, ...headline(overview) });
	}
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
	: await seed();
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
