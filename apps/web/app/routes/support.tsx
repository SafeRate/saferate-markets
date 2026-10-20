import { PRODUCT_NAME } from "@markets/schema";
import { data, Form, redirect, useNavigation } from "react-router";
import { getAuth, getServerSession } from "@/services/auth.server";
import { listSupportAccounts } from "@/services/support.server";
import type { Route } from "./+types/support";

export const meta: Route.MetaFunction = () => [
	{ title: `Support | ${PRODUCT_NAME}` },
	{ name: "robots", content: "noindex, nofollow" },
];

/**
 * Support (Dylan, 2026-10-20): every account, newest first, with what it
 * receives and pays for, and a button that signs an admin in as it, to see
 * exactly what the customer sees. Admin only (user.role 'admin', migration
 * 0009). Anyone else gets a 404, so the page does not announce itself.
 *
 * Impersonation is Better Auth's admin plugin (services/auth.server.ts): an
 * hour at most, never another admin, and billing and API keys refuse while it
 * lasts (refuseWhileImpersonating). The dashboard shows a banner with the way
 * back.
 */
const isAdmin = (session: Awaited<ReturnType<typeof getServerSession>>) =>
	(session?.user as { role?: string | null } | undefined)?.role === "admin";

export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const session = await getServerSession({ env, request });
	if (!session?.user) throw redirect("/sign-in?next=/support");
	if (!isAdmin(session)) throw data("Not found", { status: 404 });
	const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
	return {
		q,
		accounts: await listSupportAccounts({ db: env.DB, search: q }),
	};
};

/** Response headers carrying only the Set-Cookie lines of `from`. */
const cookiesOf = (from: Headers) => {
	const headers = new Headers();
	for (const cookie of from.getSetCookie()) headers.append("Set-Cookie", cookie);
	return headers;
};

export const action = async ({ request, context }: Route.ActionArgs) => {
	const env = context.cloudflare.env;
	const session = await getServerSession({ env, request });
	if (!session?.user) throw redirect("/sign-in?next=/support");
	const form = await request.formData();
	const intent = String(form.get("intent") ?? "");
	const auth = getAuth({ env, request });

	// The impersonated session is the customer's, not an admin's, so stopping
	// is checked against the session, not the role.
	if (intent === "stop-impersonating") {
		if (!(session.session as { impersonatedBy?: string | null }).impersonatedBy)
			throw redirect("/dashboard");
		const { headers } = await auth.api.stopImpersonating({
			headers: request.headers,
			returnHeaders: true,
		});
		throw redirect("/support", { headers: cookiesOf(headers) });
	}

	if (!isAdmin(session)) throw data("Not found", { status: 404 });
	if (intent === "impersonate") {
		const userId = String(form.get("userId") ?? "");
		if (!userId) throw data("No account given.", { status: 400 });
		// The plugin checks the role again and refuses an admin target.
		const { headers } = await auth.api.impersonateUser({
			body: { userId },
			headers: request.headers,
			returnHeaders: true,
		});
		console.info(`[support] ${session.user.email} is impersonating ${userId}`);
		throw redirect("/dashboard", { headers: cookiesOf(headers) });
	}
	throw data("Unknown action.", { status: 400 });
};

const yes = (v: boolean) => (v ? "Yes" : "—");

export default function Support({ loaderData }: Route.ComponentProps) {
	const { q, accounts } = loaderData;
	const busy = useNavigation().state !== "idle";
	const external = accounts.filter((a) => !a.isInternal).length;
	return (
		<main className="mx-auto max-w-7xl px-4 py-10 md:px-6">
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				Admin
			</p>
			<h1 className="mt-2 text-3xl font-semibold tracking-tight text-neutral-900">
				Support
			</h1>
			<p className="mt-2 max-w-3xl text-sm text-slate-600">
				Every account, newest first. Impersonate signs you in as the account for up
				to an hour, to see what they see. Billing and API keys are locked while you
				do. A banner on the dashboard takes you back.
			</p>
			<Form className="mt-6 flex max-w-md gap-2" method="get">
				<input
					className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
					defaultValue={q}
					name="q"
					placeholder="Search by email"
					type="search"
				/>
				<button
					className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white"
					type="submit"
				>
					Search
				</button>
			</Form>
			<p className="mt-4 text-sm text-slate-500">
				{accounts.length} {accounts.length === 1 ? "account" : "accounts"}
				{q ? ` matching "${q}"` : ""}, {external} outside Safe Rate.
			</p>
			<div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
				<table className="w-full min-w-[56rem] text-sm">
					<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
						<tr>
							<th className="px-3 py-2">Account</th>
							<th className="px-3 py-2">Signed up</th>
							<th className="px-3 py-2">Last sign-in</th>
							<th className="px-3 py-2">Plan</th>
							<th className="px-3 py-2">Rundown</th>
							<th className="px-3 py-2">Auction alerts</th>
							<th className="px-3 py-2" />
						</tr>
					</thead>
					<tbody>
						{accounts.map((a) => (
							<tr className="border-t border-slate-100" key={a.idUser}>
								<td className="px-3 py-2">
									<div className="font-medium text-slate-900">{a.email}</div>
									<div className="text-xs text-slate-500">
										{[
											a.isInternal ? "Safe Rate" : null,
											a.isAdmin ? "admin" : null,
											a.isVerified ? null : "unverified",
										]
											.filter(Boolean)
											.join(", ")}
									</div>
								</td>
								<td className="px-3 py-2 text-slate-600">{a.createdOn ?? "—"}</td>
								<td className="px-3 py-2 text-slate-600">{a.lastSignInOn ?? "—"}</td>
								<td className="px-3 py-2 text-slate-600">{a.plan}</td>
								<td className="px-3 py-2 text-slate-600">
									{a.isPaused ? "Paused" : yes(a.rundown)}
								</td>
								<td className="px-3 py-2 text-slate-600">
									{a.isPaused
										? "Paused"
										: [
												a.auctionResults ? "results" : null,
												a.auctionAnnouncements ? "announcements" : null,
											]
												.filter(Boolean)
												.join(", ") || "—"}
								</td>
								<td className="px-3 py-2 text-right">
									{a.isAdmin ? (
										<span className="text-xs text-slate-400">Admin</span>
									) : (
										<Form method="post">
											<input name="intent" type="hidden" value="impersonate" />
											<input name="userId" type="hidden" value={a.idUser} />
											<button
												className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
												disabled={busy}
												type="submit"
											>
												Impersonate
											</button>
										</Form>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</main>
	);
}
