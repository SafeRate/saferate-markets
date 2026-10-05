import { jsonLdScript } from "@/lib/jsonLd";

/** One JSON-LD script; `<` is escaped so a value can never close the tag. */
export const JsonLd = ({ data }: { data: unknown }) => (
	<script
		dangerouslySetInnerHTML={{ __html: jsonLdScript(data) }}
		type="application/ld+json"
	/>
);
