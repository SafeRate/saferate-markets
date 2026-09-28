import { PRODUCT_NAME } from "@markets/schema";
import SafeRateLogo from "@/components/SafeRateLogo";

/**
 * Header and footer, built like saferate.com's (saferate-ai/apps/consumer
 * components/Header.tsx and Footer.tsx): white bar, slate rule, the Safe Rate
 * lockup, slate-600 nav, pill buttons in the brand primary. "Markets" sits
 * beside the lockup so the product is named without a second logo.
 */
export const SiteHeader = () => (
	<header className="sticky top-0 z-50 border-b border-slate-200 bg-white">
		<nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
			<a
				aria-label={`${PRODUCT_NAME} home`}
				className="flex items-center gap-3"
				href="/"
			>
				<SafeRateLogo className="h-7 w-auto" />
				<span className="border-l border-slate-200 pl-3 text-sm font-semibold uppercase tracking-[0.14em] text-primary">
					Markets
				</span>
			</a>
			<div className="flex items-center gap-6 text-sm font-medium text-slate-600">
				<a className="transition-colors hover:text-slate-900" href="/docs/indices">
					Indices
				</a>
				<a className="transition-colors hover:text-slate-900" href="/docs">
					Docs
				</a>
				<a className="transition-colors hover:text-slate-900" href="/pricing">
					Pricing
				</a>
				<a
					className="rounded-full bg-primary px-4 py-2 font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
					href="/dashboard"
				>
					Dashboard
				</a>
			</div>
		</nav>
	</header>
);

export const SiteFooter = () => (
	<footer className="border-t border-slate-200 bg-white px-6 py-10">
		<div className="mx-auto flex max-w-6xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
			<a aria-label="Safe Rate" href="https://saferate.com">
				<SafeRateLogo className="h-6 w-auto" />
			</a>
			<p className="max-w-xl text-[13px] leading-relaxed text-slate-500">
				Source data is published by the U.S. Department of the Treasury. Figures are
				end-of-day records, not live prices, and nothing here is investment advice.
			</p>
			<span className="text-[13px] text-slate-400">
				© {new Date().getFullYear()} Safe Rate Inc.
			</span>
		</div>
	</footer>
);
