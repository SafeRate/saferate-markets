/**
 * The legal pages, as data. Ported in structure from saferate-oklocate
 * packages/schema/src/legal.ts on 2026-09-28.
 *
 * A condition on a public page is computed, never typed, where it can be: the
 * plans table in the terms comes from PLANS, the tools in the privacy policy
 * from TRACKING_TOOLS, the untracked paths from PATHS_NOT_PUBLIC. A licence
 * condition that goes stale on /terms is a term we are asking a customer to
 * accept that we cannot stand behind.
 *
 * The company-wide positions (entity, governing law, no arbitration, no class
 * waiver, the liability cap's shape) are OKLocate's, which were chosen to match
 * the terms already published at saferate.com.
 *
 * NOT legal advice, and not reviewed by counsel as of the effective date below.
 * This is an engineering record written so counsel can check it rather than
 * reconstruct it. Three positions in particular are commercial choices made in
 * engineering and flagged for counsel: what a customer may keep after
 * termination (RETENTION_AFTER_TERMINATION), the US-only audience position
 * (AUDIENCE_POSITION), and the usage-record retention period.
 */

export const LEGAL_ENTITY = {
	/** Exact registered name. Used verbatim; never abbreviated on a legal page. */
	nameLegal: "Safe Rate Inc.",
	/** The brand these documents govern. Not a separate legal person. */
	nameProduct: "Safe Rate Markets",
	form: "Delaware C corporation",
	addressStreet: "515 N State St, Floor 13",
	addressCity: "Chicago",
	addressState: "IL",
	addressPostalCode: "60654",
	addressCountry: "United States",
	/** General contact, and the address privacy requests go to. */
	emailContact: "team@saferate.com",
	hostSite: "saferate.markets",
	hostApi: "api.saferate.markets",
} as const;

export const LEGAL_ADDRESS_LINES = [
	LEGAL_ENTITY.nameLegal,
	LEGAL_ENTITY.addressStreet,
	`${LEGAL_ENTITY.addressCity}, ${LEGAL_ENTITY.addressState} ${LEGAL_ENTITY.addressPostalCode}`,
] as const;

/**
 * Governing law follows the office rather than the state of incorporation, and
 * matches saferate.com and OKLocate. No arbitration clause and no class-action
 * waiver, matching both.
 */
export const GOVERNING_LAW = {
	state: "Illinois",
	venue: "Cook County, Illinois",
	hasArbitrationClause: false,
	hasClassActionWaiver: false,
} as const;

/**
 * The greater of fees paid in the preceding twelve months and a floor, so a
 * beta subscriber paying nothing is not capped at zero. Same shape as
 * saferate.com and OKLocate.
 */
export const LIABILITY = {
	capMonths: 12,
	capFloorUsd: 100,
} as const;

/**
 * One date for both documents: they reference each other, and different dates
 * would make "as amended" ambiguous.
 */
export const LEGAL_EFFECTIVE_DATE = "2026-10-06";

export const legalEffectiveDateLabel = () =>
	new Date(`${LEGAL_EFFECTIVE_DATE}T00:00:00Z`).toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	});

export const AGE_MINIMUM = 18;
export const RIGHTS_RESPONSE_DAYS = 30;
export const ACCOUNT_DELETION_DAYS = 30;
/** Notice before a breaking change to a generally available endpoint. */
export const BREAKING_CHANGE_NOTICE_DAYS = 90;
/** Notice before a material change to either document. */
export const MATERIAL_CHANGE_NOTICE_DAYS = 30;
/** Notice before a beta code's discount is removed from a subscription. */
export const BETA_END_NOTICE_DAYS = 30;

/**
 * API usage records: kept for the life of the organization, then deleted with
 * it on request. Unlike OKLocate there is no metered billing to reconcile, so
 * no seven-year period is claimed for them. FLAGGED FOR COUNSEL.
 */
export const USAGE_RETENTION =
	"For as long as the organization exists, and deleted with it when you ask us to delete your account.";

/**
 * What a customer may keep after termination. Market-data licences commonly end
 * with the subscription; this keeps what has already been used internally or
 * delivered to clients, and ends the ability to keep retrieving or to use the
 * data in anything new. FLAGGED FOR COUNSEL: a commercial choice.
 */
export const RETENTION_AFTER_TERMINATION =
	"You may keep copies of data you retrieved while subscribed for your own records, and client reports you delivered while subscribed need not be withdrawn. You may not use that data in new work or publish it after your subscription ends.";

/**
 * Who the documents are written for. Markets sells U.S. Treasury data to
 * institutions and individuals in U.S. dollars and runs no marketing in the
 * EEA, UK or Switzerland, which is why analytics are opt-out rather than behind
 * a consent banner. If Markets begins selling there, analytics move to prior
 * opt-in. FLAGGED FOR COUNSEL: institutional buyers can be non-US.
 */
export const AUDIENCE_POSITION = {
	isTargetingEurope: false,
	summary:
		"We sell in U.S. dollars and do not market in the EEA, the UK or Switzerland.",
} as const;

export type TRuleOrigin = "our_policy" | "source_licence" | "law";

export const RULE_ORIGIN_LABEL: Record<TRuleOrigin, string> = {
	our_policy: "Our policy",
	source_licence: "Required by a source license",
	law: "Required by law",
};

/** Each rule says where it comes from, so a customer knows which we can waive. */
export const PROHIBITED_USES: readonly {
	rule: string;
	origin: TRuleOrigin;
	why: string;
}[] = [
	{
		rule:
			"Do not use the data beyond your plan: showing it to the public, putting it inside a product or feed your customers use, or launching a product built to track an index, without an Enterprise agreement. Naming an index as a benchmark is free.",
		origin: "our_policy",
		why: "The plans are priced by who the data is for. Redistribution and products that track an index are different licenses, set out on the pricing page.",
	},
	{
		rule:
			"Do not present a figure without its date, or an index level as a yield.",
		origin: "our_policy",
		why: "Every figure is an end-of-day record for a stated day, and an index level is a total return. A figure detached from its date, or a level read as a rate, misleads whoever relies on it.",
	},
	{
		rule:
			"Do not share your API key outside your organization, or embed a live key where a third party can read it.",
		origin: "our_policy",
		why: "A key authenticates as your organization, and its usage and rate limit are your organization's.",
	},
	{
		rule:
			"Do not attempt to exceed, circumvent or obscure your rate limit or usage.",
		origin: "our_policy",
		why: "The rate limit protects the service for every customer, and usage records are the record of what was served.",
	},
	{
		rule:
			"Do not scrape the website in place of using the API, or resell raw API responses as a competing data service.",
		origin: "our_policy",
		why: "The API is the product. A plan licenses you to use the data, not to operate a copy of the feed.",
	},
];
