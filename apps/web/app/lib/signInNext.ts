/**
 * Where the link lands after sign-in: a dashboard path a public page asked
 * for (the ladder's "Track this trade" opens the Builder already filled in),
 * else the dashboard. Only a path under /dashboard/ is accepted, never a host
 * or a protocol-relative "//", so this cannot become an open redirect.
 */
export const safeNext = (raw: FormDataEntryValue | null) => {
	const value = typeof raw === "string" ? raw : "";
	return /^\/dashboard(\/[^/\\]|$|\?)/.test(value) && !value.includes("//")
		? value
		: "/dashboard";
};
