import type { getBuilderPlan } from "@markets/persistence";
import { treasuryDirectAlternative } from "@markets/portfolio";

type TStored = NonNullable<Awaited<ReturnType<typeof getBuilderPlan>>>;

/**
 * A saved plan's order lines: every position is a secondary-market BUY; the
 * TreasuryDirect alternative is the auctioned term maturing nearest it, where
 * one is close enough to stand in.
 */
export const orderLines = (plan: TStored) =>
	plan.positions.map((p) => ({
		...p,
		treasuryDirect: treasuryDirectAlternative(
			{ faceAmount: p.faceAmount, maturityDate: p.maturityDate },
			plan.settleDate,
		),
	}));
