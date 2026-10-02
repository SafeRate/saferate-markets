import { useEffect, useState } from "react";

/**
 * The notice a long server-side run shows while its page loads (Strategy
 * Backtests, Stress Testing): a spinner, an indeterminate bar, the seconds so
 * far against how long it can take, and a request to stay on the page.
 *
 * Runs are synchronous for now, inside the page's own request; leaving the page
 * drops the response, so the result can be lost (a backtest may still land in
 * its server cache, which is why the page says "can"). So while one runs, closing or reloading the tab asks
 * first (the browser's own prompt; its wording is the browser's). A queue that
 * survives navigation is planned, not built.
 */
export const RunningNotice = ({
	title,
	upToSeconds,
}: {
	title: string;
	upToSeconds: number;
}) => {
	const [elapsed, setElapsed] = useState(0);
	useEffect(() => {
		const started = Date.now();
		const tick = setInterval(
			() => setElapsed(Math.floor((Date.now() - started) / 1000)),
			500,
		);
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
		};
		window.addEventListener("beforeunload", warn);
		return () => {
			clearInterval(tick);
			window.removeEventListener("beforeunload", warn);
		};
	}, []);
	return (
		<section
			aria-live="polite"
			className="mt-6 overflow-hidden rounded-xl border border-primary/25 bg-gradient-to-br from-primary/10 via-white to-sky-50 shadow-sm"
		>
			<div className="flex items-start gap-4 p-5">
				<svg
					aria-hidden="true"
					className="mt-0.5 h-8 w-8 shrink-0 animate-spin text-primary"
					fill="none"
					viewBox="0 0 24 24"
				>
					<circle
						className="opacity-20"
						cx="12"
						cy="12"
						r="10"
						stroke="currentColor"
						strokeWidth="3"
					/>
					<path
						d="M22 12a10 10 0 0 0-10-10"
						stroke="currentColor"
						strokeLinecap="round"
						strokeWidth="3"
					/>
				</svg>
				<div className="min-w-0 flex-1">
					<p className="font-semibold text-neutral-900">{title}</p>
					<p className="mt-1 text-sm text-slate-600">
						This can take up to {upToSeconds} seconds.{" "}
						<span className="font-medium text-slate-800">
							Please stay on this page
						</span>{" "}
						until it finishes; leaving early can lose the result.
					</p>
					<p className="tabular mt-2 text-xs text-slate-500">{elapsed}s elapsed</p>
				</div>
			</div>
			<div className="h-1 w-full overflow-hidden bg-primary/10">
				<div className="h-full w-1/3 animate-[running-bar_1.4s_ease-in-out_infinite] rounded-full bg-primary/70" />
			</div>
		</section>
	);
};
