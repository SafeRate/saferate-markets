import { useEffect, useRef, useState } from "react";

/**
 * A small dependency-free SVG line chart: one or two series on a shared y axis,
 * dates along x. Enough for a growth-of-$100 comparison; not a charting library.
 *
 * DRAWN AT ITS CONTAINER'S WIDTH. The viewBox width follows the measured box
 * (720 until the first measurement, the same on server and client), so labels
 * stay at their real size in a half-width card or on a phone. It once had a
 * fixed 720 viewBox and a 480px minimum, which put a scrollbar under every
 * chart narrower than that and hid its right-hand label (Curves, 2026-10-02).
 */

type TSeries = {
	label: string;
	className: string;
	points: { date: string; value: number | null }[];
};

export const LineChart = ({
	series,
	format,
	height = 220,
}: {
	series: TSeries[];
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
	const all = series.flatMap((s) =>
		s.points.filter((p) => p.value !== null).map((p) => p.value as number),
	);
	const dates = series[0]?.points.map((p) => p.date) ?? [];
	if (all.length < 2 || dates.length < 2) {
		return (
			<p className="text-sm text-slate-500">Not enough history to chart yet.</p>
		);
	}
	const pad = { top: 12, right: 12, bottom: 24, left: 56 };
	const min = Math.min(...all);
	const max = Math.max(...all);
	const span = max - min || Math.abs(max) * 0.01 || 1;
	const x = (i: number) =>
		pad.left + (i / (dates.length - 1)) * (width - pad.left - pad.right);
	const y = (v: number) =>
		pad.top + (1 - (v - min) / span) * (height - pad.top - pad.bottom);
	const ticks = [min, min + span / 2, max];
	const path = (points: TSeries["points"]) =>
		points
			.map((p, i) =>
				p.value === null ? null : `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`,
			)
			.filter(Boolean)
			.map((xy, i) => `${i === 0 ? "M" : "L"}${xy}`)
			.join(" ");
	return (
		<div className="min-w-0" ref={box}>
			<svg
				aria-label="Chart"
				className="block w-full"
				height={height}
				role="img"
				viewBox={`0 0 ${width} ${height}`}
			>
				{ticks.map((t) => (
					<g key={t}>
						<line
							className="stroke-slate-200"
							x1={pad.left}
							x2={width - pad.right}
							y1={y(t)}
							y2={y(t)}
						/>
						<text
							className="fill-slate-500 text-[10px]"
							textAnchor="end"
							x={pad.left - 6}
							y={y(t) + 3}
						>
							{format(t)}
						</text>
					</g>
				))}
				{[0, dates.length - 1].map((i) => (
					<text
						className="fill-slate-500 text-[10px]"
						key={i}
						textAnchor={i === 0 ? "start" : "end"}
						x={x(i)}
						y={height - 6}
					>
						{dates[i]}
					</text>
				))}
				{series.map((s) => (
					<path
						className={`fill-none stroke-2 ${s.className}`}
						d={path(s.points)}
						key={s.label}
					/>
				))}
			</svg>
			<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
				{series.map((s) => (
					<span className="flex items-center gap-1.5" key={s.label}>
						<svg aria-hidden="true" height="4" width="16">
							<line
								className={`stroke-2 ${s.className}`}
								x1="0"
								x2="16"
								y1="2"
								y2="2"
							/>
						</svg>
						{s.label}
					</span>
				))}
			</div>
		</div>
	);
};
