import {
	getAlertPreferences,
	putAlertPreferences,
	type TAlertPreferences,
} from "@markets/persistence";
import { PRODUCT_NAME } from "@markets/schema";
import { Form, Link } from "react-router";
import {
	type TUnsubscribeScope,
	verifyUnsubscribe,
} from "@/services/alerts.server";
import type { Route } from "./+types/alerts.unsubscribe";

/**
 * One-click unsubscribe, with no sign-in. The link is signed per user and per
 * kind of email (services/alerts.server.ts), so it cannot be forged or
 * pointed at someone else.
 *
 * A GET only shows a button, because mail scanners and link previews follow
 * GETs and would unsubscribe people who never clicked. The POST unsubscribes,
 * and is also what Gmail and Yahoo send for the List-Unsubscribe-Post header
 * (RFC 8058), with the same query string.
 */

export const meta: Route.MetaFunction = () => [
	{ title: `Unsubscribe | ${PRODUCT_NAME}` },
];

const SCOPES: Record<TUnsubscribeScope, string> = {
	rundown: "the Treasury daily rundown",
	auctionResult: "auction results",
	auctionAnnouncement: "auction announcements",
	all: "all Safe Rate Markets email alerts",
};

const parse = async (request: Request, env: Env) => {
	const url = new URL(request.url);
	const idUser = url.searchParams.get("u") ?? "";
	const scope = url.searchParams.get("s") ?? "";
	const signature = url.searchParams.get("t") ?? "";
	const secret = (env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET;
	if (!secret || !idUser || !(scope in SCOPES)) return null;
	const valid = await verifyUnsubscribe(
		secret,
		idUser,
		scope as TUnsubscribeScope,
		signature,
	);
	return valid ? { idUser, scope: scope as TUnsubscribeScope } : null;
};

export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const link = await parse(request, context.cloudflare.env);
	return link
		? { ok: true as const, what: SCOPES[link.scope], scope: link.scope }
		: { ok: false as const };
};

export const action = async ({ request, context }: Route.ActionArgs) => {
	const env = context.cloudflare.env;
	const link = await parse(request, env);
	if (!link)
		return new Response("This unsubscribe link is not valid.", { status: 400 });
	const current = await getAlertPreferences({ db: env.DB, idUser: link.idUser });
	const next: TAlertPreferences =
		link.scope === "all"
			? {
					...current,
					rundown: false,
					auctionResults: false,
					auctionAnnouncements: false,
				}
			: {
					...current,
					rundown: link.scope === "rundown" ? false : current.rundown,
					auctionResults:
						link.scope === "auctionResult" ? false : current.auctionResults,
					auctionAnnouncements:
						link.scope === "auctionAnnouncement"
							? false
							: current.auctionAnnouncements,
				};
	await putAlertPreferences({
		db: env.DB,
		idUser: link.idUser,
		preferences: next,
	});
	return { done: true as const, what: SCOPES[link.scope] };
};

export default function Unsubscribe({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	return (
		<main className="mx-auto max-w-xl px-6 py-20">
			{actionData?.done ? (
				<>
					<h1 className="text-2xl font-semibold text-neutral-900">Unsubscribed</h1>
					<p className="mt-3 text-slate-600">
						You will no longer receive {actionData.what}. You can turn any alert back
						on from{" "}
						<Link
							className="text-primary underline underline-offset-4"
							to="/dashboard/alerts"
						>
							email alerts
						</Link>
						.
					</p>
				</>
			) : loaderData.ok ? (
				<>
					<h1 className="text-2xl font-semibold text-neutral-900">Unsubscribe</h1>
					<p className="mt-3 text-slate-600">Stop receiving {loaderData.what}?</p>
					<Form className="mt-6 flex flex-wrap gap-3" method="post">
						<button
							className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground"
							type="submit"
						>
							Unsubscribe
						</button>
					</Form>
				</>
			) : (
				<>
					<h1 className="text-2xl font-semibold text-neutral-900">
						This link is not valid
					</h1>
					<p className="mt-3 text-slate-600">
						Manage your alerts from{" "}
						<Link
							className="text-primary underline underline-offset-4"
							to="/dashboard/alerts"
						>
							email alerts
						</Link>{" "}
						after signing in.
					</p>
				</>
			)}
		</main>
	);
}
