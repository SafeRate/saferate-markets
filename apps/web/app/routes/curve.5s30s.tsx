import { PRODUCT_NAME } from "@markets/schema";
import { SpreadPage } from "@/components/SpreadPage";
import { loadSpread } from "@/services/curveSpread.server";
import type { Route } from "./+types/curve.5s30s";

const PATH = "/curve/5s30s";
const TITLE = "5s30s Treasury Spread";

export const meta: Route.MetaFunction = () => [
	{
		title: `${TITLE} Today: 30-Year Minus 5-Year Treasury Yield | ${PRODUCT_NAME}`,
	},
	{
		name: "description",
		content:
			"The 5s30s Treasury spread, the 30-year minus the 5-year par yield, updated every business day from Safe Rate's fitted Treasury curve: today's level, daily, monthly and yearly changes, and where it sits in its history since 2008.",
	},
];

/** The 5s30s spread; the page and its data live in SpreadPage and curveSpread.server. */
export const loader = async ({ context }: Route.LoaderArgs) => {
	try {
		return { spread: await loadSpread(context.cloudflare.env, "5s30s") };
	} catch (error) {
		console.error("[5s30s] could not read the par curve:", error);
		return { spread: null };
	}
};

export default function Spread5s30s({ loaderData }: Route.ComponentProps) {
	return <SpreadPage path={PATH} spread={loaderData.spread} title={TITLE} />;
}
