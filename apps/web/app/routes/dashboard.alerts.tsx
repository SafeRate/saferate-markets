import { isCashManagement, loadAuctionWindow } from "@markets/mcp-tools";
import {
	getAlertPreferences,
	putAlertPreferences,
	type TAlertPreferences,
} from "@markets/persistence";
import { PRODUCT_NAME } from "@markets/schema";
import { Form, Link, useNavigation } from "react-router";
import { requireOrganization } from "@/lib/session.server";
import { RUNDOWN_PATH } from "@/lib/rundownText";
import type { Route } from "./+types/dashboard.alerts";

export const meta: Route.MetaFunction = () => [
	{ title: `Email alerts | ${PRODUCT_NAME}` },
];

/**
 * The account's email alerts (migration 0008): the Treasury daily rundown,
 * on by default, and the optional auction results and announcements, with a
 * term filter. All free. Someone who confirms a sign-up from saferate.com
 * lands here, which is why the term filter lives here and not on that form.
 */
export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const { idUser, email } = await requireOrganization(request, env);
	const url = new URL(request.url);
	const [preferences, window] = await Promise.all([
		getAlertPreferences({ db: env.DB, idUser }),
		loadAuctionWindow(env).catch(() => null),
	]);
	return {
		email,
		preferences,
		// Every term auctioned in the last 400 days or announced, in the board's
		// order; cash management bills last. A term not listed today can still
		// be kept from an earlier save.
		terms: [
			...new Set([
				...(window?.terms ?? []).map((t) => t.key),
				...(preferences.terms ?? []),
			]),
		],
		confirmed: url.searchParams.get("confirmed") === "1",
	};
};

export const action = async ({ request, context }: Route.ActionArgs) => {
	const env = context.cloudflare.env;
	const { idUser } = await requireOrganization(request, env);
	const form = await request.formData();
	const on = (name: string) => form.get(name) === "on";
	const everyTerm = form.get("termScope") !== "some";
	const picked = form.getAll("terms").map(String).filter(Boolean);
	const preferences: TAlertPreferences = {
		rundown: on("rundown"),
		auctionResults: on("auctionResults"),
		auctionAnnouncements: on("auctionAnnouncements"),
		// Choosing "only these" with none ticked would silently mean nothing;
		// treat it as every term and say so.
		terms: everyTerm || picked.length === 0 ? null : picked,
		paused: on("paused"),
	};
	await putAlertPreferences({ db: env.DB, idUser, preferences });
	return {
		saved: true as const,
		note:
			!everyTerm && picked.length === 0
				? "No terms were ticked, so auction alerts cover every term."
				: null,
	};
};

const Toggle = ({
	name,
	label,
	hint,
	defaultChecked,
}: {
	name: string;
	label: string;
	hint: React.ReactNode;
	defaultChecked: boolean;
}) => (
	<label className="flex items-start gap-3 py-4">
		<input
			className="mt-1 h-4 w-4 accent-primary"
			defaultChecked={defaultChecked}
			name={name}
			type="checkbox"
		/>
		<span>
			<span className="font-medium text-neutral-900">{label}</span>
			<span className="mt-0.5 block text-sm text-slate-600">{hint}</span>
		</span>
	</label>
);

export default function Alerts({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const { email, preferences: p, terms, confirmed } = loaderData;
	const saving = useNavigation().state === "submitting";
	const scheduled = terms.filter((t) => !isCashManagement(t));
	const cmb = terms.filter(isCashManagement);
	return (
		<div className="max-w-3xl">
			<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
				Email alerts
			</h1>
			<p className="mt-2 text-sm text-slate-600">
				Sent to {email}. Free, and every email has a one-click unsubscribe.
			</p>
			{confirmed ? (
				<p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
					You're subscribed. Choose the terms you want auction alerts for below, or
					keep every term.
				</p>
			) : null}
			{actionData?.saved ? (
				<p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
					Saved.{actionData.note ? ` ${actionData.note}` : ""}
				</p>
			) : null}
			<Form className="mt-6" method="post">
				<div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white px-5">
					<Toggle
						defaultChecked={p.rundown}
						hint={
							<>
								Each business morning: the closing curve, the day's auction results with
								demand, and the auctions coming up.{" "}
								<Link
									className="text-primary underline underline-offset-4"
									to={RUNDOWN_PATH}
								>
									See the latest
								</Link>
								.
							</>
						}
						label="Treasury daily rundown"
						name="rundown"
					/>
					<Toggle
						defaultChecked={p.auctionResults}
						hint="When an auction's results reach Safe Rate: the clearing rate, bid-to-cover, bidder shares and the demand reading."
						label="Auction results"
						name="auctionResults"
					/>
					<Toggle
						defaultChecked={p.auctionAnnouncements}
						hint="When Treasury announces an auction: the security, its size and date."
						label="Auction announcements"
						name="auctionAnnouncements"
					/>
				</div>

				<fieldset className="mt-6 rounded-xl border border-slate-200 bg-white px-5 py-4">
					<legend className="px-1 text-sm font-medium text-neutral-900">
						Terms for auction alerts
					</legend>
					<label className="flex items-center gap-2 py-1 text-sm">
						<input
							className="accent-primary"
							defaultChecked={p.terms === null}
							name="termScope"
							type="radio"
							value="all"
						/>
						Every term
					</label>
					<label className="flex items-center gap-2 py-1 text-sm">
						<input
							className="accent-primary"
							defaultChecked={p.terms !== null}
							name="termScope"
							type="radio"
							value="some"
						/>
						Only these:
					</label>
					<div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 pl-6 sm:grid-cols-3">
						{[...scheduled, ...cmb].map((t) => (
							<label className="flex items-center gap-2 text-sm" key={t}>
								<input
									className="accent-primary"
									defaultChecked={p.terms?.includes(t) ?? false}
									name="terms"
									type="checkbox"
									value={t}
								/>
								{t}
							</label>
						))}
					</div>
				</fieldset>

				<div className="mt-6 rounded-xl border border-slate-200 bg-white px-5">
					<Toggle
						defaultChecked={p.paused}
						hint="Stops every email above without losing your choices."
						label="Pause all alerts"
						name="paused"
					/>
				</div>

				<button
					className="mt-6 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
					disabled={saving}
					type="submit"
				>
					{saving ? "Saving…" : "Save"}
				</button>
			</Form>
		</div>
	);
}
