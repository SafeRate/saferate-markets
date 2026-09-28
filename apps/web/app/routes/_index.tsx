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
 * Plan copy is READ from @markets/schema, never typed here: a price in prose is
 * a price that goes stale the first time it changes. Prices are not shown until
 * checkout exists, so the page cannot offer what cannot yet be bought.
 */
export default function Home() {
	return (
		<main className="mx-auto max-w-5xl px-6 py-20">
			<h1 className="max-w-2xl text-4xl font-semibold tracking-tight">
				U.S. Treasury market data, for your systems and your AI agents.
			</h1>
			<p className="mt-5 max-w-2xl text-lg text-muted-foreground">
				Fitted zero, par, money-market and TIPS curves, per-security analytics and
				Safe Rate's total-return indices, daily from 2008. One key, over a REST API
				and an MCP server.
			</p>
			<div className="mt-8 flex gap-3">
				<a
					className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
					href="/sign-in"
				>
					Get an API key
				</a>
				<a
					className="rounded-lg border border-border px-4 py-2 text-sm font-semibold"
					href="/docs"
				>
					Read the docs
				</a>
			</div>

			<section className="mt-20 grid gap-6 md:grid-cols-3">
				{PLANS.map((plan) => (
					<div className="rounded-lg border border-border p-5" key={plan.id}>
						<h2 className="font-semibold">{plan.name}</h2>
						<p className="mt-1 text-sm text-muted-foreground">{plan.summary}</p>
						<ul className="mt-4 list-disc space-y-1 pl-5 text-sm">
							{plan.permits.map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
					</div>
				))}
			</section>
		</main>
	);
}
