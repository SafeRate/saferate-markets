import { PRODUCT_NAME } from "@markets/schema";
import { Form, useNavigation } from "react-router";
import { getAuth } from "@/services/auth.server";
import type { Route } from "./+types/sign-in";

export const meta: Route.MetaFunction = () => [
	{ title: `Sign in — ${PRODUCT_NAME}` },
];

/**
 * Magic-link sign-in. Open sign-up: an address with no account gets one.
 *
 * The response is deliberately identical whether or not the address has an
 * account, and whether or not the send actually succeeded. Anything else turns
 * this form into an account-existence oracle, and a B2B customer list is exactly
 * what someone would enumerate.
 */
export const action = async ({ request, context }: Route.ActionArgs) => {
	const formData = await request.formData();
	const email = String(formData.get("email") ?? "")
		.trim()
		.toLowerCase();

	// Cheap shape check only. Real validation is the link arriving.
	if (!email.includes("@") || email.length > 254) {
		return { status: "error" as const, message: "Enter a valid email address." };
	}

	const env = context.cloudflare.env;
	try {
		const auth = getAuth({ env, request });
		await auth.api.signInMagicLink({
			body: { email, callbackURL: "/dashboard" },
			headers: request.headers,
		});
	} catch (error) {
		// Logged, not surfaced. A failure here must look the same as a success or
		// the form leaks which addresses exist.
		console.error("[sign-in] magic link request failed:", error);
	}

	return { status: "sent" as const, email };
};

const SignIn = ({ actionData }: Route.ComponentProps) => {
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";

	if (actionData?.status === "sent") {
		return (
			<main className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6">
				<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
					Check your email
				</h1>
				<p className="mt-3 text-muted-foreground">
					If an account can be created or found for{" "}
					<span className="font-mono text-foreground">{actionData.email}</span>, a
					sign-in link is on its way. It expires in 15 minutes and works once.
				</p>
				<p className="mt-6 text-sm text-muted-foreground">
					Nothing arrived? Check spam, then{" "}
					<a className="text-primary underline underline-offset-4" href="/sign-in">
						try again
					</a>
					.
				</p>
			</main>
		);
	}

	return (
		<main className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6">
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				{PRODUCT_NAME}
			</p>
			<h1 className="mt-4 text-2xl font-semibold tracking-tight text-neutral-900">
				Sign in
			</h1>
			<p className="mt-3 text-muted-foreground">
				We email you a link. No password to choose or forget.
			</p>

			<Form className="mt-8 flex flex-col gap-3" method="post">
				<label className="text-sm font-medium" htmlFor="email">
					Work email
				</label>
				<input
					autoComplete="email"
					// biome-ignore lint/a11y/noAutofocus: the rule guards against stealing focus on a content page. This page IS the single field — there is nothing else here to read past — and landing ready to type is why someone followed a "Sign in" link.
					autoFocus
					className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
					id="email"
					name="email"
					placeholder="you@company.com"
					required
					type="email"
				/>
				<button
					className="mt-2 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-60"
					disabled={isSubmitting}
					type="submit"
				>
					{isSubmitting ? "Sending…" : "Email me a link"}
				</button>
			</Form>

			{actionData?.status === "error" ? (
				<p className="mt-4 text-sm text-muted-foreground">{actionData.message}</p>
			) : null}

			<p className="mt-8 text-xs leading-relaxed text-muted-foreground">
				New here? Signing in creates your account.
			</p>
		</main>
	);
};

export default SignIn;
