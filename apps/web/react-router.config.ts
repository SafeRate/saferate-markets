import type { Config } from "@react-router/dev/config";

export default {
	buildDirectory: "dist",
	ssr: true,
	future: {
		unstable_viteEnvironmentApi: true,
	},
} satisfies Config;
