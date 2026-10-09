import { TRIAL } from "@markets/schema";
import { Link } from "react-router";

/**
 * The opening of every public strategy page after its answer: what the
 * numbers are (and are not), and the one action the page offers, placed where
 * a reader decides rather than at the bottom. One component so the disclaimer
 * reads the same on every page; Dylan's wording, 2026-10-08.
 */
export const StrategyDisclaimer = ({
	trackLabel,
	trackTo,
	note = `Free ${TRIAL.days}-day trial, no card`,
}: {
	trackLabel: string;
	trackTo: string;
	/** The line under the button; the trial unless the action is free anyway. */
	note?: string;
}) => (
	<div className="mt-6 flex max-w-3xl flex-col gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
		<p className="text-sm text-slate-600">
			These are calculations derived from publicly available U.S. Treasury data.
			They are not investment advice or a recommendation to buy or sell any
			security.
		</p>
		<div className="shrink-0 text-center">
			<Link
				className="inline-block rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
				to={trackTo}
			>
				{trackLabel}
			</Link>
			<p className="mt-1 text-xs text-slate-500">{note}</p>
		</div>
	</div>
);
