import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
} from "react-router";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import type { Route } from "./+types/root";
import "@/app.css";

export const Layout = ({ children }: { children: React.ReactNode }) => (
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
			<ScrollRestoration />
			<Scripts />
		</body>
	</html>
);

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
