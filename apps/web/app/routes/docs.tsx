import { PRODUCT_NAME, resolveMarketsEnv, SITE_HOSTS } from "@markets/schema";
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
