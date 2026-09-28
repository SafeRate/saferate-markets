/**
 * Fail if anything secret reached the browser bundle.
 *
 *   bun scripts/verify-no-secret-leak.ts
 *   DOPPLER_CONFIG=prd bun scripts/verify-no-secret-leak.ts
 *   DIST_DIR=apps/web/dist/client bun scripts/verify-no-secret-leak.ts
 *
 * WHY THIS EXISTS. `scripts/bash/build-web.sh` exports EVERY Doppler secret
 * into the build with a `VITE_` prefix, and `VITE_` is precisely the prefix
 * Vite exposes to client code. Nothing leaks today, for one reason only: the
 * whole app contains a single `import.meta.env` reference
 * (`workers/app.ts` reads `MODE`, server-side), so Vite has nothing to
 * substitute and never serialises the env object. That is a convention holding
 * a footgun shut, and conventions are not checkable.
 *
 * The failure it guards is one line in a client component —
 * `import.meta.env.VITE_BETTER_AUTH_SECRET` — which typechecks, builds
 * cleanly, renders correctly, and publishes a signing key to every visitor.
 * There is no error, no warning, and nothing in a diff review that looks
 * different from reading an ordinary config value.
 *
 * Verified by hand on 2026-09-21 against a real staging build and the live
 * assets staging serves: 8 of 8 secrets clean, zero `VITE_` tokens surviving
 * into `dist/client`. This makes that a gate instead of an anecdote.
 *
 * IT NEVER PRINTS A SECRET. It reports the KEY NAME and the file that matched.
 * A leak detector that echoes the value into a CI log has published the secret
 * a second time, to a wider audience, with a timestamp.
 *
 * Two tiers, because the cheap one needs no credentials:
 *
 *   1. Always: scan for `VITE_` tokens, a serialised `import.meta.env`, and
 *      strings shaped like known credentials (`sk_live_`, `whsec_`, …). This
 *      catches the mechanism regardless of which environment was built, and
 *      runs in CI with no Doppler access at all.
 *   2. With Doppler: match every secret value in the config exactly. This is
 *      the only tier that catches a secret with no recognisable shape, which
 *      is most of them — `BETTER_AUTH_SECRET` is just bytes.
 *
 * Tier 2 being unavailable is reported as UNVERIFIED, never as a pass. A
 * tripwire that goes green because it could not look is the failure mode the
 * geocoder contract check already learned the hard way.
 *
 * Exits 1 on any leak, so it can gate a deploy.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DIST_DIR = process.env.DIST_DIR ?? "apps/web/dist/client";
const DOPPLER_PROJECT = process.env.DOPPLER_PROJECT_NAME ?? "saferate-markets";
const DOPPLER_CONFIG = process.env.DOPPLER_CONFIG ?? "stg";

/**
 * A value shorter than this is not greppable: an 8-character string appears in
 * minified output by coincidence, and reporting that as a leak trains everyone
 * to ignore this script. Short values are counted as UNVERIFIED instead, which
 * is the honest answer.
 */
const MIN_GREPPABLE_LENGTH = 12;

/** Extensions a browser actually executes or reads. */
const TEXT_EXTENSIONS = [
	".js",
	".mjs",
	".cjs",
	".css",
	".map",
	".json",
	".html",
	".txt",
];

/**
 * Credential shapes worth finding with no credentials to compare against.
 * Deliberately anchored on the vendor prefix rather than on entropy: an
 * entropy heuristic over minified JavaScript is all false positives.
 */
const CREDENTIAL_PATTERNS: { label: string; re: RegExp }[] = [
	{ label: "Stripe live secret key", re: /sk_live_[A-Za-z0-9]{10,}/g },
	{ label: "Stripe test secret key", re: /sk_test_[A-Za-z0-9]{10,}/g },
	{ label: "Stripe restricted key", re: /rk_(?:live|test)_[A-Za-z0-9]{10,}/g },
	{ label: "Stripe webhook secret", re: /whsec_[A-Za-z0-9]{10,}/g },
	{ label: "Cloudflare user token", re: /cfut_[A-Za-z0-9_-]{20,}/g },
	{ label: "Cloudflare account token", re: /cfat_[A-Za-z0-9_-]{20,}/g },
	{ label: "AWS access key id", re: /AKIA[0-9A-Z]{16}/g },
	{ label: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/g },
	{
		label: "private key block",
		re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
	},
];

/**
 * Vite's own name for the serialised env object, when it emits one by that
 * name. An unambiguous hit, so it needs no corroboration.
 */
const ENV_OBJECT_SENTINEL = "__vite_import_meta_env__";

/**
 * Keys Vite puts in `import.meta.env` alongside the `VITE_` ones. Used to
 * recognise a serialised env OBJECT, which is the case that ships every
 * `VITE_` variable at once and so matters more than any single one.
 */
const ENV_OBJECT_KEYS = ["BASE_URL", "MODE", "DEV", "PROD", "SSR"];

/**
 * How far apart two of those keys may sit and still count as one object.
 * Generous, because minifiers reorder and a real env object stays compact.
 */
const ENV_OBJECT_WINDOW = 400;

/**
 * Require a key to be followed by `:` and then a VALUE, and require a second
 * env key nearby.
 *
 * ⚠️ A bare `BASE_URL:` substring test is NOT sufficient, and assuming it was
 * produced three false positives the first time this ran against another repo
 * (saferate-ai's consumer, apply and admin bundles, 2026-09-21). All three
 * matched `C.BASE_URL:void 0` — the colon of a TERNARY inside `std-env`, a
 * Better Auth dependency whose `C` is a Proxy over `globalThis`, not a Vite
 * object at all. Requiring a literal value excludes `:void 0`; requiring a
 * companion key excludes anyone's own single-field config object.
 *
 * A gate that cries wolf gets ignored, which costs more than the check earns.
 */
const looksLikeSerialisedEnv = (text: string): string | null => {
	if (text.includes(ENV_OBJECT_SENTINEL)) return ENV_OBJECT_SENTINEL;
	for (const key of ENV_OBJECT_KEYS) {
		// `KEY:"…"`, `KEY:'…'`, `"KEY":…`, `KEY:!0` / `KEY:!1` (minified boolean).
		const assigned = new RegExp(
			`["']?\\b${key}\\b["']?\\s*:\\s*(?:["'!]|true|false)`,
			"g",
		);
		for (const match of text.matchAll(assigned)) {
			const from = Math.max(0, match.index - ENV_OBJECT_WINDOW);
			const window = text.slice(from, match.index + ENV_OBJECT_WINDOW);
			const companions = ENV_OBJECT_KEYS.filter(
				(other) =>
					other !== key && new RegExp(`["']?\\b${other}\\b["']?\\s*:`).test(window),
			);
			if (companions.length > 0) {
				return `${key} beside ${companions.join(", ")}`;
			}
		}
	}
	return null;
};

/**
 * Doppler keys whose value is PUBLIC BY DESIGN, so finding one in the browser
 * bundle is correct rather than a leak.
 *
 * `BETTER_AUTH_URL` is the site's own origin — `https://saferate.markets` in prd —
 * and the client bundle necessarily contains it. `EMAIL_FROM` is the address
 * printed on the contact pages. Neither is a credential; both live in Doppler
 * because they differ per environment, which is a deployment concern rather
 * than a secrecy one.
 *
 * ⚠️ This exemption is the obvious way to poke a hole in the whole check, so it
 * is TWO conditions, not one: the key must be named here AND its value must
 * still look like a URL or an email address. Putting a real credential into
 * `BETTER_AUTH_URL` therefore fails the shape test and is still reported. A
 * name-only allowlist would excuse whatever anyone later stored under that key.
 *
 * Found the hard way: the gate passed on staging and blocked the PRODUCTION
 * build on 2026-09-21, because staging's `https://staging.saferate.markets` happens
 * not to appear in the bundle while production's apex does. The check was
 * accidentally environment-dependent.
 */
const PUBLIC_BY_DESIGN = new Set(["BETTER_AUTH_URL", "EMAIL_FROM"]);

/**
 * A bare http(s) URL, or an email address, bare or in `Name <a@b.c>` form.
 *
 * Both shapes are built to reject `https://user:password@host`, a URL carrying
 * userinfo — a credential wearing a URL's clothes, and the one value that would
 * otherwise slip through under a key named for a URL. The URL shape forbids `@`
 * outright. The EMAIL shapes forbid `:` and `/`, which is the part that is easy
 * to miss and was wrong first time: without it, `https://user:password@host.com`
 * parses as local-part `https://user:password` plus domain `host.com` and is
 * exempted by the EMAIL rule even though the URL rule rejected it.
 */
const PUBLIC_VALUE_SHAPES = [
	/^https?:\/\/[^\s"'<>@]+$/,
	/^[^@\s<>:/]+@[^@\s<>:/]+\.[A-Za-z]{2,}$/,
	/^[^<>:/]+<[^@\s<>:/]+@[^@\s<>:/]+\.[A-Za-z]{2,}>$/,
];

const isPublicByDesign = (key: string, value: string): boolean =>
	PUBLIC_BY_DESIGN.has(key) &&
	PUBLIC_VALUE_SHAPES.some((shape) => shape.test(value));

type Finding = {
	/** Never a value. */
	readonly what: string;
	readonly file: string;
};

const findings: Finding[] = [];
const notes: string[] = [];

const walk = async (dir: string): Promise<string[]> => {
	const out: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...(await walk(path)));
			continue;
		}
		if (TEXT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(path);
	}
	return out;
};

const exists = async (path: string) => {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
};

if (!(await exists(DIST_DIR))) {
	console.error(`No build to check at ${DIST_DIR}.`);
	console.error(
		"Run scripts/bash/build-web.sh {staging|production} first, or set DIST_DIR.",
	);
	// Exit 1 rather than 0. "There was nothing to look at" must not read as
	// "nothing was wrong" to whatever is gating on this.
	process.exit(1);
}

const files = await walk(DIST_DIR);
console.info(`Scanning ${files.length} file(s) under ${DIST_DIR}\n`);

/** file path -> contents, read once. */
const contents = new Map<string, string>();
for (const file of files) contents.set(file, await readFile(file, "utf8"));

// ---------------------------------------------------------------- tier 1

console.info("Tier 1 — mechanism (no credentials needed)");

let viteTokens = 0;
let envObjects = 0;
for (const [file, text] of contents) {
	for (const match of text.matchAll(/VITE_[A-Za-z0-9_]+/g)) {
		viteTokens += 1;
		findings.push({
			what: `\`${match[0]}\` substituted into client output`,
			file,
		});
	}
	if (text.includes("import.meta.env")) {
		findings.push({
			what: "raw `import.meta.env` survived into client output",
			file,
		});
	}
	const envObject = looksLikeSerialisedEnv(text);
	if (envObject !== null) {
		envObjects += 1;
		findings.push({
			what: `serialised \`import.meta.env\` object (${envObject}) — this ships EVERY VITE_ variable`,
			file,
		});
	}
	for (const { label, re } of CREDENTIAL_PATTERNS) {
		if (re.test(text)) findings.push({ what: `${label} (by shape)`, file });
		re.lastIndex = 0;
	}
}

console.info(`  VITE_ tokens in client output:      ${viteTokens}`);
console.info(`  serialised import.meta.env objects: ${envObjects}`);
console.info(
	`  credential-shaped strings:          ${findings.filter((f) => f.what.endsWith("(by shape)")).length}`,
);

// ---------------------------------------------------------------- tier 2

console.info("\nTier 2 — exact secret values (needs Doppler)");

type DopplerSecret = { computed?: string };

const readDopplerSecrets = async (): Promise<Record<
	string,
	DopplerSecret
> | null> => {
	try {
		/*
		 * `doppler secrets --json` returns the values on STDOUT. Nothing secret
		 * goes on a command line, where /proc/<pid>/cmdline is world-readable
		 * while /proc/<pid>/environ is not.
		 *
		 * execFile rather than Bun.spawn: this repo installs no bun types at the
		 * root, so a Bun global here cannot be typechecked, and node:child_process
		 * runs identically under both runtimes. `maxBuffer` is raised because the
		 * default 1 MB would truncate a large config into invalid JSON — which
		 * would be caught as a parse error and reported as UNVERIFIED, but for the
		 * wrong reason.
		 */
		const { stdout } = await execFileAsync(
			"doppler",
			[
				"secrets",
				"--project",
				DOPPLER_PROJECT,
				"--config",
				DOPPLER_CONFIG,
				"--json",
			],
			{ maxBuffer: 32 * 1024 * 1024 },
		);
		return JSON.parse(stdout) as Record<string, DopplerSecret>;
	} catch {
		return null;
	}
};

const secrets = await readDopplerSecrets();

if (secrets === null) {
	notes.push(
		`UNVERIFIED: could not read Doppler ${DOPPLER_PROJECT}/${DOPPLER_CONFIG}, so exact\n` +
			"  secret values were NOT checked. Tier 1 passed, which catches the\n" +
			"  mechanism but not a secret with no recognisable shape.",
	);
	console.info("  skipped — no Doppler access");
} else {
	let checked = 0;
	let unverifiable = 0;
	const allowed: string[] = [];
	for (const [key, entry] of Object.entries(secrets)) {
		if (/doppler/i.test(key)) continue;
		const value = entry.computed ?? "";
		if (value.length < MIN_GREPPABLE_LENGTH) {
			unverifiable += 1;
			continue;
		}
		if (isPublicByDesign(key, value)) {
			allowed.push(key);
			continue;
		}
		checked += 1;
		for (const [file, text] of contents) {
			// Report the KEY, never the value.
			if (text.includes(value))
				findings.push({ what: `value of \`${key}\``, file });
		}
	}
	// A COUNT OF WHAT WAS SEARCHED FOR, never of what was found. Leaks are
	// reported below as findings; this line going up is the check getting
	// broader, not the bundle getting worse. It used to read "matched
	// exactly", which a reader skimming a CI log could take for a leak count
	// — the one misreading a tripwire must never invite.
	console.info(`  secrets checked by exact match: ${checked}`);
	if (allowed.length > 0) {
		// Named, not silent. An exemption nobody sees is an exemption nobody
		// re-examines.
		console.info(`  public by design, not checked: ${allowed.join(", ")}`);
	}
	if (unverifiable > 0) {
		notes.push(
			`${unverifiable} secret(s) in ${DOPPLER_PROJECT}/${DOPPLER_CONFIG} are shorter than ` +
				`${MIN_GREPPABLE_LENGTH} characters\n  and were NOT matched — too short to grep without false positives.`,
		);
	}
}

// ---------------------------------------------------------------- report

console.info("");
for (const note of notes) console.warn(`⚠ ${note}`);

if (findings.length > 0) {
	console.error(`\n${findings.length} leak(s) found in ${DIST_DIR}:\n`);
	for (const finding of findings)
		console.error(`  ✘ ${finding.file}: ${finding.what}`);
	console.error(
		"\nThis bundle is served to every visitor. Do NOT deploy it.\n" +
			"Most likely cause: client code now reads `import.meta.env.VITE_<NAME>`.\n" +
			"build-web.sh exports every Doppler secret with that prefix, so reading one\n" +
			"by name inlines it into the browser bundle. Move the read to the Worker's\n" +
			"`env` binding, which never reaches the client.\n" +
			"If a secret did reach a deployed bundle, ROTATE IT — it is published.",
	);
	process.exit(1);
}

console.info(
	notes.length > 0
		? "No leaks found, with the caveats above."
		: "No leaks found.",
);
