import { getOrganizationSubscription, isEntitled } from "@markets/persistence";
import { CHECKOUT_PLAN, PRODUCT_NAME } from "@markets/schema";
import { Form, redirect, useNavigation } from "react-router";
import { requireOrganization } from "@/lib/session.server";
import { getAuth } from "@/services/auth.server";
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
	const checkout = new URL(request.url).searchParams.get("checkout");
	return {
		organizationName: org.nameOrganization,
		plan: {
			name: CHECKOUT_PLAN.name,
			priceUsdMonthly: CHECKOUT_PLAN.sale.priceUsdMonthly,
		},
		subscription,
		isEntitled: isEntitled(subscription),
		checkout,
	};
};

export const action = async ({ request, context }: Route.ActionArgs) => {
	const env = context.cloudflare.env;
	const org = await requireOrganization(request, env);
	const intent = String((await request.formData()).get("intent") ?? "");
	const auth = getAuth({ env, request });

	try {
		if (intent === "subscribe") {
			// Already live: send them to manage it rather than open a second
			// checkout. The unique index would refuse a second row anyway.
			const current = await getOrganizationSubscription({
				db: env.DB,
				idOrganization: org.idOrganization,
			});
			if (isEntitled(current)) {
				return { status: "error" as const, message: "You already have a plan." };
			}
			const result = await auth.api.upgradeSubscription({
				body: {
					plan: CHECKOUT_PLAN.id,
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

export default function Billing({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const d = loaderData;
	const isBusy = useNavigation().state === "submitting";
	const button =
		"rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-60";

	return (
		<main className="mx-auto max-w-2xl px-6 py-16">
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				{d.organizationName}
			</p>
			<h1 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900">
				Billing
			</h1>

			{d.checkout === "done" && !d.isEntitled ? (
				// Stripe redirects before its webhook necessarily lands. Say so,
				// rather than showing "no plan" to someone who just paid.
				<p className="mt-6 rounded-lg border border-border p-3 text-sm">
					Checkout finished. Your plan appears here as soon as Stripe confirms it,
					usually within a few seconds. Refresh to check.
				</p>
			) : null}
			{d.checkout === "cancelled" ? (
				<p className="mt-6 text-sm text-muted-foreground">
					Checkout was cancelled. Nothing was charged.
				</p>
			) : null}
			{actionData?.status === "error" ? (
				<p className="mt-6 text-sm text-muted-foreground">{actionData.message}</p>
			) : null}

			<section className="mt-8 rounded-lg border border-border p-5">
				<h2 className="font-semibold">
					{d.plan.name}, ${d.plan.priceUsdMonthly}/month
				</h2>
				{d.isEntitled && d.subscription ? (
					<>
						<p className="mt-2 text-sm">
							Active since {fmtDate(d.subscription.startedAt)}
							{d.subscription.statusSubscription === "past_due"
								? ". Your last payment failed; Stripe is retrying it."
								: "."}
						</p>
						{d.subscription.cancelsAt ? (
							<p className="mt-1 text-sm text-muted-foreground">
								Cancels on {fmtDate(d.subscription.cancelsAt)}. Your keys work until
								then.
							</p>
						) : null}
						<Form className="mt-5" method="post">
							<input name="intent" type="hidden" value="portal" />
							<button className={button} disabled={isBusy} type="submit">
								Manage billing
							</button>
						</Form>
						<p className="mt-3 text-xs text-muted-foreground">
							Invoices, payment method and cancellation are in Stripe's billing portal.
						</p>
					</>
				) : (
					<>
						<p className="mt-2 text-sm text-muted-foreground">
							No plan yet. Your API keys need one to work.
						</p>
						<Form className="mt-5" method="post">
							<input name="intent" type="hidden" value="subscribe" />
							<button className={button} disabled={isBusy} type="submit">
								Subscribe
							</button>
						</Form>
						<p className="mt-3 text-xs text-muted-foreground">
							Have a code? Enter it on the checkout page.
						</p>
					</>
				)}
			</section>
		</main>
	);
}
