import {
	LOT_PRESETS,
	STRATEGIES,
	type TLotRules,
	type TStrategyKey,
} from "@markets/portfolio";
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
	{ mode: "immunise", label: "Immunization", needs: "liabilities" },
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
	lotPreset: TLotPreset;
	lots: TLotRules;
};

export const strategyByKey = (key: string) =>
	STRATEGIES.find((s) => s.key === key) ?? null;

export type TLotPreset = keyof typeof LOT_PRESETS | "custom";

export const LOT_PRESET_OPTIONS: { key: TLotPreset; label: string }[] = [
	{ key: "retail", label: "Retail broker: $1,000 minimum and steps" },
	{ key: "apex", label: "Apex or TreasuryDirect: $100 minimum and steps" },
	{
		key: "institutional",
		label: "Institutional: $1,000 steps, positions of $250k or more",
	},
	{ key: "custom", label: "Custom" },
];

/** The lot rules for a preset, with any of the three overridden. */
export const lotsFrom = (
	preset: TLotPreset,
	overrides: {
		increment: number | null;
		minimumOrder: number | null;
		minimumPosition: number | null;
	},
): TLotRules => {
	const base = LOT_PRESETS[preset === "custom" ? "retail" : preset];
	const increment = Math.max(1, overrides.increment ?? base.increment);
	return {
		increment,
		minimumOrder: Math.max(
			increment,
			overrides.minimumOrder ?? base.minimumOrder,
		),
		minimumPosition: Math.max(
			0,
			overrides.minimumPosition ?? base.minimumPosition,
		),
		roundLot: base.roundLot,
	};
};
