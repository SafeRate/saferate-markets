import {
	API_SURFACES,
	PRODUCT_NAME,
	resolveMarketsEnv,
	SITE_HOSTS,
} from "@markets/schema";
import type { Route } from "./+types/docs";

export const meta: Route.MetaFunction = () => [
	{ title: `Docs — ${PRODUCT_NAME}` },
];

/**
 * How to connect. The API reference itself is NOT here: it is generated from
 * the routes on the API Worker (/reference), so it cannot disagree with the API
 * it documents. This page only gets someone to it, and to MCP.
 *
 * The hostname comes from SITE_HOSTS for THIS environment, so staging's docs
 * point at staging's API.
 */
export const loader = ({ context }: Route.LoaderArgs) => ({
	api: SITE_HOSTS[resolveMarketsEnv(context.cloudflare.env.MARKETS_ENV)].api,
});

const Code = ({ children }: { children: string }) => (
	<pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-muted/50 p-4 font-mono text-xs leading-relaxed">
		{children}
	</pre>
);

export default function Docs({ loaderData }: Route.ComponentProps) {
	const { api } = loaderData;
	return (
		<main className="mx-auto max-w-3xl px-6 py-16">
			<h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
				Docs
			</h1>
			<p className="mt-3 text-muted-foreground">
				One API key, from your{" "}
				<a
					className="text-primary underline underline-offset-4"
					href="/dashboard/keys"
				>
					dashboard
				</a>
				, authenticates both the REST API and the MCP server.
			</p>

			<a
				className="mt-8 block rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-colors hover:border-primary/40"
				href="/docs/indices"
			>
				<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
					Guide
				</p>
				<p className="mt-1 font-semibold text-neutral-900">Treasury indices</p>
				<p className="mt-1 text-sm text-slate-600">
					The eleven total-return indices: what each covers, how to read levels,
					returns and analytics, and the two date conventions.
				</p>
			</a>

			<h2 className="mt-12 text-xl font-semibold tracking-tight">
				What is in the API
			</h2>
			<p className="mt-2 text-sm text-muted-foreground">
				Every endpoint is a GET with the same key. Dates are optional almost
				everywhere and mean the most recent published day. Each group has an MCP
				tool serving the same data.
			</p>
			<div className="mt-4 space-y-6">
				{API_SURFACES.map((surface) => (
					<section key={surface.group}>
						<div className="flex flex-wrap items-baseline justify-between gap-2">
							<h3 className="font-semibold text-neutral-900">{surface.group}</h3>
							{surface.tool ? (
								<p className="font-mono text-xs text-slate-500">MCP: {surface.tool}</p>
							) : null}
						</div>
						<div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
							<table className="w-full border-collapse text-sm">
								<tbody>
									{surface.routes.map((route) => (
										<tr
											className="border-t border-slate-100 first:border-t-0"
											key={route.path}
										>
											<td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-neutral-900">
												{route.path}
											</td>
											<td className="px-3 py-2 text-slate-600">{route.what}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</section>
				))}
			</div>

			<h2 className="mt-12 text-xl font-semibold tracking-tight">REST</h2>
			<p className="mt-2 text-sm text-muted-foreground">
				The full reference is generated from the API itself:{" "}
				<a
					className="text-primary underline underline-offset-4"
					href={`${api}/reference`}
				>
					{api}/reference
				</a>
				.
			</p>
			<Code>{`curl ${api}/v1/curves/zero \\
  -H "Authorization: Bearer $SAFERATE_MARKETS_KEY"`}</Code>

			<h2 className="mt-12 text-xl font-semibold tracking-tight">MCP</h2>
			<p className="mt-2 text-sm text-muted-foreground">
				For AI assistants and agents. Streamable HTTP at{" "}
				<code className="font-mono">{api}/mcp</code>, authenticated with the same
				key as a Bearer header.
			</p>
			<p className="mt-6 text-sm font-medium">Claude Code</p>
			<Code>{`claude mcp add --transport http saferate-markets ${api}/mcp \\
  --header "Authorization: Bearer $SAFERATE_MARKETS_KEY"`}</Code>
			<p className="mt-6 text-sm font-medium">
				Any client that reads an <code className="font-mono">mcpServers</code> file
			</p>
			<Code>{`{
  "mcpServers": {
    "saferate-markets": {
      "type": "http",
      "url": "${api}/mcp",
      "headers": { "Authorization": "Bearer \${SAFERATE_MARKETS_KEY}" }
    }
  }
}`}</Code>
			<p className="mt-4 text-xs text-muted-foreground">
				Keep the key in an environment variable rather than in the file. Sign-in
				based connection for claude.ai and Claude Desktop is not available yet.
			</p>
		</main>
	);
}
