import { FREE_TIER } from "@markets/schema";
import { useRouteLoaderData } from "react-router";

/**
 * The demo is read-only (lib/session.server.ts requireDashboard refuses every
 * write from an account without a paid plan). The dashboard layout's loader
 * says whether this is the demo; pages ask here rather than threading it
 * through every loader, and put the notice where a form would have been.
 */
export const useIsDemo = () =>
	(
		useRouteLoaderData("routes/dashboard.layout") as
			| { isDemo?: boolean }
			| undefined
	)?.isDemo === true;

export const DemoNotice = ({ to }: { to: string }) => (
	<p className="mt-6 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-slate-700">
		This is the read-only demo.{" "}
		<a
			className="font-medium text-primary underline underline-offset-4"
			href="/dashboard/portfolios#new"
		>
			Start your own portfolio
		</a>{" "}
		(free under ${FREE_TIER.maxValueUsd.toLocaleString("en-US")}) or{" "}
		<a
			className="font-medium text-primary underline underline-offset-4"
			href="/dashboard/billing"
		>
			subscribe
		</a>{" "}
		to {to}.
	</p>
);

/** Its children for a paying account; the notice in the demo. */
export const WriteGate = ({
	to,
	children,
}: {
	to: string;
	children: React.ReactNode;
}) => (useIsDemo() ? <DemoNotice to={to} /> : children);
