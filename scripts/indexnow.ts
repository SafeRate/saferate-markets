/**
 * Submit every public page of saferate.markets to IndexNow.
 *
 *   bun scripts/indexnow.ts            submit
 *   bun scripts/indexnow.ts --dry-run  print what would be sent
 *
 * Run by deploy-web.sh after a PRODUCTION deploy, and safe to run by hand. The
 * pages are lib/publicPages.ts's list, the same as the sitemap and the markdown
 * twins, so a page cannot be in the sitemap and missing here.
 *
 * Checks the key file is live first (a new deploy takes a minute to reach
 * every server): IndexNow fetches it to prove ownership, and a submission whose
 * key it cannot read is refused with a 403. No secret is involved.
 */
import { INDEXNOW_KEY } from "../apps/web/app/lib/indexNow";
import { PUBLIC_TWIN_PATHS } from "../apps/web/app/lib/publicPages";

const HOST = "saferate.markets";
const ORIGIN = `https://${HOST}`;
const KEY_LOCATION = `${ORIGIN}/${INDEXNOW_KEY}.txt`;
const ENDPOINT = "https://api.indexnow.org/indexnow";
const dryRun = process.argv.includes("--dry-run");

const urlList = PUBLIC_TWIN_PATHS.map((path) => `${ORIGIN}${path}`);
const payload = {
	host: HOST,
	key: INDEXNOW_KEY,
	keyLocation: KEY_LOCATION,
	urlList,
};

if (dryRun) {
	console.info(JSON.stringify(payload, null, 2));
	process.exit(0);
}

const keyIsLive = async () => {
	for (let attempt = 0; attempt < 12; attempt += 1) {
		const response = await fetch(`${KEY_LOCATION}?v=${Date.now()}`).catch(
			() => null,
		);
		if (response?.ok && (await response.text()).trim() === INDEXNOW_KEY)
			return true;
		await Bun.sleep(10_000);
	}
	return false;
};

if (!(await keyIsLive())) {
	console.error(
		`IndexNow: ${KEY_LOCATION} does not serve the key yet; nothing submitted.`,
	);
	process.exit(1);
}

const response = await fetch(ENDPOINT, {
	method: "POST",
	headers: { "Content-Type": "application/json; charset=utf-8" },
	body: JSON.stringify(payload),
});
// 200 accepted; 202 accepted, key validation pending. Anything else is a
// refusal worth reading: 400 bad request, 403 key not valid, 422 URLs not on
// the host, 429 too many requests.
const meaning: Record<number, string> = {
	200: "accepted",
	202: "accepted (key validation pending)",
	400: "bad request",
	403: "key not valid for this host",
	422: "URLs do not belong to the host",
	429: "too many requests",
};
console.info(
	`IndexNow: ${urlList.length} pages -> ${response.status} ${meaning[response.status] ?? (await response.text()).slice(0, 200)}`,
);
process.exit(response.status === 200 || response.status === 202 ? 0 : 1);
