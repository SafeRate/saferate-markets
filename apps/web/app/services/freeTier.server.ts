import {
	listPortfolios,
	listTransactions,
	type TNewTransaction,
	type TPortfolioTransaction,
} from "@markets/persistence";
import { summarise } from "@markets/portfolio";
import { FREE_TIER } from "@markets/schema";
import { loadPortfolioState } from "@/services/portfolio.server";

/**
 * The free tier's two limits (FREE_TIER in @markets/schema), checked by the
 * actions that create a portfolio and that add trades. Paid accounts never
 * call these. Deleting trades or portfolios is never limited, so an account
 * over a limit can always get back under it.
 */

const dollars = (value: number) =>
	value.toLocaleString("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0,
	});

/** Null when a free account may create another portfolio, else why not. */
export const freePortfolioLimitProblem = async (input: {
	db: D1Database;
	idOrganization: string;
}) => {
	const owned = await listPortfolios(input);
	return owned.length < FREE_TIER.maxPortfolios
		? null
		: `The free plan holds up to ${FREE_TIER.maxPortfolios} portfolios. Subscribe to Individual for more, or delete one first.`;
};

/**
 * The value of everything a free account tracks if `incoming` were added to
 * portfolio `idPortfolio`, valued as the dashboard values it (holdings at the
 * latest close plus any cash). A portfolio that cannot be valued (an unknown
 * security, a sell before its buy) counts as zero here: the trade validation
 * reports those, and this check is about size, not correctness.
 */
export const freeTierValueWith = async (input: {
	env: Env;
	idOrganization: string;
	idPortfolio: string;
	incoming: TNewTransaction[];
}) => {
	const portfolios = await listPortfolios({
		db: input.env.DB,
		idOrganization: input.idOrganization,
	});
	let total = 0;
	for (const portfolio of portfolios) {
		const stored = await listTransactions({
			db: input.env.DB,
			idOrganization: input.idOrganization,
			idPortfolio: portfolio.idPortfolio,
		});
		const proposed =
			portfolio.idPortfolio === input.idPortfolio
				? input.incoming.map(
						(t, i) =>
							({
								...t,
								idTransaction: `proposed-${i}`,
								idPortfolio: portfolio.idPortfolio,
							}) as unknown as TPortfolioTransaction,
					)
				: [];
		const state = await loadPortfolioState({
			env: input.env,
			transactions: [...stored, ...proposed],
			policyIncome: portfolio.policyIncome,
		});
		if (state.status === "ready")
			total += summarise(state.ledger, state.asOf).marketValue;
	}
	// A portfolio about to be created (a plan tracked as a portfolio): value the
	// incoming trades on their own.
	if (
		input.incoming.length > 0 &&
		!portfolios.some((p) => p.idPortfolio === input.idPortfolio)
	) {
		const state = await loadPortfolioState({
			env: input.env,
			transactions: input.incoming.map(
				(t, i) =>
					({
						...t,
						idTransaction: `proposed-${i}`,
						idPortfolio: input.idPortfolio,
					}) as unknown as TPortfolioTransaction,
			),
			policyIncome: "cash",
		});
		if (state.status === "ready")
			total += summarise(state.ledger, state.asOf).marketValue;
	}
	return total;
};

/** Null when the trades keep a free account within the cap, else why not. */
export const freeValueLimitProblem = async (input: {
	env: Env;
	idOrganization: string;
	idPortfolio: string;
	incoming: TNewTransaction[];
}) => {
	const value = await freeTierValueWith(input);
	return value <= FREE_TIER.maxValueUsd
		? null
		: `With these trades your portfolios would be worth ${dollars(value)}, over the free plan's ${dollars(FREE_TIER.maxValueUsd)}. Subscribe to Individual to track more.`;
};
