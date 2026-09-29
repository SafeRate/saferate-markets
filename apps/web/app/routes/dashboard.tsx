import {
	countActiveApiKeys,
	currentPeriodMonth,
	getMonthlyUsage,
	getOrganizationSubscription,
	isEntitled,
} from "@markets/persistence";
import { checkoutPlanById, PRODUCT_NAME } from "@markets/schema";
import { requireOrganization } from "@/lib/session.server";
import type { Route } from "./+types/dashboard";

export const meta: Route.MetaFunction = () => [
	{ title: `Dashboard — ${PRODUCT_NAME}` },
];

/**
 * THE HONESTY RULE (OKLocate's): every number here is either real or explicitly
 * absent. Usage IS measured from the first request, so a zero this month is a
 * real zero and is shown as one. The plan is read from organizationSubscriptions,
 * the same record the API's entitlement check reads, so the two cannot disagree.
 */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const org = await requireOrganization(request, env);
	const period = currentPeriodMonth();
	const usage = await getMonthlyUsage({
		db: env.DB,
		idOrganization: org.idOrganization,
		limitMonths: 1,
	});
	const thisMonth = usage.filter((u) => u.periodMonth === period);
	const count = (surface: "rest" | "mcp") =>
		thisMonth.find((u) => u.surface === surface)?.countRequests ?? 0;

	const subscription = await getOrganizationSubscription({
		db: env.DB,
		idOrganization: org.idOrganization,
	});
	return {
		hasPlan: isEntitled(subscription),
		planName: isEntitled(subscription)
			? (checkoutPlanById(subscription?.idPlan)?.name ?? "Unknown plan")
			: null,
		email: org.email,
		organizationName: org.nameOrganization,
		activeKeys: await countActiveApiKeys({
			db: env.DB,
			idOrganization: org.idOrganization,
		}),
		period,
		restRequests: count("rest"),
		mcpRequests: count("mcp"),
	};
};

const Stat = ({ label, value }: { label: string; value: string }) => (
	<div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
		<p className="text-xs uppercase tracking-wide text-muted-foreground">
			{label}
		</p>
		<p className="tabular mt-2 text-2xl font-semibold text-neutral-900">
			{value}
		</p>
	</div>
);

export default function Dashboard({ loaderData }: Route.ComponentProps) {
	const d = loaderData;
	return (
		<main className="max-w-3xl">
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				{d.organizationName}
			</p>
			<h1 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900">
				Dashboard
			</h1>
			<p className="mt-2 text-sm text-muted-foreground">Signed in as {d.email}.</p>

			<section className="mt-10 grid gap-4 sm:grid-cols-3">
				<Stat label="Active keys" value={d.activeKeys.toLocaleString("en-US")} />
				<Stat
					label={`REST requests, ${d.period}`}
					value={d.restRequests.toLocaleString("en-US")}
				/>
				<Stat
					label={`MCP requests, ${d.period}`}
					value={d.mcpRequests.toLocaleString("en-US")}
				/>
			</section>

			<section className="mt-6 rounded-lg border border-border p-4">
				<p className="text-xs uppercase tracking-wide text-muted-foreground">
					Plan
				</p>
				<p className="mt-2 text-sm">
					{d.hasPlan ? (
						`${d.planName}, active.`
					) : (
						<>
							No plan yet, so your keys will be refused.{" "}
							<a
								className="text-primary underline underline-offset-4"
								href="/dashboard/billing"
							>
								Subscribe
							</a>
						</>
					)}
				</p>
			</section>

			<nav className="mt-10 flex gap-6 text-sm">
				<a
					className="text-primary underline underline-offset-4"
					href="/dashboard/keys"
				>
					Manage API keys
				</a>
				<a
					className="text-primary underline underline-offset-4"
					href="/dashboard/billing"
				>
					Billing
				</a>
				<a className="text-primary underline underline-offset-4" href="/docs">
					Read the docs
				</a>
				<form action="/sign-out" method="post">
					<button
						className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
						type="submit"
					>
						Sign out
					</button>
				</form>
			</nav>
		</main>
	);
}
