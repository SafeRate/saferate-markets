import { CONTACT_ADDRESS, PLANS, PRODUCT_NAME } from "@markets/schema";
import type { Route } from "./+types/pricing";

export const meta: Route.MetaFunction = () => [
	{ title: `Pricing — ${PRODUCT_NAME}` },
];

/**
 * Every plan, prices and all, read from @markets/schema: a price typed into a
 * page is a price that goes stale. Nothing here claims what is not built: Team
 * says additional seats are coming, not "5 seats", and no plan claims a history
 * cap, because none exists yet.
 */
export default function Pricing() {
	return (
		<main className="mx-auto max-w-6xl px-6 py-16">
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				Pricing
			</p>
			<h1 className="mt-3 text-4xl font-semibold tracking-tight text-neutral-900">
				One key for the REST API and MCP.
			</h1>
			<p className="mt-4 max-w-2xl text-lg text-slate-600">
				Plans differ by who the data is for. Every plan includes the full daily
				history back to 2008.
			</p>

			<section className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
				{PLANS.map((plan) => (
					<div
						className="flex flex-col rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
						key={plan.id}
					>
						<h2 className="text-lg font-semibold text-neutral-900">{plan.name}</h2>
						<p className="mt-2 text-3xl font-semibold text-neutral-900">
							{plan.sale.kind === "checkout" ? (
								<>
									${plan.sale.priceUsdMonthly}
									<span className="text-base font-normal text-slate-500">/month</span>
								</>
							) : (
								"Custom"
							)}
						</p>
						<p className="mt-2 text-sm text-slate-600">{plan.summary}</p>
						<ul className="mt-4 flex-1 list-disc space-y-1.5 pl-5 text-sm text-slate-600 marker:text-primary">
							{plan.permits.map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
						{plan.sale.kind === "checkout" ? (
							<a
								className="mt-6 rounded-full bg-primary px-5 py-2 text-center text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
								href="/dashboard/billing"
							>
								Choose {plan.name}
							</a>
						) : (
							<div className="mt-6 text-sm">
								<p className="text-slate-600">Talk to us:</p>
								<p className="mt-1 font-semibold text-neutral-900">
									{CONTACT_ADDRESS}{" "}
									<a
										className="font-normal text-primary underline underline-offset-4"
										href={`mailto:${CONTACT_ADDRESS}?subject=${encodeURIComponent(`${PRODUCT_NAME} Enterprise`)}`}
									>
										email
									</a>
								</p>
							</div>
						)}
					</div>
				))}
			</section>

			<p className="mt-10 max-w-3xl text-sm leading-relaxed text-slate-500">
				<strong className="text-slate-700">Individual</strong> is for a person using
				the data on their own account. Using it for an employer or for clients, even
				when paying personally, is <strong className="text-slate-700">Team</strong>.
				Showing it to the public or to your customers, including through an app or
				agent they use, is <strong className="text-slate-700">Enterprise</strong>.
			</p>
		</main>
	);
}
