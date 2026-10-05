/**
 * IndexNow (https://www.indexnow.org): tell Bing, Yandex and the other
 * participating engines which pages changed, instead of waiting for a crawl.
 *
 * THE KEY IS PUBLIC BY DESIGN. IndexNow proves ownership by fetching it from
 * the site itself, at `/<key>.txt` (apps/web/public), so it is a constant here,
 * not a secret in Doppler. Generated on indexnow.org by Dylan, 2026-10-05.
 * tests/indexNow.test.ts holds the public file to this value.
 *
 * Two senders: Cloudflare's Crawler Hints (zone setting, on since 2026-10-05)
 * signals changes it sees at the edge; scripts/indexnow.ts submits every public
 * page explicitly after each production web deploy.
 */
export const INDEXNOW_KEY = "06825bd517af4b09a70bb503c327eb69";
