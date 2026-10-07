import { expect, test } from "bun:test";
import {
	DATA_CATALOG_REF,
	datasetJsonLd,
	FOUNDER_JSON_LD,
	ORGANIZATION_REF,
	PRICING_PRODUCT_JSON_LD,
	SITE_JSON_LD,
} from "../app/lib/jsonLd";

/**
 * Every nested object that names an @id also carries its @type, because each
 * node is its own <script> block and Google does not resolve an @id into
 * another one (OKLocate, 2026-10-07: "Invalid object type for brand").
 */
const bareReferences = (value: unknown, path = "$"): string[] => {
	if (Array.isArray(value))
		return value.flatMap((v, i) => bareReferences(v, `${path}[${i}]`));
	if (value === null || typeof value !== "object") return [];
	const node = value as Record<string, unknown>;
	const here = path !== "$" && "@id" in node && !("@type" in node) ? [path] : [];
	return [
		...here,
		...Object.entries(node).flatMap(([k, v]) =>
			bareReferences(v, `${path}.${k}`),
		),
	];
};

const dataset = datasetJsonLd({
	id: "https://saferate.markets/data#x",
	name: "x",
	description: "x",
	url: "https://saferate.markets/data#x",
	keywords: ["x"],
	apiPaths: ["/v1/x"],
});

test("no node refers to another by a bare @id", () => {
	for (const node of [
		...SITE_JSON_LD,
		...FOUNDER_JSON_LD,
		dataset,
		PRICING_PRODUCT_JSON_LD,
	])
		expect(bareReferences(node)).toEqual([]);
});

test("the check finds a bare @id when there is one", () => {
	expect(bareReferences({ publisher: { "@id": "x" } })).toEqual(["$.publisher"]);
});

test("references keep saferate.com's ids, so the two sites stay one graph", () => {
	expect(ORGANIZATION_REF["@id"]).toBe("https://saferate.com/#organization");
	expect(dataset.creator).toBe(ORGANIZATION_REF);
	expect(dataset.includedInDataCatalog).toBe(DATA_CATALOG_REF);
});

test("the Organization's logo is a raster", () => {
	const organization = SITE_JSON_LD.find((n) => n["@type"] === "Organization");
	const logo = organization?.logo as { url: string } | undefined;
	expect(logo?.url).toMatch(/\.png$/);
});

test("every offer has a price; a contact-sales plan publishes none", () => {
	const app = SITE_JSON_LD.find((n) => n["@type"] === "WebApplication");
	const offers = app?.offers as { name: string; price?: number }[];
	expect(offers.every((o) => typeof o.price === "number")).toBe(true);
	expect(offers.map((o) => o.name)).not.toContain("Enterprise");
});

test("the Pricing Product qualifies for product snippets: a name, and priced offers", () => {
	const p = PRICING_PRODUCT_JSON_LD;
	expect(p["@type"]).toBe("Product");
	expect(p.name.length).toBeGreaterThan(0);
	expect(p.brand).toEqual({ "@type": "Brand", name: "Safe Rate" });
	expect(p.offers.map((o) => [o.name, o.price])).toEqual([
		["Free", 0],
		["Individual", 10],
		["Team", 100],
	]);
	expect(
		p.offers.every((o) => o.availability === "https://schema.org/InStock"),
	).toBe(true);
	// Nothing to ship, so nothing claimed about shipping or returns.
	expect("shippingDetails" in p.offers[0]).toBe(false);
});
