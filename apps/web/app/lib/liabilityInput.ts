import { parseLiabilities } from "@markets/portfolio";

/** Pasted text, or a CSV file if one was chosen. */
export const readLiabilityInput = async (form: FormData) => {
	const file = form.get("file");
	if (file instanceof File && file.size > 0) {
		if (file.size > 1_000_000)
			return { ok: false as const, errors: ["The file is over 1 MB."] };
		return parsedOrErrors(await file.text());
	}
	return parsedOrErrors(String(form.get("lines") ?? ""));
};

const parsedOrErrors = (text: string) => {
	const parsed = parseLiabilities(text);
	return parsed.ok
		? { ok: true as const, rows: parsed.rows }
		: {
				ok: false as const,
				errors: parsed.errors.map((e) =>
					e.line === null ? e.message : `Line ${e.line}: ${e.message}`,
				),
			};
};
