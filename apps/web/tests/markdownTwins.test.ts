import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "../app/lib/htmlToMarkdown";
import {
	PUBLIC_TWIN_PATHS,
	pageOfTwinPath,
	twinPathOf,
} from "../app/lib/publicPages";

const ORIGIN = "https://saferate.markets";

describe("twin paths", () => {
	test("every public page maps to a twin and back", () => {
		for (const page of PUBLIC_TWIN_PATHS)
			expect(pageOfTwinPath(twinPathOf(page))).toBe(page);
	});

	test("the home page answers at /.txt, which is what the Cloudflare rule makes of /", () => {
		expect(pageOfTwinPath("/.txt")).toBe("/");
		expect(pageOfTwinPath("/index.txt")).toBe("/");
	});

	test("a dashboard page has no twin", () => {
		expect(pageOfTwinPath("/dashboard.txt")).toBeNull();
		expect(pageOfTwinPath("/dashboard/stress.txt")).toBeNull();
	});
});

describe("htmlToMarkdown", () => {
	test("headings, paragraphs, emphasis and code", () => {
		const md = htmlToMarkdown(
			'<main><h1>Title</h1><p>Plain <strong>bold</strong> and <code>/v1/x</code>.</p><h2 class="x">Next</h2></main>',
			ORIGIN,
		);
		expect(md).toBe("# Title\n\nPlain **bold** and `/v1/x`.\n\n## Next");
	});

	test("relative links become absolute; svg and buttons are dropped", () => {
		const md = htmlToMarkdown(
			'<p><a href="/data">Data</a> and <a href="https://saferate.com/treasury">Treasury</a></p><svg><path d="M0"/></svg><button>Go</button>',
			ORIGIN,
		);
		expect(md).toBe(
			"[Data](https://saferate.markets/data) and [Treasury](https://saferate.com/treasury)",
		);
	});

	test("a list reads as one list, and a definition list as labelled items", () => {
		const md = htmlToMarkdown(
			"<ul><li>One</li><li>Two</li></ul><dl><div><dt>Weighting</dt><dd>Market value</dd></div></dl>",
			ORIGIN,
		);
		expect(md).toBe("- One\n- Two\n- **Weighting**: Market value");
	});

	test("a table becomes a markdown table, pipes escaped", () => {
		const md = htmlToMarkdown(
			"<table><thead><tr><th>Index</th><th>Level</th></tr></thead><tbody><tr><td>A|B</td><td>142.78</td></tr></tbody></table>",
			ORIGIN,
		);
		expect(md).toBe("| Index | Level |\n| --- | --- |\n| A\\|B | 142.78 |");
	});

	test("two blocks in one cell stay two words", () => {
		const md = htmlToMarkdown(
			'<table><tr><th>Index</th></tr><tr><td><a href="/x">1-3 Year</a><div>SR-UST-TR-0103</div></td></tr></table>',
			ORIGIN,
		);
		expect(md).toContain("[1-3 Year](https://saferate.markets/x) SR-UST-TR-0103");
	});

	test("entities decode and code blocks keep their lines", () => {
		const md = htmlToMarkdown(
			"<p>Rich &amp; cheap &#x27;quoted&#x27;</p><pre><code>curl x \\\n  -H y</code></pre>",
			ORIGIN,
		);
		expect(md).toBe("Rich & cheap 'quoted'\n\n```\ncurl x \\\n  -H y\n```");
	});
});
