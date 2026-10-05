import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
	useRouteLoaderData,
} from "react-router";
import { PRODUCT_NAME, SITE_HOSTS } from "@markets/schema";
import Analytics from "@/components/Analytics";
import { JsonLd } from "@/components/JsonLd";
import { SITE_JSON_LD } from "@/lib/jsonLd";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { resolveTrackingTools } from "@/lib/analytics";
import { canonicalOrigin } from "@/lib/canonicalOrigin";
import { isAnalyticsPermitted } from "@/lib/privacyChoices";
import type { Route } from "./+types/root";
import "@/app.css";

/**
 * The analytics tools this visitor may receive: configured for this
 * environment, and not refused by an opt-out cookie or Global Privacy Control.
 * Read here, server side, so a refusal means the script is never sent. WHERE
 * they may run is decided again on every navigation, in <Analytics>.
 */
export const loader = ({ request, context }: Route.LoaderArgs) => ({
	trackingTools: isAnalyticsPermitted(request)
		? resolveTrackingTools(context.cloudflare.env)
		: [],
	// saferate.markets on production even when markets.saferate.com served the
	// page (ALTERNATE_HOSTS), so search engines index one address.
	canonical: `${canonicalOrigin(context.cloudflare.env, request)}${new URL(request.url).pathname}`,
});

export const Layout = ({ children }: { children: React.ReactNode }) => {
	// Absent on the error boundary's render, which must not start anything.
	const rootData = useRouteLoaderData<typeof loader>("root");
	return (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				<meta content="width=device-width, initial-scale=1" name="viewport" />
				<Meta />
				{/* The link-preview card (Slack, LinkedIn, X, iMessage): an absolute
				    URL, since unfurlers do not resolve relative ones. One image for
				    every page; public/og.png, 1200x630. */}
				<meta content={PRODUCT_NAME} property="og:site_name" />
				<meta content="website" property="og:type" />
				<meta content={`${SITE_HOSTS.production.web}/og.png`} property="og:image" />
				<meta content="1200" property="og:image:width" />
				<meta content="630" property="og:image:height" />
				<meta
					content="Safe Rate Markets: portfolio management for U.S. Treasuries"
					property="og:image:alt"
				/>
				<meta content="summary_large_image" name="twitter:card" />
				<meta
					content={`${SITE_HOSTS.production.web}/og.png`}
					name="twitter:image"
				/>
				{rootData?.canonical ? (
					<link href={rootData.canonical} rel="canonical" />
				) : null}
				<link href="/favicon.ico" rel="icon" />
				<link
					as="font"
					crossOrigin="anonymous"
					href="/fonts/ttnorms-regular-webfont.woff"
					rel="preload"
					type="font/woff"
				/>
				<Links />
				{/* Site-wide schema.org nodes, here and not in root `meta`, which a
				    page's own meta replaces (lib/jsonLd.ts). */}
				{SITE_JSON_LD.map((node) => (
					<JsonLd data={node} key={String(node["@id"])} />
				))}
			</head>
			<body className="flex min-h-screen flex-col bg-white font-sans text-slate-900 antialiased">
				<SiteHeader />
				<div className="flex-1">{children}</div>
				<SiteFooter />
				<Analytics tools={rootData?.trackingTools ?? []} />
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
};

export default function App() {
	return <Outlet />;
}

export const ErrorBoundary = ({ error }: Route.ErrorBoundaryProps) => {
	const isNotFound = isRouteErrorResponse(error) && error.status === 404;
	return (
		<main className="mx-auto max-w-xl px-6 py-24">
			<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
				{isNotFound ? "Page not found" : "Something went wrong"}
			</h1>
			<p className="mt-3 text-muted-foreground">
				{isNotFound
					? "That page does not exist."
					: "The error has been logged. Try again in a moment."}
			</p>
		</main>
	);
};
