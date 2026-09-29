import { STRATEGIES, type TStrategyKey } from "@markets/portfolio";
import type { TIndexCode } from "@saferate/treasury-client/types";

/** The Builder's modes and choices: shared by the page and its server code. */

export type TBuilderMode =
	| "match"
	| "immunise"
	| "horizon"
	| "index"
	| "strategy"
	| "custom";

export const BUILDER_MODES: {
	mode: TBuilderMode;
	label: string;
	needs: "liabilities" | "budget" | "rows";
}[] = [
	{ mode: "match", label: "Cash-flow matching", needs: "liabilities" },
	{ mode: "immunise", label: "Immunisation", needs: "liabilities" },
	{ mode: "horizon", label: "Horizon matching", needs: "liabilities" },
	{ mode: "strategy", label: "Strategy template", needs: "budget" },
	{ mode: "index", label: "Track an index", needs: "budget" },
	{ mode: "custom", label: "Your own", needs: "rows" },
];

/** Indices a bill/note/bond portfolio can track: the nominal ones. */
export const TRACKABLE_INDICES: TIndexCode[] = [
	"broad",
	"0103",
	"0307",
	"0710",
	"1020",
	"20PL",
	"BILL",
	"SHRT",
];

export type TBuilderInputs = {
	mode: TBuilderMode;
	budget: number | null;
	/** Ticks of 1/32 added to the close. */
	markupTicks: number;
	denomination: number;
	horizonYears: number;
	strategy: TStrategyKey;
	indexCode: TIndexCode;
	maxPositions: number | null;
	rows: { cusip: string; faceAmount: number }[];
};

export const strategyByKey = (key: string) =>
	STRATEGIES.find((s) => s.key === key) ?? null;
