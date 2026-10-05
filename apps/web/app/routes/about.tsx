import { CONTACT_ADDRESS, PRODUCT_NAME } from "@markets/schema";
import type { Route } from "./+types/about";

export const meta: Route.MetaFunction = () => [
	{ title: `About — ${PRODUCT_NAME}` },
	{
		name: "description",
		content:
			"Safe Rate Markets is built by Shima Rayej and Dylan Hall, who started Safe Rate in mortgages and expanded into U.S. Treasuries, the market every other rate is priced from.",
	},
];

/**
 * Who builds Markets. Every fact about the founders and the company is one
 * saferate.com already publishes (saferate-ai apps/consumer routes/about.tsx
 * and content/investors/12-why-us.md, read 2026-10-05), so the two sites tell
 * one story; Dylan added the framing (a passion for fixed income, mortgages
 * first, then Treasuries; Shima's autonomy and fixed income portfolio
 * management, Dylan's technology and calculation layer). Nothing personal
 * beyond what saferate.com's About page says. The photo is saferate.com's.
 */

const FOUNDERS = [
	{
		name: "Shima Rayej",
		role: "Co-founder",
		linkedin: "https://www.linkedin.com/in/shima-rayej/",
		bio: [
			"Shima built AI systems for autonomous military vehicles before business school, then structured and priced post-crisis mortgage products on Wall Street.",
			"At Markets she brings the practitioner's view of fixed income portfolio management: how a Treasury book is built, hedged, stress-tested and judged against a benchmark.",
		],
	},
	{
		name: "Dylan Hall",
		role: "Co-founder",
		linkedin: "https://www.linkedin.com/in/dylan-m-hall/",
		bio: [
			"Dylan is a three-time fintech CTO. He worked on an unmanned fighter jet, and was a research assistant on House of Debt, Mian and Sufi's account of the 2008 mortgage crisis.",
			"At Markets he builds the technology and the calculation layer: the curve fits, pricing and analytics, the indices, and the API and MCP server behind them.",
		],
	},
];

const STORY = [
	{
		year: "2018",
		text:
			"The UChicago Innovation Fund invests in Safe Rate: a mortgage whose rate falls automatically when home values in the borrower's zip code fall.",
	},
	{
		year: "2020",
		text:
			"The Safe Rate Mortgage launches, for borrowers facing severe home price declines. The Economist covers it that January.",
	},
	{
		year: "2022",
		text:
			"Safe Rate launches a mortgage bank (NMLS #1590949): warehouse line, loan sales, state audits, and loans originated by the founders themselves.",
	},
	{
		year: "2026",
		text:
			"Safe Rate AI launches for mortgage shoppers, and Safe Rate Markets for the U.S. Treasury market.",
	},
];

export default function About() {
	return (
		<main className="mx-auto max-w-6xl px-6 py-16">
			<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				About
			</p>
			<h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-neutral-900">
				Built by people who love fixed income.
			</h1>
			<p className="mt-4 max-w-3xl text-lg leading-relaxed text-slate-600">
				Safe Rate started in mortgages: designing a new kind of mortgage, then
				running a mortgage bank and originating loans ourselves. Every one of those
				rates starts from the same place, the U.S. Treasury curve. So we went to the
				source, and built the tools we wanted for the world's largest government
				bond market.
			</p>

			<section className="mt-12 grid grid-cols-1 items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
				<div>
					<h2 className="text-2xl font-semibold tracking-tight text-neutral-900">
						Why Treasuries
					</h2>
					<div className="mt-4 space-y-4 text-slate-700">
						<p>
							Treasuries are the benchmark every other dollar fixed income security is
							priced against, and the data behind them is public: Treasury publishes
							the prices, the debt, the auctions. Yet the tools to use it well, from a
							fitted curve to attribution, stress tests and an index to measure
							against, have sat behind terminals and data licenses priced for the
							largest institutions.
						</p>
						<p>
							Markets puts them in one place, built only on those primary sources, so a
							portfolio manager, an advisor, a treasurer or an engineer can manage a
							Treasury portfolio with institutional-grade tools, and rebuild every
							number we show.
						</p>
					</div>
				</div>
				<figure>
					<img
						alt="Shima Rayej and Dylan Hall at the London School of Economics"
						className="aspect-[4/3] w-full rounded-2xl object-cover shadow-md"
						height={879}
						loading="lazy"
						src="/images/founders.jpg"
						width={1200}
					/>
					<figcaption className="mt-2 text-xs text-slate-500">
						Shima and Dylan at the London School of Economics, during their MBA at the
						University of Chicago.
					</figcaption>
				</figure>
			</section>

			<section className="mt-16">
				<h2 className="text-2xl font-semibold tracking-tight text-neutral-900">
					The founders
				</h2>
				<p className="mt-2 max-w-3xl text-slate-600">
					Shima and Dylan met during their MBA at the University of Chicago, by way
					of a study abroad at the London School of Economics, and have built Safe
					Rate together since.
				</p>
				<div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
					{FOUNDERS.map((f) => (
						<article
							className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
							key={f.name}
						>
							<div className="flex flex-wrap items-baseline justify-between gap-2">
								<h3 className="text-lg font-semibold text-neutral-900">{f.name}</h3>
								<span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
									{f.role}
								</span>
							</div>
							{f.bio.map((paragraph) => (
								<p
									className="mt-3 text-sm leading-relaxed text-slate-700"
									key={paragraph}
								>
									{paragraph}
								</p>
							))}
							<a
								className="mt-4 inline-block text-sm font-semibold text-primary underline underline-offset-4"
								href={f.linkedin}
								rel="noopener noreferrer"
								target="_blank"
							>
								LinkedIn
							</a>
						</article>
					))}
				</div>
			</section>

			<section className="mt-16">
				<h2 className="text-2xl font-semibold tracking-tight text-neutral-900">
					From mortgages to Treasuries
				</h2>
				<ol className="mt-6 space-y-4 border-l border-slate-200 pl-6">
					{STORY.map((s) => (
						<li className="relative" key={s.year}>
							<span className="absolute -left-[31px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
							<p className="text-sm font-semibold text-primary">{s.year}</p>
							<p className="mt-0.5 max-w-3xl text-sm leading-relaxed text-slate-700">
								{s.text}
							</p>
						</li>
					))}
				</ol>
				<p className="mt-6 text-sm text-slate-600">
					More about Safe Rate at{" "}
					<a
						className="text-primary underline underline-offset-4"
						href="https://saferate.com/about"
					>
						saferate.com
					</a>
					.
				</p>
			</section>

			<section className="mt-16 rounded-xl border border-slate-200 bg-slate-50 p-6">
				<h2 className="font-semibold text-neutral-900">Get in touch</h2>
				<p className="mt-2 text-sm text-slate-600">
					Questions, a firm-wide plan, or a dataset you need: write to us at{" "}
					<span className="font-medium text-slate-800">{CONTACT_ADDRESS}</span>.
				</p>
			</section>
		</main>
	);
}
