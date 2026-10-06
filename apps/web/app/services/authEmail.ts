/**
 * Magic-link email body. Plain text AND HTML, both required.
 *
 * The text part is not a courtesy: a message with only an HTML part scores worse
 * with spam filters, and this is the single most delivery-sensitive mail the
 * product sends. Cloudflare Email Service accepts both on one send.
 *
 * Deliberately plain. No images, no tracking pixel, no external CSS — a
 * sign-in link that renders identically in every client and cannot be blocked
 * by an image proxy.
 */
export const magicLinkEmail = (url: string) => ({
	text: [
		"Sign in to Safe Rate Markets",
		"",
		"Use the link below to sign in. It expires in 15 minutes and works once.",
		"",
		url,
		"",
		"If you did not request this, you can ignore this email.",
	].join("\n"),
	html: `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f8fafc">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
    <p style="margin:0 0 8px;font:600 13px/1.4 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#4f46e5">Safe Rate Markets</p>
    <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#0f172a">Sign in to Safe Rate Markets</h1>
    <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#475569">
      Use the button below to sign in. It expires in 15 minutes and works once.
    </p>
    <a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;padding:13px 28px;border-radius:9999px;text-decoration:none;font-weight:600;font-size:15px">Sign in</a>
    <p style="margin:28px 0 0;font-size:13px;line-height:1.6;color:#64748b;word-break:break-all">
      Or paste this into your browser:<br />${url}
    </p>
    <p style="margin:32px 0 0;font-size:12px;line-height:1.5;color:#94a3b8">
      If you did not request this, you can ignore this email.
    </p>
  </div>
</body>
</html>`,
});

/**
 * Whether a new account warrants a notice to the team: production only (a
 * staging test account is not a lead), and only for addresses outside
 * saferate.com, which are the team's own (Dylan, 2026-10-06).
 */
export const shouldNotifySignup = (input: {
	email: string;
	environment: string;
}) =>
	input.environment === "production" &&
	!input.email.trim().toLowerCase().endsWith("@saferate.com");

const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

/**
 * The team's notice of a new sign-up. The address is the one thing in it from
 * outside, so it is escaped in the HTML part.
 */
export const signupNoticeEmail = (input: {
	email: string;
	createdAt: Date;
	siteAddress: string;
}) => {
	const when = input.createdAt.toLocaleString("en-US", {
		timeZone: "America/New_York",
		dateStyle: "medium",
		timeStyle: "short",
	});
	const host = new URL(input.siteAddress).host;
	const lines = [
		`${input.email} signed up for Safe Rate Markets.`,
		"",
		`When: ${when} Eastern`,
		`Signed up on: ${host}`,
		"Plan: none yet, so they see the read-only demo until they subscribe.",
	];
	return {
		subject: `New Safe Rate Markets sign-up: ${input.email}`,
		text: lines.join("\n"),
		html: `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f8fafc">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#0f172a">
    <p style="margin:0 0 8px;font:600 13px/1.4 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#4f46e5">New sign-up</p>
    <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(input.email)}</h1>
    <p style="margin:0 0 6px;font-size:15px;color:#475569">When: ${escapeHtml(when)} Eastern</p>
    <p style="margin:0 0 6px;font-size:15px;color:#475569">Signed up on: ${escapeHtml(host)}</p>
    <p style="margin:0;font-size:15px;color:#475569">Plan: none yet, so they see the read-only demo until they subscribe.</p>
  </div>
</body>
</html>`,
	};
};
