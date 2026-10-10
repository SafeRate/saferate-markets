import { confirmAlertSignup } from "@markets/persistence";
import { PRODUCT_NAME } from "@markets/schema";
import { useEffect, useRef } from "react";
import { Form, Link, redirectDocument } from "react-router";
import { hashToken } from "@/services/alertSignup.server";
import { getAuth } from "@/services/auth.server";
import type { Route } from "./+types/alerts.confirm";

/**
 * The link in a sign-up's confirmation email. The GET changes nothing, because
 * mail scanners fetch links; the page submits itself on load, so the email
 * click is the only click, with the button as the fallback without
 * JavaScript. The POST confirms the sign-up
 * and signs the person in with a one-time Better Auth magic-link token minted
 * here (the same token and verify step as an emailed sign-in link), creating
 * the account if it is new. They land on /alerts/confirmed, which applies the
 * choices and opens their alerts page. The link keeps working until it
 * expires, so a second click lands in the same place.
 *
 * The submit is a full document POST (reloadDocument, redirectDocument):
 * /api/auth/* is served by the Worker ahead of the router, so a client-side
 * navigation there 404s and never spends the sign-in token.
 */

export const meta: Route.MetaFunction = () => [
	{ title: `Confirm email alerts | ${PRODUCT_NAME}` },
];

/** Long enough to follow a redirect, short enough to be useless if leaked. */
const SIGN_IN_TTL_MS = 5 * 60 * 1000;

export const action = async ({ request, context }: Route.ActionArgs) => {
	const env = context.cloudflare.env;
	const token = new URL(request.url).searchParams.get("t") ?? "";
	if (!token) return { ok: false as const };
	const idAlertSignup = await hashToken(token);
	const signup = await confirmAlertSignup({ db: env.DB, idAlertSignup });
	if (!signup) return { ok: false as const };

	const auth = getAuth({ env, request });
	const ctx = await auth.$context;
	const signIn = crypto.randomUUID().replace(/-/g, "");
	await ctx.internalAdapter.createVerificationValue({
		identifier: signIn,
		value: JSON.stringify({ email: signup.email }),
		expiresAt: new Date(Date.now() + SIGN_IN_TTL_MS),
	});
	const callbackURL = `/alerts/confirmed?s=${idAlertSignup}`;
	return redirectDocument(
		`/api/auth/magic-link/verify?${new URLSearchParams({ token: signIn, callbackURL })}`,
	);
};

export default function Confirm({ actionData }: Route.ComponentProps) {
	const form = useRef<HTMLFormElement>(null);
	useEffect(() => {
		if (!actionData) form.current?.requestSubmit();
	}, [actionData]);
	return (
		<main className="mx-auto max-w-xl px-6 py-20">
			{actionData && !actionData.ok ? (
				<>
					<h1 className="text-2xl font-semibold text-neutral-900">
						This link has expired
					</h1>
					<p className="mt-3 text-slate-600">
						If you confirmed before it expired,{" "}
						<Link
							className="text-primary underline underline-offset-4"
							to={`/sign-in?next=${encodeURIComponent("/dashboard/alerts")}`}
						>
							sign in
						</Link>{" "}
						to manage your alerts. Otherwise, subscribe again for a new link.
					</p>
				</>
			) : (
				<>
					<h1 className="text-2xl font-semibold text-neutral-900">
						Confirming your Treasury email alerts
					</h1>
					<p className="mt-3 text-slate-600">
						Confirming creates a free {PRODUCT_NAME} account for this address, if
						there is not one already, where you can choose terms or turn alerts off at
						any time.
					</p>
					<Form className="mt-6" method="post" ref={form} reloadDocument>
						<button
							className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground"
							type="submit"
						>
							Confirm
						</button>
					</Form>
				</>
			)}
		</main>
	);
}
