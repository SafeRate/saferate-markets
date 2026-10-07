import { FREE_TIER, PLANS, PRODUCT_NAME, SITE_HOSTS } from "@markets/schema";

/**
 * schema.org JSON-LD for Markets.
 *
 * ONE COMPANY ACROSS TWO SITES. The Organization and the founders are
 * saferate.com's entities, referenced by the `@id`s it already publishes
 * (saferate-ai apps/consumer/app/utils/siteJsonLd.ts): `.../#organization`,
 * `/about#dylan-hall`, `/about#shima-rayej`. Markets emits a minimal node for
 * each, so a reference here is never dangling, and leaves the full record
 * (address, NMLS, alumni) to saferate.com rather than keeping a second copy
 * that would drift.
 *
 * EVERY REFERENCE IS A TYPED OBJECT, never a bare `{ "@id": ... }`. Each node
 * is its own <script> block, and Google does not resolve an @id into another
 * block: OKLocate's `brand: { "@id": ... }` was reported "Invalid object type"
 * (2026-10-07). So a reference carries its @id, so the graph still joins, AND
 * its @type and name, so it stands on its own. A test holds this.
 *
 * Site-wide nodes are rendered from root's Layout, which always renders: a
 * route's `meta` REPLACES its parent's, so JSON-LD put in root `meta` would
 * appear on no page (saferate.com found exactly that). Page nodes are rendered
 * by the page itself.
 */

const WEB = SITE_HOSTS.production.web;
const API = SITE_HOSTS.production.api;
export const ORGANIZATION_ID = "https://saferate.com/#organization";
const WEBSITE_ID = `${WEB}/#website`;
const APP_ID = `${WEB}/#application`;

/** Safe Rate, as every Markets node refers to it. */
export const ORGANIZATION_REF = {
	"@type": "Organization",
	"@id": ORGANIZATION_ID,
	name: "Safe Rate",
	url: "https://saferate.com",
};
const organizationRef = ORGANIZATION_REF;

/** The Data page's catalog, as a Dataset on another page refers to it. */
export const DATA_CATALOG_REF = {
	"@type": "DataCatalog",
	"@id": `${WEB}/data#catalog`,
	name: "Safe Rate Markets U.S. Treasury data",
	url: `${WEB}/data`,
};

export const SITE_JSON_LD: Record<string, unknown>[] = [
	{
		"@context": "https://schema.org",
		"@type": "Organization",
		"@id": ORGANIZATION_ID,
		name: "Safe Rate",
		url: "https://saferate.com",
		email: "team@saferate.com",
		// saferate.com's own logo node, a raster: Google may decline an SVG.
		logo: {
			"@type": "ImageObject",
			url: "https://saferate.com/images/general/saferate-logo-290x71.png",
			width: 290,
			height: 71,
		},
	},
	{
		"@context": "https://schema.org",
		"@type": "WebSite",
		"@id": WEBSITE_ID,
		name: PRODUCT_NAME,
		url: WEB,
		publisher: organizationRef,
		inLanguage: "en-US",
	},
	{
		"@context": "https://schema.org",
		"@type": "WebApplication",
		"@id": APP_ID,
		name: PRODUCT_NAME,
		url: WEB,
		applicationCategory: "FinanceApplication",
		operatingSystem: "Web",
		description:
			"Portfolio management for U.S. Treasuries: tracking and attribution, cash-flow matching and immunization, stress testing, value at risk, backtesting and trade execution, on every Treasury priced daily since September 2008, with a REST API and an MCP server.",
		publisher: organizationRef,
		offers: [
			{
				"@type": "Offer",
				name: FREE_TIER.name,
				description: FREE_TIER.summary,
				price: 0,
				priceCurrency: "USD",
				url: `${WEB}/pricing`,
			},
			...PLANS.flatMap((plan) =>
				plan.sale.kind === "checkout"
					? [
							{
								"@type": "Offer",
								name: plan.name,
								description: plan.summary,
								price: plan.sale.priceUsdMonthly,
								priceCurrency: "USD",
								priceSpecification: {
									"@type": "UnitPriceSpecification",
									price: plan.sale.priceUsdMonthly,
									priceCurrency: "USD",
									unitCode: "MON",
								},
								url: `${WEB}/pricing`,
							},
						]
					: [],
			),
		],
	},
];

/** A Dataset node: Markets data, created by Safe Rate, terms on the site. */
export const datasetJsonLd = (input: {
	id: string;
	name: string;
	description: string;
	url: string;
	temporalStart?: string;
	keywords: string[];
	apiPaths: string[];
}) => ({
	"@context": "https://schema.org",
	"@type": "Dataset",
	"@id": input.id,
	name: input.name,
	description: input.description,
	url: input.url,
	keywords: input.keywords,
	creator: organizationRef,
	publisher: organizationRef,
	license: `${WEB}/terms`,
	...(input.temporalStart
		? { temporalCoverage: `${input.temporalStart}/..` }
		: {}),
	spatialCoverage: "United States",
	includedInDataCatalog: DATA_CATALOG_REF,
	distribution: input.apiPaths.map((path) => ({
		"@type": "DataDownload",
		encodingFormat: "application/json",
		contentUrl: `${API}${path}`,
	})),
});

/** The founders, by saferate.com's ids, with only what this site states. */
export const FOUNDER_JSON_LD = [
	{
		"@context": "https://schema.org",
		"@type": "Person",
		"@id": "https://saferate.com/about#shima-rayej",
		name: "Shima Rayej",
		jobTitle: "Co-founder",
		worksFor: organizationRef,
		url: `${WEB}/about`,
		sameAs: ["https://www.linkedin.com/in/shima-rayej/"],
	},
	{
		"@context": "https://schema.org",
		"@type": "Person",
		"@id": "https://saferate.com/about#dylan-hall",
		name: "Dylan Hall",
		jobTitle: "Co-founder",
		worksFor: organizationRef,
		url: `${WEB}/about`,
		sameAs: ["https://www.linkedin.com/in/dylan-m-hall/"],
	},
];

/** JSON for a <script> body: `<` escaped so no string can close the tag. */
export const jsonLdScript = (value: unknown) =>
	JSON.stringify(value).replace(/</g, "\\u003c");
