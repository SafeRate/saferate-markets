import { INCOME_POLICY_LABEL, type TIncomePolicy } from "@markets/portfolio";
import {
	INDEX_DISPLAY_ORDER,
	INDEX_META,
} from "@saferate/treasury-client/types";

/** The choices a portfolio's settings offer, from the values that enforce them. */

export const BENCHMARK_OPTIONS = INDEX_DISPLAY_ORDER.map((code) => ({
	code,
	label: `${INDEX_META[code].name} (${INDEX_META[code].ticker})`,
}));

export const INCOME_OPTIONS = (
	Object.keys(INCOME_POLICY_LABEL) as TIncomePolicy[]
).map((policy) => ({
	policy,
	label: INCOME_POLICY_LABEL[policy],
}));

export const parseBenchmark = (raw: FormDataEntryValue | null) => {
	const value = String(raw ?? "");
	return BENCHMARK_OPTIONS.some((o) => o.code === value) ? value : null;
};

export const parsePolicy = (raw: FormDataEntryValue | null): TIncomePolicy => {
	const value = String(raw ?? "");
	return value in INCOME_POLICY_LABEL ? (value as TIncomePolicy) : "cash";
};
