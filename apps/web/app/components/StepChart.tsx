import { useEffect, useRef, useState } from "react";

/**
 * A step chart of rates over a horizon: one flat step per holding period, so
 * a roll of bills reads as the sequence of bills it is, each held at its own
 * rate until it matures. A dashed reference line (a rate locked in for the
 * whole horizon) is drawn across it.
 *
 * Drawn at its container's width, as LineChart is (measured with a
 * ResizeObserver, 720 until the first measurement on server and client), so
 * the labels stay their real size on a phone.
 */
type TStep = {
	startYears: number;
	endYears: number;
	rate: number;
	label: string;
};

export const StepChart = ({
	steps,
	reference,
	format,
	height = 220,
}: {
	steps: TStep[];
	reference: { rate: number; label: string };
	format: (value: number) => string;
	height?: number;
}) => {
	const box = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(720);
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const measure = () => {
			const w = Math.round(el.clientWidth);
			if (w > 0) setWidth(w);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	if (steps.length === 0) return null;

	const pad = { top: 14, right: 14, bottom: 30, left: 52 };
	const horizon = Math.max(...steps.map((s) => s.endYears));
	const rates = [...steps.map((s) => s.rate), reference.rate];
	const low = Math.min(...rates);
	const high = Math.max(...rates);
	const margin = Math.max((high - low) * 0.25, 0.05);
	const min = low - margin;
	const max = high + margin;
	const x = (years: number) =>
		pad.left + (years / horizon) * (width - pad.left - pad.right);
	const y = (rate: number) =>
		pad.top + (1 - (rate - min) / (max - min)) * (height - pad.top - pad.bottom);

	const path = steps
		.map((s, i) => {
			const start = `${i === 0 ? "M" : "L"}${x(s.startYears).toFixed(1)},${y(s.rate).toFixed(1)}`;
			return `${start} L${x(s.endYears).toFixed(1)},${y(s.rate).toFixed(1)}`;
		})
		.join(" ");
	// Label every step when there is room, else roughly every fourth.
	const every = steps.length <= 6 ? 1 : Math.ceil(steps.length / 4);
	const ticks = [
		min + (max - min) * 0.2,
		(min + max) / 2,
		max - (max - min) * 0.2,
	];

	return (
		<div className="w-full" ref={box}>
			<svg
				aria-label={`${steps.length} step${steps.length === 1 ? "" : "s"}, against ${reference.label}`}
				className="block w-full"
				height={height}
				role="img"
				viewBox={`0 0 ${width} ${height}`}
			>
				{ticks.map((t) => (
					<g key={t}>
						<line
							className="stroke-slate-100"
							x1={pad.left}
							x2={width - pad.right}
							y1={y(t)}
							y2={y(t)}
						/>
						<text
							className="fill-slate-500 text-[11px]"
							dominantBaseline="middle"
							textAnchor="end"
							x={pad.left - 6}
							y={y(t)}
						>
							{format(t)}
						</text>
					</g>
				))}
				{steps.map((s, i) => (
					<g key={s.startYears}>
						<line
							className="stroke-slate-200"
							strokeDasharray="2 3"
							x1={x(s.startYears)}
							x2={x(s.startYears)}
							y1={pad.top}
							y2={height - pad.bottom}
						/>
						{i % every === 0 ? (
							<text
								className="fill-slate-500 text-[11px]"
								textAnchor={i === 0 ? "start" : "middle"}
								x={x(s.startYears)}
								y={height - pad.bottom + 16}
							>
								{s.label}
							</text>
						) : null}
					</g>
				))}
				<line
					className="stroke-slate-400"
					strokeDasharray="6 4"
					strokeWidth={1.5}
					x1={x(0)}
					x2={x(horizon)}
					y1={y(reference.rate)}
					y2={y(reference.rate)}
				/>
				<path className="fill-none stroke-primary" d={path} strokeWidth={2.5} />
			</svg>
			<div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-600">
				<span className="flex items-center gap-1.5">
					<span className="inline-block h-0.5 w-5 bg-primary" />
					Each bill, at the rate priced in for it
				</span>
				<span className="flex items-center gap-1.5">
					<span className="inline-block w-5 border-t-2 border-dashed border-slate-400" />
					{reference.label}
				</span>
			</div>
		</div>
	);
};
