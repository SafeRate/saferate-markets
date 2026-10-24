/**
 * True for a GET or HEAD that carries a body. The Worker answers these 400
 * before React Router sees them (workers/app.ts).
 *
 * workerd accepts such a request, but React Router rebuilds it with
 * `new Request(url, { body: request.body, method })` (stripIndexParam), and the
 * platform throws "Request with a GET or HEAD method cannot have a body". On
 * 2026-10-24 between 03:22 and 03:25 UTC a scanner probing the site's ports
 * turned that into 15 HTTP 500s on `/`, each a `[handleError]` at
 * stripIndexParam. No browser sends this, so a 400 costs no visitor anything.
 *
 * Ported from saferate.com (saferate-ai apps/consumer/app/lib/bodylessMethod.server.ts),
 * which learned that the framing headers are not enough: those requests here
 * arrived with `content-length: 0`, and over HTTP/2 or HTTP/3 a body travels
 * in DATA frames with no Content-Length or Transfer-Encoding to see. So the
 * last check is the throw condition itself: the constructor rejects a GET/HEAD
 * exactly when `request.body` is non-null. Reading `.body` does not consume it.
 */
export const isBodylessMethodWithBody = (request: Request) => {
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	if (
		Number(request.headers.get("content-length") ?? "0") > 0 ||
		request.headers.has("transfer-encoding")
	)
		return true;
	return request.body !== null;
};
