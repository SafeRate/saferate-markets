import { PRODUCT_NAME } from "@markets/schema";
import { SpreadPage } from "@/components/SpreadPage";
import { loadSpread } from "@/services/curveSpread.server";
import type { Route } from "./+types/curve.2s10s";

const PATH = "/curve/2s10s";
const TITLE = "2s10s Treasury Spread";

export const meta: Route.MetaFunction = () => [
	{
		title: `${TITLE} Today: 10-Year Minus 2-Year Treasury Yield | ${PRODUCT_NAME}`,
	},
	{
		name: "description",
		content:
			"The 2s10s Treasury spread, the 10-year minus the 2-year par yield, updated every business day from Safe Rate's fitted Treasury curve: today's level, daily, monthly and yearly changes, and where it sits in its history since 2008.",
	},
];

/** The 2s10s spread; the page and its data live in SpreadPage and curveSpread.server. */
export const loader = async ({ context }: Route.LoaderArgs) => {
	try {
		return { spread: await loadSpread(context.cloudflare.env, "2s10s") };
	} catch (error) {
		console.error("[2s10s] could not read the par curve:", error);
		return { spread: null };
	}
};

export default function Spread2s10s({ loaderData }: Route.ComponentProps) {
	return <SpreadPage path={PATH} spread={loaderData.spread} title={TITLE} />;
}
