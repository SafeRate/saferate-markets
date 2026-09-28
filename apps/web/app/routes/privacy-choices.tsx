import { PRODUCT_NAME, TRACKING_TOOLS } from "@markets/schema";
import { Form, redirect } from "react-router";
import { resolveTrackingTools } from "@/lib/analytics";
import {
	describeAnalyticsState,
	serializeAnalyticsChoice,
	ZAnalyticsChoice,
} from "@/lib/privacyChoices";
import type { Route } from "./+types/privacy-choices";

export const meta: Route.MetaFunction = () => [
	{ title: `Privacy choices — ${PRODUCT_NAME}` },
];

/**
 * The analytics opt-out. A plain form with a server action, so it works with
 * JavaScript off, and it reports what IS running for this visitor (from the same
 * resolveTrackingTools the loader uses), not what a policy says should be.
 * Ported in shape from saferate-oklocate; no legal text was copied.
 */
export const loader = ({ request, context }: Route.LoaderArgs) => {
	const configured = resolveTrackingTools(context.cloudflare.env);
	const state = describeAnalyticsState(request);
	const configuredIds = new Set(configured.map((r) => r.tool.id));
	return {
		state,
		tools: TRACKING_TOOLS.map((tool) => ({
			name: tool.name,
			vendor: tool.vendor,
			purpose: tool.purpose,
			isConfigured: configuredIds.has(tool.id),
		})),
	};
};

export const action = async ({ request }: Route.ActionArgs) => {
	const form = await request.formData();
	const choice = ZAnalyticsChoice.safeParse(form.get("choice"));
	if (!choice.success) return redirect("/privacy-choices");
	return redirect("/privacy-choices", {
		headers: {
			"Set-Cookie": serializeAnalyticsChoice({
				choice: choice.data,
				isSecure: new URL(request.url).protocol === "https:",
			}),
		},
	});
};

export default function PrivacyChoices({ loaderData }: Route.ComponentProps) {
	const { state, tools } = loaderData;
	const anyConfigured = tools.some((t) => t.isConfigured);
	return (
		<main className="mx-auto max-w-2xl px-6 py-16">
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				Privacy
			</p>
			<h1 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900">
				Privacy choices
			</h1>
			<p className="mt-4 text-slate-600">
				On public pages only (never the dashboard or sign-in), we use these to
				understand how the site is used:
			</p>
			<ul className="mt-4 space-y-3">
				{tools.map((tool) => (
					<li className="rounded-xl border border-slate-200 p-4" key={tool.name}>
						<p className="font-semibold text-neutral-900">
							{tool.name}{" "}
							<span className="font-normal text-slate-500">({tool.vendor})</span>
						</p>
						<p className="mt-1 text-sm text-slate-600">{tool.purpose}</p>
						<p className="mt-2 text-xs text-slate-500">
							{tool.isConfigured
								? "Configured on this site."
								: "Not configured here, so nothing is sent to it."}
						</p>
					</li>
				))}
			</ul>

			<section className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
				<p className="text-sm text-neutral-900">
					{!anyConfigured
						? "No analytics run on this site."
						: state.isGpc
							? "Your browser is sending Global Privacy Control, so analytics are off for you whatever you choose here."
							: state.isPermitted
								? "Analytics are on for you."
								: "Analytics are off for you."}
				</p>
				{anyConfigured && !state.isGpc ? (
					<Form className="mt-4" method="post">
						<input
							name="choice"
							type="hidden"
							value={state.isPermitted ? "off" : "on"}
						/>
						<button
							className="rounded-full border border-slate-200 px-5 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-primary/40 hover:text-primary"
							type="submit"
						>
							{state.isPermitted ? "Turn analytics off" : "Turn analytics on"}
						</button>
					</Form>
				) : null}
			</section>
		</main>
	);
}
