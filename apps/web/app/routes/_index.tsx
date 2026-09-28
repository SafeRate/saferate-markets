import { PLANS, PRODUCT_NAME } from "@markets/schema";
import type { Route } from "./+types/_index";

export const meta: Route.MetaFunction = () => [
	{ title: `${PRODUCT_NAME} — U.S. Treasury data by API and MCP` },
	{
		name: "description",
		content:
			"Fitted Treasury curves, security analytics and total-return indices from Safe Rate, over a REST API and an MCP server.",
	},
];

/**
 * Plan copy and prices are READ from @markets/schema, never typed here: a price
 * in prose is a price that goes stale the first time it changes.
 */
export default function Home() {
	return (
		<main className="mx-auto max-w-5xl px-6 py-20">
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				Treasury data for institutions
			</p>
			<h1 className="mt-4 max-w-2xl text-4xl font-semibold leading-[1.05] tracking-tight text-neutral-900 md:text-5xl">
				U.S. Treasury market data, for your systems and your AI agents.
			</h1>
			<p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-600">
				Fitted zero, par, money-market and TIPS curves, per-security analytics and
				Safe Rate's total-return indices, daily from 2008. One key, over a REST API
				and an MCP server.
			</p>
			<div className="mt-8 flex gap-3">
				<a
					className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
					href="/sign-in"
				>
					Get an API key
				</a>
				<a
					className="rounded-full border border-slate-200 px-5 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-primary/40 hover:text-primary"
					href="/docs"
				>
					Read the docs
				</a>
			</div>

			<section className="mt-20 grid gap-6 md:grid-cols-3">
				{PLANS.map((plan) => (
					<div
						className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
						key={plan.id}
					>
						<h2 className="font-semibold text-neutral-900">{plan.name}</h2>
						<p className="mt-1 text-sm text-slate-600">{plan.summary}</p>
						<p className="mt-3 font-semibold text-neutral-900">
							{plan.sale.kind === "checkout"
								? `$${plan.sale.priceUsdMonthly}/month`
								: "Custom"}
						</p>
					</div>
				))}
			</section>
			<p className="mt-6 text-sm">
				<a className="text-primary underline underline-offset-4" href="/pricing">
					Compare plans
				</a>
			</p>
		</main>
	);
}
