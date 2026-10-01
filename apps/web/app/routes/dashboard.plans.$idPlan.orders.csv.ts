import { getBuilderPlan } from "@markets/persistence";
import { data } from "react-router";
import { describeSecurity } from "@/lib/format";
import { orderLines } from "@/lib/orders";
import { requireDashboard } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.plans.$idPlan.orders.csv";

/**
 * A saved plan's order sheet as CSV: one BUY per position, limit at the clean
 * plan price, with the TreasuryDirect alternative alongside. Column names are
 * the common blotter ones, so it opens in a spreadsheet or maps onto a
 * broker's basket upload.
 */
const csvCell = (value: string | number) => {
	const text = String(value);
	return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const loader = async ({
	request,
	context,
	params,
}: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const org = await requireDashboard(request, env);
	const plan = await getBuilderPlan({
		db: env.DB,
		idOrganization: org.idOrganization,
		idPlan: params.idPlan,
	});
	if (plan === null) throw data("No such plan.", { status: 404 });
	const header = [
		"Action",
		"CUSIP",
		"Description",
		"Maturity",
		"Coupon",
		"Face",
		"OrderType",
		"LimitPrice",
		"TimeInForce",
		"EstimatedCost",
		"PricedAt",
		"Settlement",
		"TreasuryDirectAlternative",
	];
	const rows = orderLines(plan).map((l) => [
		"BUY",
		l.cusip,
		describeSecurity(l),
		l.maturityDate,
		l.couponPercent,
		l.faceAmount,
		"LMT",
		l.planPrice.toFixed(6),
		"DAY",
		l.cost.toFixed(2),
		plan.asOf,
		plan.settleDate,
		l.treasuryDirect.isClose
			? `${l.treasuryDirect.term} at next auction${l.treasuryDirect.overLimit ? " (over $10m limit)" : ""}`
			: "",
	]);
	const body = [header, ...rows]
		.map((r) => r.map(csvCell).join(","))
		.join("\r\n");
	const file = `${plan.namePlan.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plan"}-${plan.asOf}.csv`;
	return new Response(body, {
		headers: {
			"Content-Type": "text/csv; charset=utf-8",
			"Content-Disposition": `attachment; filename="${file}"`,
			"Cache-Control": "private, no-store",
		},
	});
};
