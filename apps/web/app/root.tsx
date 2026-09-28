import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
	useRouteLoaderData,
} from "react-router";
import Analytics from "@/components/Analytics";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { resolveTrackingTools } from "@/lib/analytics";
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
				<link href="/favicon.ico" rel="icon" />
				<link
					as="font"
					crossOrigin="anonymous"
					href="/fonts/ttnorms-regular-webfont.woff"
					rel="preload"
					type="font/woff"
				/>
				<Links />
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
