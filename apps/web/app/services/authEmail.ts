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
    <p style="margin:0 0 8px;font:600 13px/1.4 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#64748b">Safe Rate Markets</p>
    <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#0f172a">Sign in to Safe Rate Markets</h1>
    <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#475569">
      Use the button below to sign in. It expires in 15 minutes and works once.
    </p>
    <a href="${url}" style="display:inline-block;background:#0f172a;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Sign in</a>
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
