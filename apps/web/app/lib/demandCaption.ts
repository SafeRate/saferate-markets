/**
 * Words for treasury's auction demand reading, shared by the auctions page,
 * the daily rundown and its email so the three say the same thing. Every
 * number comes from treasury's row (sample, floor, window, days), never from
 * a constant here, so a threshold that moves upstream moves the words too.
 */
export type TDemandWords = {
	verdict: "strong" | "average" | "weak" | null;
	unranked: "sample" | "stale" | null;
	sampleSize: number;
	minSample: number | null;
	windowMonths: number;
	daysSinceLast: number | null;
};

/** "Not ranked: 7 prior auctions in 24 mo, needs 8", or null when ranked. */
export const unrankedCaption = (d: TDemandWords): string | null => {
	if (d.unranked === "sample" && d.minSample !== null)
		return `Not ranked: ${d.sampleSize} prior ${d.sampleSize === 1 ? "auction" : "auctions"} in ${d.windowMonths} mo, needs ${d.minSample}`;
	if (d.unranked === "stale" && d.daysSinceLast !== null)
		return `Not ranked: no auction in ${d.daysSinceLast} days`;
	return null;
};

/** "vs 104 over 24 mo": what a verdict was ranked against. */
export const rankedAgainst = (d: TDemandWords) =>
	`vs ${d.sampleSize} over ${d.windowMonths} mo`;
