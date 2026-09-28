/**
 * API key generation and hashing. Ported from saferate-oklocate.
 *
 * The secret is NEVER stored. Only a sha-256 hash and a short non-secret prefix
 * go to the database, so there is no query, no dump and no support tool that can
 * return a usable key. A key is shown once, at creation; losing it means
 * rotating it.
 *
 * Lookup is BY hash against a unique index rather than fetch-and-compare, so
 * there is no secret comparison to time.
 */

const KEY_BYTES = 32;

/**
 * `srm_live_`. "live" is carried although there is no test mode, so that test
 * keys can be added later as `srm_test_` without changing the format of every
 * key already in a customer's config. It promises nothing: the key string is
 * not what grants or isolates anything, the database row is.
 */
export const API_KEY_PREFIX = "srm_live_";

/** How much of the key is safe to display and log: the prefix plus 4 chars. */
const DISPLAY_LENGTH = API_KEY_PREFIX.length + 4;

/**
 * base62 rather than base64url. Keys get pasted into shells, YAML, .env files
 * and URLs, where `-` and `_` invite quoting and line-break mistakes. 32 bytes
 * through base62 keeps ~190 bits, far past anything that matters.
 */
const ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const toBase62 = (bytes: Uint8Array) => {
	let out = "";
	for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
	return out;
};

export const sha256Hex = async (value: string) => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
};

/**
 * Returns the plaintext key ONCE beside what to persist. The caller shows `key`
 * and stores only `hashApiKey` and `prefixApiKey`.
 */
export async function generateApiKey() {
	const random = new Uint8Array(KEY_BYTES);
	crypto.getRandomValues(random);
	const key = `${API_KEY_PREFIX}${toBase62(random)}`;
	return {
		key,
		hashApiKey: await sha256Hex(key),
		prefixApiKey: key.slice(0, DISPLAY_LENGTH),
	};
}

const KEY_PATTERN = /^srm_live_[A-Za-z0-9]{32}$/;

/**
 * Pull a key out of an Authorization header.
 *
 * Also accepts the raw key with no scheme, because people paste it that way and a
 * 401 that is really a formatting slip wastes an afternoon. Anything not shaped
 * like one of our keys is rejected before it can cost a query.
 */
export const extractApiKey = (header: string | null) => {
	if (!header) return null;
	const raw = header.startsWith("Bearer ")
		? header.slice(7).trim()
		: header.trim();
	return KEY_PATTERN.test(raw) ? raw : null;
};

/** Safe to render and log. Never the key itself. */
export const describeApiKey = (prefixApiKey: string) => `${prefixApiKey}…`;
