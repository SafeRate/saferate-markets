import { getOrganizationSubscription, isEntitled } from "@markets/persistence";
import {
	BETA_PLANS,
	CHECKOUT_PLANS,
	checkoutPlanById,
	PRODUCT_NAME,
} from "@markets/schema";
import { Form, redirect, useNavigation } from "react-router";
import { requireOrganization } from "@/lib/session.server";
import { getAuth } from "@/services/auth.server";
import { cancelNow, switchPathFor } from "@/services/billing.server";
import type { Route } from "./+types/dashboard.billing";

export const meta: Route.MetaFunction = () => [
	{ title: `Billing — ${PRODUCT_NAME}` },
];

/**
 * Server-side forms, not the Better Auth client, as OKLocate's billing page:
 * the action calls the plugin's endpoints through auth.api with the session's
 * headers, and redirects to the URL Stripe returns.
 *
 * What is shown is organizationSubscriptions, our entitlement record, and NOT
 * the plugin's `subscription` mirror: the page must say what the API will do.
 */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const org = await requireOrganization(request, env);
	const subscription = await getOrganizationSubscription({
		db: env.DB,
		idOrganization: org.idOrganization,
	});
	const entitled = isEntitled(subscription);
	const current = entitled ? checkoutPlanById(subscription?.idPlan) : undefined;
	const url = new URL(request.url);
	return {
		organizationName: org.nameOrganization,
		plans: CHECKOUT_PLANS.map((p) => ({
			id: p.id,
			name: p.name,
			summary: p.summary,
			priceUsdMonthly: p.sale.priceUsdMonthly,
			permits: p.permits,
		})),
		betaPlans: BETA_PLANS as readonly string[],
		subscription: entitled ? subscription : null,
		currentPlan: current ? { id: current.id, name: current.name } : null,
		// Only asked when it matters: an Individual subscriber who could move up.
		switchPath:
			current?.id === "public"
				? await switchPathFor({
						env,
						idStripeSubscription: subscription?.idStripeSubscription ?? null,
					})
				: null,
		checkout: url.searchParams.get("checkout"),
		switched: url.searchParams.get("switched"),
	};
};

export const action = async ({ request, context }: Route.ActionArgs) => {
	const env = context.cloudflare.env;
	const org = await requireOrganization(request, env);
	const form = await request.formData();
	const intent = String(form.get("intent") ?? "");
	const auth = getAuth({ env, request });
	const current = await getOrganizationSubscription({
		db: env.DB,
		idOrganization: org.idOrganization,
	});

	try {
		if (intent === "subscribe") {
			// Re-derived from the catalogue, never trusted from the form: an edited
			// value must not name a plan that does not exist.
			const plan = checkoutPlanById(String(form.get("plan") ?? ""));
			if (!plan) {
				return {
					status: "error" as const,
					message: "That plan cannot be bought here.",
				};
			}
			if (isEntitled(current)) {
				return { status: "error" as const, message: "You already have a plan." };
			}
			const result = await auth.api.upgradeSubscription({
				body: {
					plan: plan.id,
					referenceId: org.idOrganization,
					successUrl: "/dashboard/billing?checkout=done",
					cancelUrl: "/dashboard/billing?checkout=cancelled",
					disableRedirect: true,
				},
				headers: request.headers,
			});
			const url = (result as { url?: string } | null)?.url;
			if (!url) {
				return {
					status: "error" as const,
					message: "Stripe did not return a checkout page. Try again.",
				};
			}
			return redirect(url);
		}

		if (intent === "switch-to-team") {
			if (!isEntitled(current) || current?.idPlan !== "public") {
				return {
					status: "error" as const,
					message: "Only an Individual plan can switch to Team here.",
				};
			}
			// Decided again at submit, not only when the page rendered: a card or a
			// discount can change in between, and the in-place path invoices at once.
			const path = await switchPathFor({
				env,
				idStripeSubscription: current.idStripeSubscription,
			});
			if (path === "beta-checkout" && current.idStripeSubscription) {
				// End Individual now and open a Team checkout, where the beta code is
				// entered again. In place would bill $100 prorated to a subscription
				// that, by design, has no card. Between the two there is a gap in
				// access of about one checkout; acceptable for a beta, and said on
				// the page before the click.
				await cancelNow({
					env,
					idStripeSubscription: current.idStripeSubscription,
				});
				const result = await auth.api.upgradeSubscription({
					body: {
						plan: "team",
						referenceId: org.idOrganization,
						successUrl: "/dashboard/billing?checkout=done",
						cancelUrl: "/dashboard/billing?checkout=cancelled",
						disableRedirect: true,
					},
					headers: request.headers,
				});
				const url = (result as { url?: string } | null)?.url;
				if (!url) {
					return {
						status: "error" as const,
						message:
							"Your Individual plan ended but Stripe did not return a Team checkout. Choose Team below to finish.",
					};
				}
				return redirect(url);
			}
			if (path !== "in-place") {
				return {
					status: "error" as const,
					message:
						"Add a payment method first (Manage billing), then switch. Team is billed at $100 a month.",
				};
			}
			// In place, on the existing subscription, prorated by Stripe. The
			// plugin updates its row; the webhook updates ours, which is what moves
			// the rate limit.
			const result = await auth.api.upgradeSubscription({
				body: {
					plan: "team",
					referenceId: org.idOrganization,
					successUrl: "/dashboard/billing?switched=team",
					cancelUrl: "/dashboard/billing",
					returnUrl: "/dashboard/billing?switched=team",
					disableRedirect: true,
				},
				headers: request.headers,
			});
			const url = (result as { url?: string } | null)?.url;
			return redirect(url ?? "/dashboard/billing?switched=team");
		}

		if (intent === "portal") {
			const result = await auth.api.createBillingPortal({
				body: {
					referenceId: org.idOrganization,
					returnUrl: "/dashboard/billing",
					disableRedirect: true,
				},
				headers: request.headers,
			});
			const url = (result as { url?: string } | null)?.url;
			if (!url) {
				return {
					status: "error" as const,
					message: "Stripe did not return a billing portal.",
				};
			}
			return redirect(url);
		}
	} catch (error) {
		// Logged in full; the customer gets one sentence, because the error can
		// carry Stripe internals.
		console.error(`[billing] ${intent} failed:`, error);
		return {
			status: "error" as const,
			message:
				"We could not reach Stripe just now. Nothing was charged. Try again in a moment.",
		};
	}
	return { status: "error" as const, message: "Unknown action." };
};

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const button =
	"rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-60";
const quiet =
	"rounded-full border border-slate-200 px-5 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-60";

export default function Billing({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const d = loaderData;
	const isBusy = useNavigation().state === "submitting";

	return (
		<main className="mx-auto max-w-3xl px-6 py-16">
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				{d.organizationName}
			</p>
			<h1 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900">
				Billing
			</h1>

			{d.checkout === "done" && !d.currentPlan ? (
				// Stripe redirects before its webhook necessarily lands. Say so,
				// rather than showing "no plan" to someone who just paid.
				<p className="mt-6 rounded-lg border border-slate-200 p-3 text-sm">
					Checkout finished. Your plan appears here as soon as Stripe confirms it,
					usually within a few seconds. Refresh to check.
				</p>
			) : null}
			{d.switched === "team" && d.currentPlan?.id !== "team" ? (
				<p className="mt-6 rounded-lg border border-slate-200 p-3 text-sm">
					Switching to Team. It shows here once Stripe confirms, usually within a few
					seconds. Refresh to check.
				</p>
			) : null}
			{d.checkout === "cancelled" ? (
				<p className="mt-6 text-sm text-slate-500">
					Checkout was cancelled. Nothing was charged.
				</p>
			) : null}
			{actionData?.status === "error" ? (
				<p className="mt-6 text-sm text-slate-600">{actionData.message}</p>
			) : null}

			{d.currentPlan && d.subscription ? (
				<section className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
					<h2 className="font-semibold text-neutral-900">
						{d.currentPlan.name}, active
					</h2>
					<p className="mt-2 text-sm text-slate-600">
						Since {fmtDate(d.subscription.startedAt)}
						{d.subscription.statusSubscription === "past_due"
							? ". Your last payment failed; Stripe is retrying it."
							: "."}
					</p>
					{d.subscription.cancelsAt ? (
						<p className="mt-1 text-sm text-slate-500">
							Cancels on {fmtDate(d.subscription.cancelsAt)}. Your keys work until
							then.
						</p>
					) : null}
					<div className="mt-5 flex flex-wrap gap-3">
						<Form method="post">
							<input name="intent" type="hidden" value="portal" />
							<button className={quiet} disabled={isBusy} type="submit">
								Manage billing
							</button>
						</Form>
						{d.currentPlan.id === "public" &&
						(d.switchPath === "in-place" || d.switchPath === "beta-checkout") ? (
							<Form method="post">
								<input name="intent" type="hidden" value="switch-to-team" />
								<button className={button} disabled={isBusy} type="submit">
									Switch to Team
								</button>
							</Form>
						) : null}
					</div>
					{d.currentPlan.id === "public" && d.switchPath === "in-place" ? (
						<p className="mt-3 text-xs text-slate-500">
							Team is $100 a month, prorated from today on your card.
						</p>
					) : null}
					{d.currentPlan.id === "public" && d.switchPath === "beta-checkout" ? (
						<p className="mt-3 text-xs text-slate-500">
							Beta: switching ends your Individual plan and opens a Team checkout.
							Enter your beta code there again. Your keys stay the same and work again
							as soon as the checkout completes.
						</p>
					) : null}
					{d.currentPlan.id === "public" && d.switchPath === "needs-card" ? (
						<p className="mt-3 text-xs text-slate-500">
							To switch to Team, first add a payment method in Manage billing. Team is
							$100 a month, prorated from today.
						</p>
					) : null}
					{d.currentPlan.id === "public" && d.switchPath === null ? (
						<p className="mt-3 text-xs text-slate-500">
							Switching to Team is unavailable just now. Try again shortly.
						</p>
					) : null}
					<p className="mt-3 text-xs text-slate-500">
						Invoices, payment method and cancellation are in Stripe's billing portal.
					</p>
				</section>
			) : (
				<section className="mt-8 grid gap-4 sm:grid-cols-2">
					{d.plans.map((plan) => (
						<div
							className="flex flex-col rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
							key={plan.id}
						>
							<h2 className="font-semibold text-neutral-900">{plan.name}</h2>
							<p className="mt-1 text-2xl font-semibold text-neutral-900">
								${plan.priceUsdMonthly}
								<span className="text-sm font-normal text-slate-500">/month</span>
							</p>
							<p className="mt-2 text-sm text-slate-600">{plan.summary}</p>
							<ul className="mt-3 flex-1 list-disc space-y-1 pl-5 text-sm text-slate-600 marker:text-primary">
								{plan.permits.map((line) => (
									<li key={line}>{line}</li>
								))}
							</ul>
							<Form className="mt-5" method="post">
								<input name="intent" type="hidden" value="subscribe" />
								<input name="plan" type="hidden" value={plan.id} />
								<button className={button} disabled={isBusy} type="submit">
									Choose {plan.name}
								</button>
							</Form>
							{d.betaPlans.includes(plan.id) ? (
								<p className="mt-3 text-xs text-slate-500">
									Beta tester? Enter your code on the checkout page.
								</p>
							) : null}
						</div>
					))}
				</section>
			)}

			<p className="mt-8 text-sm text-slate-600">
				Firm-wide use, redistribution or a benchmark licence:{" "}
				<a className="text-primary underline underline-offset-4" href="/pricing">
					see Enterprise
				</a>
				.
			</p>
		</main>
	);
}
