/** Display formatting for the dashboard. Absent values render as an em dash, never as zero. */

const DASH = "—";

export const money = (value: number | null | undefined, digits = 0) =>
	value === null || value === undefined
		? DASH
		: value.toLocaleString("en-US", {
				style: "currency",
				currency: "USD",
				minimumFractionDigits: digits,
				maximumFractionDigits: digits,
			});

export const face = (value: number | null | undefined) =>
	value === null || value === undefined
		? DASH
		: value.toLocaleString("en-US", { maximumFractionDigits: 2 });

export const percent = (value: number | null | undefined, digits = 2) =>
	value === null || value === undefined || !Number.isFinite(value)
		? DASH
		: `${(value * 100).toFixed(digits)}%`;

/** A figure already in percent (a yield of 4.12). */
export const rate = (value: number | null | undefined, digits = 3) =>
	value === null || value === undefined ? DASH : `${value.toFixed(digits)}%`;

export const number = (value: number | null | undefined, digits = 2) =>
	value === null || value === undefined ? DASH : value.toFixed(digits);

/** A price per 100 to six places, as FedInvest quotes it. */
export const price = (value: number | null | undefined) =>
	value === null || value === undefined
		? DASH
		: value.toFixed(6).replace(/0{1,3}$/, "");

/** "4.625% Feb 2035 Note", from terms. */
export const describeSecurity = (
	info: {
		couponPercent: number;
		maturityDate: string;
		family: string | null;
	} | null,
) => {
	if (info === null) return DASH;
	const date = new Date(`${info.maturityDate}T00:00:00Z`);
	const month = date.toLocaleString("en-US", {
		month: "short",
		timeZone: "UTC",
	});
	const kind =
		info.family === null
			? ""
			: ` ${info.family === "tips" ? "TIPS" : info.family === "frn" ? "FRN" : info.family[0].toUpperCase() + info.family.slice(1)}`;
	return info.family === "bill"
		? `Bill ${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`
		: `${info.couponPercent.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}% ${month} ${date.getUTCFullYear()}${kind}`;
};

/** A signed number gets a sign; the colour follows it. */
export const signClass = (value: number | null | undefined) =>
	value === null || value === undefined || value === 0
		? ""
		: value > 0
			? "text-emerald-700"
			: "text-red-700";
