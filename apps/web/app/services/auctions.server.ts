/**
 * The Auctions page's data: the shared window and analysis in
 * @markets/mcp-tools (reads/auctions.ts), so the page, GET /v1/auctions and the
 * get_treasury_auctions MCP tool quote the same figures.
 */
export {
	bidderShares,
	clearingRate,
	groupOf,
	loadAuctionWindow as loadAuctions,
	type TAuction,
} from "@markets/mcp-tools";
