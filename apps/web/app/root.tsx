import { PRODUCT_NAME } from "@markets/schema";
import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root";
import "@/app.css";

export const Layout = ({ children }: { children: React.ReactNode }) => (
	<html lang="en">
		<head>
			<meta charSet="utf-8" />
			<meta content="width=device-width, initial-scale=1" name="viewport" />
			<Meta />
			<Links />
		</head>
		<body className="flex min-h-screen flex-col font-sans antialiased">
			<header className="border-b border-border">
				<nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
					<a className="font-semibold tracking-tight" href="/">
						{PRODUCT_NAME}
					</a>
					<div className="flex items-center gap-5 text-sm">
						<a className="text-muted-foreground hover:text-foreground" href="/docs">
							Docs
						</a>
						<a
							className="rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground"
							href="/dashboard"
						>
							Dashboard
						</a>
					</div>
				</nav>
			</header>
			<div className="flex-1">{children}</div>
			<footer className="border-t border-border">
				<p className="mx-auto max-w-5xl px-6 py-6 text-xs text-muted-foreground">
					Source data is published by the U.S. Department of the Treasury. Figures
					are end-of-day records, not live prices, and nothing here is investment
					advice. © Safe Rate.
				</p>
			</footer>
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
			<h1 className="text-2xl font-semibold tracking-tight">
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
