import { NavLink } from "react-router";

/**
 * The dashboard's left-hand menu. Items not built yet are listed, disabled and
 * marked, rather than linked to a stub page: a route that exists is a route
 * that works (routes.ts).
 */

type TItem =
	| { kind: "link"; label: string; to: string; end?: boolean }
	| { kind: "soon"; label: string };

const SECTIONS: { title: string | null; items: TItem[] }[] = [
	{
		title: null,
		items: [{ kind: "link", label: "Overview", to: "/dashboard", end: true }],
	},
	{
		title: "Portfolios",
		items: [
			{ kind: "link", label: "Portfolio Tracking", to: "/dashboard/portfolios" },
			{ kind: "soon", label: "Portfolio Builder" },
			{ kind: "link", label: "Stress Testing", to: "/dashboard/stress" },
		],
	},
	{
		title: "Markets",
		items: [
			{ kind: "soon", label: "Treasury Auctions" },
			{ kind: "link", label: "Treasury Rates", to: "/dashboard/rates" },
		],
	},
	{ title: "Trading", items: [{ kind: "soon", label: "Trade Execution" }] },
	{
		title: "Account",
		items: [
			{ kind: "link", label: "API & MCP", to: "/dashboard/keys" },
			{ kind: "link", label: "Billing", to: "/dashboard/billing" },
		],
	},
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
	`block rounded-md px-3 py-1.5 text-sm transition-colors ${
		isActive
			? "bg-primary/10 font-semibold text-primary"
			: "text-slate-700 hover:bg-slate-100 hover:text-neutral-900"
	}`;

export const DashboardNav = ({
	organizationName,
}: {
	organizationName: string;
}) => (
	<nav aria-label="Dashboard" className="text-sm">
		<p className="mb-4 hidden truncate px-3 text-[11px] font-bold uppercase tracking-[0.18em] text-primary md:block">
			{organizationName}
		</p>
		<div className="flex gap-6 overflow-x-auto pb-2 md:block md:space-y-5 md:overflow-visible md:pb-0">
			{SECTIONS.map((section) => (
				<div className="shrink-0" key={section.title ?? "top"}>
					{section.title ? (
						<p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
							{section.title}
						</p>
					) : null}
					<ul className="flex gap-1 md:block md:space-y-0.5">
						{section.items.map((item) => (
							<li className="shrink-0" key={item.label}>
								{item.kind === "link" ? (
									<NavLink className={linkClass} end={item.end} to={item.to}>
										{item.label}
									</NavLink>
								) : (
									<span
										aria-disabled="true"
										className="flex items-center gap-2 whitespace-nowrap px-3 py-1.5 text-sm text-slate-400"
									>
										{item.label}
										<span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
											Soon
										</span>
									</span>
								)}
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	</nav>
);
