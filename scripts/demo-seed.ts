/**
 * Write packages/persistence/migrations/<name>.sql: the shared, READ-ONLY demo
 * that a signed-in account without a paid plan tours (lib/session.server.ts
 * requireDashboard). One organization, five portfolios, a liability stream and
 * a saved plan, with fixed ids so staging and production hold the same demo.
 *
 *   doppler run -p saferate-markets -c stg -- bun scripts/demo-seed.ts 0006_demo_portfolios
 *
 * Trades are at each day's FedInvest close from the markets API, on priced
 * days only, chosen as the testing portfolios are (scripts/exercise-portfolios.ts).
 * The pension portfolio and the saved plan are the Builder's own cash-flow
 * match (packages/portfolio matchLiabilities) of the demo stream, a year ago
 * and today. Both environments read production treasury data, so the prices
 * hold in either. Re-run and add a NEW migration to refresh the demo; never
 * edit an applied one.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	LOT_PRESETS,
	matchLiabilities,
	planUniverse,
	settlementFor,
	type TFamily,
} from "../packages/portfolio/src/index";
import { SITE_HOSTS } from "@markets/schema";
import { DEMO_ORGANIZATION_ID } from "../packages/persistence/src/demo";

const NAME = process.argv[2];
if (!NAME || !/^\d{4}_[a-z_]+$/.test(NAME)) {
	console.error("usage: bun scripts/demo-seed.ts 0006_demo_portfolios");
	process.exit(2);
}
const KEY = process.env.MARKETS_SMOKE_KEY;
if (!KEY) {
	console.error("MARKETS_SMOKE_KEY is not set: run under doppler run.");
	process.exit(2);
}
const API = SITE_HOSTS.staging.api;

type TListed = {
	cusip: string;
	family: string;
	coupon_percent: number | null;
	maturity_date: string | null;
	price: number | null;
};
const cache = new Map<string, { date: string; securities: TListed[] }>();
let last = 0;
const pricedOn = async (date: string) => {
	const hit = cache.get(date);
	if (hit) return hit;
	const day = new Date(`${date}T00:00:00Z`);
	for (let i = 0; i < 7; i++) {
		const iso = day.toISOString().slice(0, 10);
		const wait = last + 1_100 - Date.now();
		if (wait > 0) await Bun.sleep(wait);
		last = Date.now();
		const response = await fetch(`${API}/v1/securities?date=${iso}`, {
			headers: { authorization: `Bearer ${KEY}` },
		});
		if (response.ok) {
			const found = {
				date: iso,
				securities: ((await response.json()) as { securities: TListed[] })
					.securities,
			};
			cache.set(date, found);
			return found;
		}
		day.setUTCDate(day.getUTCDate() + 1);
	}
	throw new Error(`nothing priced in the week from ${date}`);
};
const yearsAfter = (date: string, years: number) => {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + Math.round(years * 365.25));
	return d.toISOString().slice(0, 10);
};
const pick = (
	list: { date: string; securities: TListed[] },
	families: string[],
	years: number,
	used = new Set<string>(),
) => {
	const target = Date.parse(yearsAfter(list.date, years));
	const best = list.securities
		.filter(
			(s) =>
				families.includes(s.family) &&
				s.price !== null &&
				s.maturity_date !== null &&
				!used.has(s.cusip),
		)
		.sort(
			(a, b) =>
				Math.abs(Date.parse(a.maturity_date ?? "") - target) -
				Math.abs(Date.parse(b.maturity_date ?? "") - target),
		)[0];
	if (!best) throw new Error(`no ${families} near ${years}y on ${list.date}`);
	used.add(best.cusip);
	return best;
};
const priceOf = (list: { securities: TListed[] }, cusip: string) => {
	const p = list.securities.find((s) => s.cusip === cusip)?.price;
	if (p == null) throw new Error(`${cusip} unpriced`);
	return p;
};
const addMonths = (date: string, months: number) => {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCMonth(d.getUTCMonth() + months);
	return d.toISOString().slice(0, 10);
};

type TTrade = {
	cusip: string;
	side: "buy" | "sell";
	date: string;
	face: number;
	price: number;
};
const buy = async (
	cusip: string,
	date: string,
	face: number,
): Promise<TTrade> => {
	const list = await pricedOn(date);
	return {
		cusip,
		side: "buy",
		date: list.date,
		face,
		price: priceOf(list, cusip),
	};
};
const sell = async (
	cusip: string,
	date: string,
	face: number,
): Promise<TTrade> => ({
	...(await buy(cusip, date, face)),
	side: "sell",
});

const PAYOUTS = Array.from({ length: 10 }, (_, i) => ({
	date: `${2027 + i}-06-30`,
	amount: 1_000_000,
	label: `Year ${i + 1} payout`,
}));

const universeOn = async (date: string) => {
	const list = await pricedOn(date);
	return {
		list,
		universe: planUniverse({
			securities: list.securities
				.filter((s) => s.price !== null && s.maturity_date !== null)
				.map((s) => ({
					cusip: s.cusip,
					family: s.family as TFamily,
					couponPercent: s.coupon_percent ?? 0,
					maturityDate: s.maturity_date as string,
					price: s.price as number,
				})),
			settlementDate: settlementFor(list.date),
			markup: 0,
		}),
	};
};
const matched = async (date: string) => {
	const { list, universe } = await universeOn(date);
	const plan = matchLiabilities({
		universe,
		liabilities: PAYOUTS.map(({ date: d, amount }) => ({ date: d, amount })),
		denomination: 1000,
		lots: LOT_PRESETS.retail,
	});
	if ("kind" in plan) throw new Error(plan.message);
	return { list, plan };
};

// ── The five portfolios ─────────────────────────────────────────────────────

const portfolios: {
	id: string;
	name: string;
	benchmark: string;
	policy: string;
	trades: TTrade[];
}[] = [];

{
	const list = await pricedOn("2024-10-01");
	const used = new Set<string>();
	const trades: TTrade[] = [];
	for (let y = 1; y <= 10; y++)
		trades.push(
			await buy(pick(list, ["note"], y, used).cusip, list.date, 500_000),
		);
	portfolios.push({
		id: "demo-ladder",
		name: "Core ladder, 1 to 10 years",
		benchmark: "0307",
		policy: "cash",
		trades,
	});
}
{
	const { list, plan } = await matched("2025-10-01");
	portfolios.push({
		id: "demo-pension",
		name: "Pension payouts, cash-flow matched",
		benchmark: "AGG",
		policy: "cash",
		trades: plan.positions.map((p) => ({
			cusip: p.cusip,
			side: "buy" as const,
			date: list.date,
			face: p.faceAmount,
			price: p.security.price,
		})),
	});
}
{
	const list = await pricedOn("2025-04-01");
	const used = new Set<string>();
	const trades: TTrade[] = [];
	for (const y of [3, 5, 10, 20])
		trades.push(
			await buy(pick(list, ["tips"], y, used).cusip, list.date, 750_000),
		);
	for (const y of [1, 2])
		trades.push(
			await buy(pick(list, ["frn"], y, used).cusip, list.date, 1_000_000),
		);
	portfolios.push({
		id: "demo-inflation",
		name: "Inflation protection: TIPS and floaters",
		benchmark: "TIPS",
		policy: "cash",
		trades,
	});
}
{
	const list = await pricedOn("2021-06-01");
	const used = new Set<string>();
	const thirty = pick(list, ["bond"], 30, used).cusip;
	const twenty = pick(list, ["bond"], 20, used).cusip;
	portfolios.push({
		id: "demo-long",
		name: "Long duration, through the 2022 sell-off",
		benchmark: "20PL",
		policy: "reinvest",
		trades: [
			await buy(thirty, list.date, 1_000_000),
			await buy(twenty, list.date, 1_000_000),
			await sell(thirty, "2023-10-02", 500_000),
			await buy(thirty, "2024-06-03", 500_000),
		],
	});
}
{
	const trades: TTrade[] = [];
	for (let k = 0; k < 12; k++) {
		const list = await pricedOn(addMonths("2025-10-01", k));
		if (list.date > "2026-09-30") break;
		trades.push(await buy(pick(list, ["bill"], 0.25).cusip, list.date, 500_000));
	}
	portfolios.push({
		id: "demo-bills",
		name: "Cash management: a bill roll",
		benchmark: "BILL",
		policy: "cash",
		trades,
	});
}

// ── The saved plan: the same match, on today's prices ───────────────────────

const today = await matched("2026-09-28");

// ── SQL ─────────────────────────────────────────────────────────────────────

const q = (v: string | number | null) =>
	v === null
		? "null"
		: typeof v === "number"
			? String(v)
			: `'${v.replaceAll("'", "''")}'`;
const CREATED = Date.parse("2026-10-01T00:00:00Z");
const lines: string[] = [
	`-- The shared, read-only demo (${new Date().toISOString().slice(0, 10)}), written by scripts/demo-seed.ts.`,
	"-- A signed-in account without a paid plan reads organization 'demo' instead of its own",
	"-- (apps/web lib/session.server.ts requireDashboard) and can write nothing. Trades are at",
	"-- each day's FedInvest close. To refresh the demo, re-run the script into a NEW migration.",
	"",
	`insert or ignore into organizations (idOrganization, nameOrganization, slug, createdAt, updatedAt) values (${q(DEMO_ORGANIZATION_ID)}, 'Safe Rate Demo', 'safe-rate-demo', ${CREATED}, ${CREATED});`,
	"",
];
let n = 0;
for (const p of portfolios) {
	lines.push(
		`insert or ignore into portfolios (idPortfolio, idOrganization, namePortfolio, codeBenchmark, policyIncome, createdAt, updatedAt) values (${q(p.id)}, ${q(DEMO_ORGANIZATION_ID)}, ${q(p.name)}, ${q(p.benchmark)}, ${q(p.policy)}, ${CREATED}, ${CREATED});`,
	);
	for (const t of p.trades)
		lines.push(
			`insert or ignore into portfolioTransactions (idTransaction, idPortfolio, cusip, side, tradeDate, settleDate, faceAmount, cleanPrice, account, sourceTransaction, idImport, idUserCreatedBy, createdAt) values (${q(`demo-tx-${String(++n).padStart(3, "0")}`)}, ${q(p.id)}, ${q(t.cusip)}, ${q(t.side)}, ${q(t.date)}, ${q(settlementFor(t.date))}, ${t.face}, ${t.price}, null, 'manual', null, 'demo', ${CREATED + n});`,
		);
	lines.push("");
}
lines.push(
	`insert or ignore into liabilityStreams (idLiabilityStream, idOrganization, nameLiabilityStream, createdAt, updatedAt) values ('demo-stream', ${q(DEMO_ORGANIZATION_ID)}, 'Pension payouts, 2027 to 2036', ${CREATED}, ${CREATED});`,
);
for (const [i, l] of PAYOUTS.entries())
	lines.push(
		`insert or ignore into liabilityCashflows (idLiabilityCashflow, idLiabilityStream, dueDate, amount, label) values ('demo-cf-${String(i + 1).padStart(2, "0")}', 'demo-stream', ${q(l.date)}, ${l.amount}, ${q(l.label)});`,
	);
const positions = today.plan.positions.map((p) => ({
	cusip: p.cusip,
	faceAmount: p.faceAmount,
	planPrice: p.security.planPrice,
	dirtyPrice: p.security.dirtyPrice,
	cost: p.cost,
	family: p.security.family,
	couponPercent: p.security.couponPercent,
	maturityDate: p.security.maturityDate,
	close: p.security.price,
}));
lines.push(
	"",
	`insert or ignore into builderPlans (idPlan, idOrganization, namePlan, method, idLiabilityStream, asOf, settleDate, inputsJson, positionsJson, cost, idUserCreatedBy, createdAt) values ('demo-plan', ${q(DEMO_ORGANIZATION_ID)}, 'Pension payouts, matched on ${today.list.date}', 'match', 'demo-stream', ${q(today.list.date)}, ${q(settlementFor(today.list.date))}, ${q(JSON.stringify({ mode: "match", stream: "demo-stream", lots: "retail" }))}, ${q(JSON.stringify(positions))}, ${today.plan.cost}, 'demo', ${CREATED});`,
);

const out = resolve(
	import.meta.dir,
	`../packages/persistence/migrations/${NAME}.sql`,
);
writeFileSync(out, `${lines.join("\n")}\n`);
console.info(
	`wrote ${out}: ${portfolios.length} portfolios, ${n} trades, ${PAYOUTS.length} liabilities, a plan of ${positions.length} positions`,
);
for (const p of portfolios)
	console.info(`  ${p.name}: ${p.trades.length} trades`);
