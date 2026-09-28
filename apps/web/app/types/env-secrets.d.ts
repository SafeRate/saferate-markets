// Worker SECRETS are not in wrangler.jsonc, so `wrangler types` does not declare
// them. Declared by hand here.
//
// `wrangler types` emits TWO Env interfaces: `Cloudflare.Env` in the namespace
// and a separate GLOBAL `Env`, which is what `context.cloudflare.env` resolves to
// and which does NOT extend Cloudflare.Env. Augment BOTH, or every secret is
// missing at every call site (the consumer app measured 87 to 119 phantom
// errors against a real baseline of 4). OKLocate's rule.

interface MarketsSecrets {
	BETTER_AUTH_SECRET: string;
	/** Optional: a comma list overriding the non-production email allowlist. */
	EMAIL_RECIPIENT_ALLOWLIST?: string;
	/**
	 * The send_email binding exists only in staging and production. Declared
	 * optional here so local dev, which has none, typechecks against the truth.
	 */
	EMAIL?: SendEmail;
}

declare namespace Cloudflare {
	interface Env extends MarketsSecrets {}
}

declare interface Env extends MarketsSecrets {}
