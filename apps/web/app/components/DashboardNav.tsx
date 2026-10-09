import { NavLink, useLocation } from "react-router";

/**
 * The dashboard's left-hand menu. Items not built yet are listed, disabled and
 * marked, rather than linked to a stub page: a route that exists is a route
 * that works (routes.ts).
 */

type TItem =
	| { kind: "link"; label: string; to: string; end?: boolean }
	| { kind: "soon"; label: string }
	| { kind: "signOut"; label: string };

const SECTIONS: { title: string | null; items: TItem[] }[] = [
	{
		title: null,
		items: [{ kind: "link", label: "Overview", to: "/dashboard", end: true }],
	},
	{
		title: "Portfolios",
		items: [
			{ kind: "link", label: "Portfolio Tracking", to: "/dashboard/portfolios" },
			{ kind: "link", label: "Portfolio Builder", to: "/dashboard/builder" },
			{ kind: "link", label: "Strategy Backtests", to: "/dashboard/backtest" },
			{ kind: "link", label: "Liabilities", to: "/dashboard/liabilities" },
			{ kind: "link", label: "Stress Testing", to: "/dashboard/stress" },
		],
	},
	{
		title: "Markets",
		items: [
			{ kind: "link", label: "Security Lookup", to: "/dashboard/securities" },
			{ kind: "link", label: "Treasury Rates", to: "/dashboard/rates" },
			{ kind: "link", label: "Curves", to: "/dashboard/curves" },
			{ kind: "link", label: "Indices", to: "/dashboard/indices" },
			{ kind: "link", label: "Treasury Auctions", to: "/dashboard/auctions" },
			{ kind: "link", label: "On / Off the Run", to: "/dashboard/on-the-run" },
			{ kind: "link", label: "Rich / Cheap", to: "/dashboard/rich-cheap" },
		],
	},
	{
		title: "Trading",
		items: [{ kind: "link", label: "Order Sheets", to: "/dashboard/execution" }],
	},
	{
		title: "Account",
		items: [
			{ kind: "link", label: "Email Alerts", to: "/dashboard/alerts" },
			{ kind: "link", label: "API & MCP", to: "/dashboard/keys" },
			{ kind: "link", label: "Documentation", to: "/docs" },
			{ kind: "link", label: "Billing", to: "/dashboard/billing" },
			{ kind: "signOut", label: "Sign out" },
		],
	},
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
	`block rounded-md px-3 py-1.5 text-sm transition-colors ${
		isActive
			? "bg-primary/10 font-semibold text-primary"
			: "text-slate-700 hover:bg-slate-100 hover:text-neutral-900"
	}`;

const Items = ({ section }: { section: (typeof SECTIONS)[number] }) =>
	section.items.map((item) => (
		<li key={item.label}>
			{item.kind === "link" ? (
				<NavLink className={linkClass} end={item.end} to={item.to}>
					{item.label}
				</NavLink>
			) : item.kind === "signOut" ? (
				<form action="/sign-out" method="post">
					<button
						className={`${linkClass({ isActive: false })} w-full text-left`}
						type="submit"
					>
						{item.label}
					</button>
				</form>
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
	));

/**
 * On a phone the sidebar is a "Menu" disclosure naming the current page, open
 * to the same groups; keyed on the path so following a link closes it. A
 * sideways-scrolling strip hid every section past the first two.
 */
const PhoneNav = () => {
	const { pathname } = useLocation();
	const current = SECTIONS.flatMap((s) => s.items).find(
		(i) =>
			i.kind === "link" && (i.end ? pathname === i.to : pathname.startsWith(i.to)),
	);
	return (
		<details
			className="group rounded-lg border border-slate-200 bg-white md:hidden"
			key={pathname}
		>
			<summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 font-medium text-neutral-900">
				<span>
					<span className="mr-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
						Menu
					</span>
					{current?.label ?? "Dashboard"}
				</span>
				<svg
					aria-hidden="true"
					className="h-4 w-4 text-slate-500 transition-transform group-open:rotate-180"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					viewBox="0 0 24 24"
				>
					<path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			</summary>
			<div className="grid grid-cols-2 gap-x-2 gap-y-4 border-t border-slate-100 p-3">
				{SECTIONS.map((section) => (
					<div key={section.title ?? "top"}>
						{section.title ? (
							<p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
								{section.title}
							</p>
						) : null}
						<ul className="space-y-0.5">
							<Items section={section} />
						</ul>
					</div>
				))}
			</div>
		</details>
	);
};

export const DashboardNav = ({
	organizationName,
}: {
	organizationName: string;
}) => (
	<nav aria-label="Dashboard" className="text-sm">
		<PhoneNav />
		<p className="mb-4 hidden truncate px-3 text-[11px] font-bold uppercase tracking-[0.18em] text-primary md:block">
			{organizationName}
		</p>
		<div className="hidden space-y-5 md:block">
			{SECTIONS.map((section) => (
				<div key={section.title ?? "top"}>
					{section.title ? (
						<p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
							{section.title}
						</p>
					) : null}
					<ul className="space-y-0.5">
						<Items section={section} />
					</ul>
				</div>
			))}
		</div>
	</nav>
);
