import type { ComponentType } from "react";
import type { TPublicTwinPath } from "@/lib/publicPages";
import * as about from "@/routes/about";
import * as capabilities from "@/routes/capabilities";
import * as dataPage from "@/routes/data";
import * as docs from "@/routes/docs";
import * as docsIndices from "@/routes/docs.indices";
import * as home from "@/routes/_index";
import * as indices from "@/routes/indices";
import * as pricing from "@/routes/pricing";
import * as privacy from "@/routes/privacy";
import * as ladderFiveYear from "@/routes/strategies.ladder-5y";
import * as tBillReinvestment from "@/routes/strategies.t-bill-reinvestment";
import * as treasuryCurveMethodology from "@/routes/methodology.treasury-curve";
import * as terms from "@/routes/terms";

/**
 * The route modules of the public pages, keyed by path: what the markdown
 * twins render, and where the sitemap and llms.txt read each page's title and
 * description (its own meta), so none of them carries a second copy.
 */
export type TPageModule = {
	default: ComponentType;
	loader?: (args: never) => unknown;
	meta?: (args: never) => { title?: string; name?: string; content?: string }[];
};

export const PUBLIC_PAGE_MODULES: Record<TPublicTwinPath, TPageModule> = {
	"/": home as unknown as TPageModule,
	"/data": dataPage as unknown as TPageModule,
	"/indices": indices as unknown as TPageModule,
	"/capabilities": capabilities as unknown as TPageModule,
	"/about": about as unknown as TPageModule,
	"/pricing": pricing as unknown as TPageModule,
	"/docs": docs as unknown as TPageModule,
	"/docs/indices": docsIndices as unknown as TPageModule,
	"/terms": terms as unknown as TPageModule,
	"/privacy": privacy as unknown as TPageModule,
	"/strategies/ladder-5y": ladderFiveYear as unknown as TPageModule,
	"/strategies/t-bill-reinvestment": tBillReinvestment as unknown as TPageModule,
	"/methodology/treasury-curve":
		treasuryCurveMethodology as unknown as TPageModule,
};

/** A page's title and description, from its own meta. */
export const pageMetaOf = (path: TPublicTwinPath) => {
	const tags =
		PUBLIC_PAGE_MODULES[path].meta?.({ data: undefined } as never) ?? [];
	return {
		title: tags.find((t) => t.title)?.title ?? path,
		description: tags.find((t) => t.name === "description")?.content ?? null,
	};
};
