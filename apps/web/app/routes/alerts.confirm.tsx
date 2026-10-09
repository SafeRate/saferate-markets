import { confirmAlertSignup } from "@markets/persistence";
import { PRODUCT_NAME } from "@markets/schema";
import { Form, Link, redirect } from "react-router";
import { hashToken } from "@/services/alertSignup.server";
import { getAuth } from "@/services/auth.server";
import type { Route } from "./+types/alerts.confirm";

/**
 * The link in a sign-up's confirmation email. A GET shows a button and changes
 * nothing, because mail scanners follow links; the POST confirms the sign-up
 * and signs the person in with a one-time Better Auth magic-link token minted
 * here (the same token and verify step as an emailed sign-in link), creating
 * the account if it is new. They land on /alerts/confirmed, which applies the
 * choices and opens their alerts page.
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
	return redirect(
		`/api/auth/magic-link/verify?${new URLSearchParams({ token: signIn, callbackURL })}`,
	);
};

export default function Confirm({ actionData }: Route.ComponentProps) {
	return (
		<main className="mx-auto max-w-xl px-6 py-20">
			{actionData && !actionData.ok ? (
				<>
					<h1 className="text-2xl font-semibold text-neutral-900">
						This link has expired or was already used
					</h1>
					<p className="mt-3 text-slate-600">
						If you already confirmed,{" "}
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
						Confirm your Treasury email alerts
					</h1>
					<p className="mt-3 text-slate-600">
						Confirming creates a free {PRODUCT_NAME} account for this address, if
						there is not one already, where you can choose terms or turn alerts off at
						any time.
					</p>
					<Form className="mt-6" method="post">
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
