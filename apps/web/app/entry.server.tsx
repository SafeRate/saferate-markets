import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import type { AppLoadContext, EntryContext } from "react-router";
import { isRouteErrorResponse, ServerRouter } from "react-router";

/**
 * Catches every error React Router handles server-side, in a loader, an action,
 * or a render.
 *
 * This hook has to exist from day one. React Router catches loader and action
 * errors internally and RETURNS a 500 rather than throwing, so without it the
 * only thing the Worker can observe is a status code with no message and no
 * stack. The consumer app spent an incident discovering that: every recorded row
 * read "HTTP 500 from <path>" with a null stack, and diagnosis needed
 * Cloudflare's Workers Logs and its 7-day retention window. The exception was
 * always available right here; nothing was listening.
 *
 * TODO(observability): route these into a durable D1 sink once the errors table
 * exists, so they outlive the log retention window. Console-only for now, in ONE
 * place, so there is a single call site to change.
 */
export const handleError = (
	error: unknown,
	{ request }: { request: Request; context: AppLoadContext },
) => {
	// A thrown Response is control flow: redirects, 404s, deliberate 503s.
	// Recording them recreates exactly the noise an error sink exists to cut through.
	if (error instanceof Response) return;

	// React Router also raises its own ErrorResponse objects, which are NOT
	// `instanceof Response` and slip past the check above. The one that shows up
	// in production within minutes: a bot POSTs to a route that exports no
	// action, the framework throws a 405, and it lands as a useless
	// "/: [object Object]" row. Framework-raised statuses are control flow too.
	if (isRouteErrorResponse(error)) return;

	// The client went away mid-render. Their disconnect is not our failure, and
	// crawlers abandon requests routinely.
	if (request.signal.aborted) return;

	console.error("[handleError]", new URL(request.url).pathname, error);
};

const ABORT_DELAY = 10_000;

const handleRequest = async (
	request: Request,
	responseStatusCode: number,
	responseHeaders: Headers,
	routerContext: EntryContext,
	_loadContext: AppLoadContext,
) => {
	let shellRendered = false;
	// The upstream template reassigns `responseStatusCode` from inside onError.
	// noParameterAssign forbids that, and a local is clearer anyway: it makes it
	// obvious that a render error downgrades the status the caller asked for.
	let statusCode = responseStatusCode;
	const userAgent = request.headers.get("user-agent");

	const body = await renderToReadableStream(
		<ServerRouter context={routerContext} url={request.url} />,
		{
			signal: AbortSignal.timeout(ABORT_DELAY),
			onError(error: unknown) {
				statusCode = 500;
				// Log only AFTER the shell renders: errors thrown before that point
				// are already surfaced through the returned status, and logging them
				// twice makes a single failure look like two.
				if (shellRendered) console.error(error);
			},
		},
	);
	shellRendered = true;

	// A bot needs the whole document to index it, and SPA-mode hydration is
	// invisible to most crawlers. A human gets the stream.
	if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
		await body.allReady;
	}

	responseHeaders.set("Content-Type", "text/html");
	return new Response(body, {
		headers: responseHeaders,
		status: statusCode,
	});
};

export default handleRequest;
