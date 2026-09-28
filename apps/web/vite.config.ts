import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// The Cloudflare Vite plugin bakes env-resolved bindings into
// dist/server/wrangler.json at BUILD time from CLOUDFLARE_ENV. A build with it
// unset carries the top-level (local dev) bindings, which is why deploys go
// through scripts/bash/build-web.sh rather than a bare `react-router build`.
const cloudflareEnv = process.env.CLOUDFLARE_ENV;

export default defineConfig({
	plugins: [
		cloudflare({
			viteEnvironment: { name: "ssr" },
			// Shared with apps/api (dev-api.sh --persist-to). Both Workers bind the
			// SAME D1 when deployed, but wrangler persists local state per invoking
			// directory, so without this a key minted in the local dashboard fails
			// against the local API with `no such table: apiKeys`: two databases
			// that read as broken code.
			persistState: { path: "../../.wrangler/state" },
			...(cloudflareEnv && {
				configPath: "./wrangler.jsonc",
				environment: cloudflareEnv,
			}),
		}),
		tailwindcss(),
		reactRouter(),
		tsconfigPaths(),
	],
	resolve: {
		dedupe: ["react", "react-dom", "react-router"],
	},
	server: {
		port: 3020,
	},
});
