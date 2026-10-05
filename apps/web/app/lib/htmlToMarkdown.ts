/**
 * Markdown from the HTML of one of OUR pages, for its `.txt` twin.
 *
 * Not a general converter, and deliberately not a library: the input is markup
 * this app renders itself (renderToStaticMarkup of a public page component),
 * so the set of elements is small and known. Headings, paragraphs, lists,
 * definition lists, tables, code, links and images become markdown; layout
 * (div, section, span) and decoration (svg, inline styles) are dropped.
 * Relative links are made absolute against `origin`, since a twin is read
 * outside the site.
 */

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#x27;": "'",
	"&#39;": "'",
	"&nbsp;": " ",
	"&#x2F;": "/",
};

const decode = (text: string) =>
	text
		.replace(/&(amp|lt|gt|quot|nbsp|#x27|#39|#x2F);/g, (m) => ENTITIES[m] ?? m)
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) =>
			String.fromCodePoint(Number.parseInt(n, 16)),
		);

/** Inline markup to inline markdown, then every remaining tag dropped. */
const inline = (html: string, origin: string): string =>
	decode(
		html
			.replace(/<br\s*\/?>/gi, " ")
			// A closing block tag separates what sat in two blocks ("1-3 Year" and
			// its ticker in a table cell) instead of running them together.
			.replace(/<\/?(div|p|dd|dt|li|figcaption)\b[^>]*>/gi, " ")
			// Side-by-side spans or links are separate items (a label and its
			// value, two buttons), not one word. A span inside a sentence is not
			// touched, so "page</span>." keeps its punctuation tight.
			.replace(/<\/(span|a)>\s*<(span|a)\b/gi, "</$1> <$2")
			.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => {
				const inner = t.trim();
				return inner ? `**${inner}**` : "";
			})
			.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => {
				const inner = t.trim();
				return inner ? `*${inner}*` : "";
			})
			.replace(
				/<code\b[^>]*>([\s\S]*?)<\/code>/gi,
				(_, t) => `\`${t.replace(/<[^>]+>/g, "")}\``,
			)
			.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => {
				const text = t.replace(/<[^>]+>/g, "").trim();
				const url = href.startsWith("/") ? `${origin}${href}` : href;
				return text ? `[${text}](${url})` : "";
			})
			.replace(
				/<img\b[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi,
				(_, alt, src) =>
					`![${alt}](${src.startsWith("/") ? `${origin}${src}` : src})`,
			)
			.replace(
				/<img\b[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi,
				(_, src, alt) =>
					`![${alt}](${src.startsWith("/") ? `${origin}${src}` : src})`,
			)
			.replace(/<[^>]+>/g, ""),
	)
		.replace(/\s+/g, " ")
		.trim();

const table = (html: string, origin: string) => {
	const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
		[...row[1].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((cell) =>
			inline(cell[2], origin).replace(/\|/g, "\\|"),
		),
	);
	if (rows.length === 0) return "";
	const width = Math.max(...rows.map((r) => r.length));
	const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
	const [head, ...body] = rows.map(pad);
	return [
		`| ${head.join(" | ")} |`,
		`| ${head.map(() => "---").join(" | ")} |`,
		...body.map((r) => `| ${r.join(" | ")} |`),
	].join("\n");
};

export const htmlToMarkdown = (html: string, origin: string) => {
	const blocks: string[] = [];
	const keep = (markdown: string) => {
		blocks.push(markdown);
		return `\n\n@@BLOCK${blocks.length - 1}@@\n\n`;
	};
	let s = html
		.replace(/<(script|style|svg|noscript|form|button|nav)\b[\s\S]*?<\/\1>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");

	s = s
		.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) =>
			keep(`\`\`\`\n${decode(code.replace(/<[^>]+>/g, "")).trim()}\n\`\`\``),
		)
		.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, t) =>
			keep(table(t, origin)),
		)
		.replace(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, t) =>
			keep(`${"#".repeat(Number(level))} ${inline(t, origin)}`),
		)
		.replace(
			/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi,
			(_, term, text) =>
				keep(`- **${inline(term, origin)}**: ${inline(text, origin)}`),
		)
		.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) =>
			keep(`- ${inline(t, origin)}`),
		)
		.replace(
			/<(p|figcaption|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi,
			(_, __, t) => {
				const text = inline(t, origin);
				return text ? keep(text) : "";
			},
		)
		.replace(/<img\b[^>]*>/gi, (tag) => {
			const text = inline(tag, origin);
			return text ? keep(text) : "";
		});

	// Anything left outside a block is layout text (a label in a div): keep it.
	s = s
		.split(/(@@BLOCK\d+@@)/)
		.map((part) => {
			const block = part.match(/^@@BLOCK(\d+)@@$/);
			if (block) return blocks[Number(block[1])];
			const text = inline(part, origin);
			return text ? text : "";
		})
		.filter(Boolean)
		.join("\n\n");

	// Consecutive list items read as one list.
	return s.replace(/(^- .*)\n\n(?=- )/gm, "$1\n").trim();
};
