import { PRODUCT_NAME, SITE_HOSTS } from "@markets/schema";
import { Link } from "react-router";
import { JsonLd } from "@/components/JsonLd";
import { breadcrumbJsonLd, ORGANIZATION_REF } from "@/lib/jsonLd";
import type { Route } from "./+types/strategies";

const PATH = "/strategies";
const TITLE = "Treasury Strategies";

export const meta: Route.MetaFunction = () => [
	{ title: `${TITLE}: Ladders and Bill Rolls, Rebuilt Daily | ${PRODUCT_NAME}` },
	{
		name: "description",
		content:
			"Rule-based U.S. Treasury strategies rebuilt every business day from end-of-day prices: a 5-year Treasury ladder and T-bill reinvestment, with today's securities, yields, income and what rate moves do to each.",
	},
];

/**
 * The hub the nav's "Strategies" opens: every public strategy page, one line
 * each, so a reader and a crawler reach them from one place. Pages are listed
 * only once they are live; a strategy that is planned is not a link.
 */
const STRATEGY_PAGES = [
	{
		path: "/strategies/t-bill-reinvestment",
		name: "T-Bill Reinvestment: Roll or Lock In a Year?",
		summary:
			"What the bill market is pricing for 3-month rates over the next year, the rate rolling 4-, 13- or 26-week bills needs to catch the 52-week bill, and who comes out ahead if rates rise, stay flat or fall.",
	},
	{
		path: "/strategies/ladder-5y",
		name: "5-Year Treasury Ladder",
		summary:
			"One note maturing each year for five years, chosen by a published rule from today's prices: the rungs, the ladder's yield, duration and DV01, the income calendar, and what rate moves do to its value.",
	},
] as const;

export default function Strategies() {
	const web = SITE_HOSTS.production.web;
	return (
		<main className="mx-auto max-w-6xl px-6 py-16">
			<JsonLd
				data={{
					"@context": "https://schema.org",
					"@type": "CollectionPage",
					"@id": `${web}${PATH}#page`,
					url: `${web}${PATH}`,
					name: TITLE,
					publisher: ORGANIZATION_REF,
					mainEntity: {
						"@type": "ItemList",
						itemListElement: STRATEGY_PAGES.map((page, i) => ({
							"@type": "ListItem",
							position: i + 1,
							name: page.name,
							url: `${web}${page.path}`,
						})),
					},
				}}
			/>
			<JsonLd
				data={breadcrumbJsonLd([
					{ name: PRODUCT_NAME, path: "/" },
					{ name: "Strategies", path: PATH },
				])}
			/>
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				Strategies
			</p>
			<h1 className="mt-3 text-4xl font-semibold tracking-tight text-neutral-900">
				{TITLE}
			</h1>
			<p className="mt-5 max-w-3xl text-lg leading-relaxed text-slate-700">
				Rule-based Treasury strategies, rebuilt every business day from Treasury's
				end-of-day prices. Each page states its rule, today's securities and
				figures, and what rate moves would do, and each can be tracked as a
				portfolio in {PRODUCT_NAME}.
			</p>
			<ul className="mt-10 grid max-w-4xl grid-cols-1 gap-4 md:grid-cols-2">
				{STRATEGY_PAGES.map((page) => (
					<li key={page.path}>
						<Link
							className="block h-full rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-primary/50"
							to={page.path}
						>
							<h2 className="font-semibold text-neutral-900">{page.name}</h2>
							<p className="mt-2 text-sm leading-relaxed text-slate-600">
								{page.summary}
							</p>
							<span className="mt-4 inline-block text-sm font-semibold text-primary">
								Today's figures →
							</span>
						</Link>
					</li>
				))}
			</ul>
			<p className="mt-10 max-w-3xl text-sm text-slate-500">
				These are calculations derived from publicly available U.S. Treasury data.
				They are not investment advice or a recommendation to buy or sell any
				security. How the curve behind them is built:{" "}
				<Link
					className="text-primary underline underline-offset-4"
					to="/methodology/treasury-curve"
				>
					Treasury curve methodology
				</Link>
				.
			</p>
		</main>
	);
}
