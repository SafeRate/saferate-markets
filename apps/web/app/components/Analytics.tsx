import { useEffect } from "react";
import { useLocation } from "react-router";
import {
	type TResolvedTrackingTool,
	startTrackingTool,
	stopTrackingTool,
	trackingToolsForPath,
} from "@/lib/analytics";

/**
 * Loads the analytics tools the server said are permitted, on the pages where
 * they are allowed.
 *
 * Renders nothing. It exists for one reason that a plain script tag cannot
 * cover: React Router does not re-run the root loader on a client-side
 * navigation, so a tag emitted in the server-rendered HTML would still be live
 * after the visitor clicked from the pricing page through to /dashboard — which
 * is the single page a session recorder must never see. Re-deciding in an
 * effect keyed on the pathname is what closes that.
 *
 * The server has already applied the opt-out cookie, the GPC header and the
 * environment config, so `tools` arriving non-empty means "permitted in
 * principle". This component only decides "permitted HERE".
 *
 * Which is why the measurement ids DO travel to /dashboard and /sign-in even
 * though nothing loads there. They have to: a visitor who lands on the
 * dashboard and clicks back out to a marketing page would otherwise have no
 * config to start with, and re-fetching the root loader to get it is a
 * round trip to avoid a value that is public in the page source anyway. What
 * matters is that nothing is STARTED, and that is decided here on every path.
 */
const Analytics = ({ tools }: { tools: TResolvedTrackingTool[] }) => {
	const location = useLocation();
	const pathname = location.pathname;

	useEffect(() => {
		if (tools.length === 0) return;
		// The path rule lives in trackingToolsForPath, which delegates to the
		// schema. Re-deriving "is this public" here would be a second copy of the
		// one rule that keeps a session recorder off the dashboard.
		const allowed = new Set(
			trackingToolsForPath(tools, pathname).map((r) => r.tool.id),
		);
		for (const resolved of tools) {
			if (allowed.has(resolved.tool.id)) startTrackingTool(resolved);
			else stopTrackingTool(resolved);
		}
	}, [tools, pathname]);

	return null;
};

export default Analytics;
