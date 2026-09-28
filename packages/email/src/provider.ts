import { resolveEmailGuard, isRecipientAllowed } from "./guard";

/**
 * Email provider seam.
 *
 * Default is Cloudflare Email Service via the `send_email` binding. It is in
 * PUBLIC BETA on Workers Paid, and new accounts start with a conservative daily
 * quota that scales with sending reputation. Magic-link sign-in is the most
 * deliverability-sensitive mail this product sends, so the interface exists so
 * that swapping to Resend is one new class and one changed binding, with no
 * caller changes.
 *
 * Two things must be true before production sends work at all:
 *   1. The sending domain is onboarded in the Cloudflare dashboard. Before
 *      onboarding, sends are permitted ONLY to verified destination addresses in
 *      the account, which looks exactly like a broken magic link.
 *   2. The Workers Paid plan is active on the account.
 *
 * The sending domain is notifications.saferate.markets, moved there 2026-09-28
 * from notifications.markets.saferate.com. Seen in the dashboard that day on
 * account 5056399e…: reputation Healthy, daily quota 1,000. (The old domain's
 * page also showed sending Enabled and DNS Configured; that panel was out of
 * frame for the new one, so its first real send is the check.) A new domain
 * starts with no
 * sending reputation, so the earliest magic links are the likeliest to land in
 * spam: check the spam folder before debugging sign-in.
 */

export interface EmailMessage {
	to: string;
	from: string;
	subject: string;
	html: string;
	text: string;
}

export type EmailSendResult =
	| { status: "sent" }
	| { status: "withheld"; reason: string }
	| { status: "failed"; reason: string };

export interface EmailProvider {
	send(message: EmailMessage): Promise<EmailSendResult>;
	readonly name: string;
}

/** The shape the `send_email` binding exposes. */
export interface CloudflareEmailBinding {
	send(message: {
		to: string;
		from: string;
		subject: string;
		html?: string;
		text?: string;
	}): Promise<unknown>;
}

export class CloudflareEmailProvider implements EmailProvider {
	readonly name = "cloudflare-email-service";

	constructor(private readonly _binding: CloudflareEmailBinding) {}

	async send(message: EmailMessage): Promise<EmailSendResult> {
		try {
			await this._binding.send(message);
			return { status: "sent" };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { status: "failed", reason };
		}
	}
}

/**
 * Local development and any environment with no binding. Logs the message so a
 * magic link is recoverable, and never touches the network.
 */
export class ConsoleEmailProvider implements EmailProvider {
	readonly name = "console";

	async send(message: EmailMessage): Promise<EmailSendResult> {
		console.info(
			`[email:console] to=${message.to} subject="${message.subject}"\n${message.text}`,
		);
		return { status: "sent" };
	}
}

/**
 * Wraps any provider in the staging allowlist. Use this at every call site
 * rather than the raw provider, so there is no send path the guard does not
 * cover — the specific gap that bit the consumer app's magic link.
 */
export class GuardedEmailProvider implements EmailProvider {
	readonly name: string;

	constructor(
		private readonly _inner: EmailProvider,
		private readonly _env: { environment?: string; allowlistOverride?: string },
	) {
		this.name = `guarded(${_inner.name})`;
	}

	async send(message: EmailMessage): Promise<EmailSendResult> {
		const guard = resolveEmailGuard(this._env);
		if (
			guard.isGuarded &&
			!isRecipientAllowed({ allowlist: guard.allowlist, recipient: message.to })
		) {
			const reason = `${guard.environment}: ${message.to} is not on ${guard.allowlist.join(", ")}`;
			console.info(`[email-guard] withheld. ${reason}\n${message.text}`);
			return { status: "withheld", reason };
		}
		return this._inner.send(message);
	}
}

/**
 * Single place that decides which provider is in play. Falls back to console
 * rather than throwing, so a missing binding degrades to "link in the log"
 * instead of a 500 on the sign-in page.
 */
export const resolveEmailProvider = (env: {
	EMAIL?: CloudflareEmailBinding;
	/** wrangler var, baked per environment. The authoritative source. */
	MARKETS_ENV?: string;
	/** Fallback for a local shell that exports it. */
	DOPPLER_ENVIRONMENT?: string;
	EMAIL_RECIPIENT_ALLOWLIST?: string;
}): EmailProvider => {
	const inner: EmailProvider = env.EMAIL
		? new CloudflareEmailProvider(env.EMAIL)
		: new ConsoleEmailProvider();
	return new GuardedEmailProvider(inner, {
		environment: env.MARKETS_ENV ?? env.DOPPLER_ENVIRONMENT,
		allowlistOverride: env.EMAIL_RECIPIENT_ALLOWLIST,
	});
};
