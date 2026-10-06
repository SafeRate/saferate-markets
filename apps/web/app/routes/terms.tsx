import {
	AGE_MINIMUM,
	BETA_END_NOTICE_DAYS,
	BREAKING_CHANGE_NOTICE_DAYS,
	GOVERNING_LAW,
	LEGAL_ENTITY,
	LIABILITY,
	MATERIAL_CHANGE_NOTICE_DAYS,
	FREE_TIER,
	PLANS,
	PROHIBITED_USES,
	RETENTION_AFTER_TERMINATION,
	RULE_ORIGIN_LABEL,
} from "@markets/schema";
import { Link } from "react-router";
import { Callout, LegalPage, LegalSection } from "@/components/LegalPage";
import type { Route } from "./+types/terms";

export const meta: Route.MetaFunction = () => [
	{ title: `Terms of service | ${LEGAL_ENTITY.nameProduct}` },
	{
		name: "description",
		content:
			"The terms of service for Safe Rate Markets: the plans, what each license permits, and the rules for using its Treasury data and indices.",
	},
];

/**
 * The terms of service. Structure and the shared clauses (accounts, keys,
 * liability, law, termination mechanics, general) follow OKLocate's terms, which
 * match saferate.com's positions. The market-data sections are Markets' own.
 *
 * Derived rather than typed: the plans table and licence rights (section 4,
 * from PLANS), and the prohibited uses with where each comes from (section 7,
 * from PROHIBITED_USES). NOT reviewed by counsel; see packages/schema legal.ts
 * for the positions flagged for review.
 */

const SECTIONS = [
	{ id: "agreement", title: "The agreement" },
	{ id: "service", title: "What the service is" },
	{ id: "accounts", title: "Accounts, keys and your organization" },
	{ id: "plans", title: "Plans, and what each licenses" },
	{ id: "payment", title: "Payment, beta codes and cancellation" },
	{ id: "data", title: "The data, and where it comes from" },
	{ id: "acceptable-use", title: "What you may not do" },
	{ id: "advice", title: "Not investment advice" },
	{ id: "accuracy", title: "Accuracy, and what we do not warrant" },
	{ id: "ip", title: "Intellectual property" },
	{ id: "confidentiality", title: "Confidentiality and your data" },
	{ id: "availability", title: "Availability and support" },
	{ id: "liability", title: "Limitation of liability" },
	{ id: "indemnity", title: "Indemnity" },
	{ id: "term", title: "Term, suspension and termination" },
	{ id: "law", title: "Governing law and disputes" },
	{ id: "general", title: "General" },
	{ id: "changes", title: "Changes to these terms" },
];

const n = (id: string) => SECTIONS.findIndex((s) => s.id === id) + 1;

export default function Terms() {
	const email = LEGAL_ENTITY.emailContact;
	return (
		<LegalPage
			kicker="Legal"
			lead={
				<>
					<p>
						These terms cover the {LEGAL_ENTITY.nameProduct} website and API. In
						short: you subscribe to a plan, you get Treasury market data by API and
						MCP, and the plan decides who you may use it for.
					</p>
					<p>
						The parts worth reading closely are section {n("plans")}, which says what
						each plan licenses, and section {n("advice")}: nothing here is investment
						advice.
					</p>
				</>
			}
			sections={SECTIONS}
			title="Terms of service"
		>
			<LegalSection id="agreement" number={n("agreement")} title="The agreement">
				<p>
					This is an agreement between you — the business or individual using the
					service — and {LEGAL_ENTITY.nameLegal}, a {LEGAL_ENTITY.form} at{" "}
					{LEGAL_ENTITY.addressStreet}, {LEGAL_ENTITY.addressCity},{" "}
					{LEGAL_ENTITY.addressState} {LEGAL_ENTITY.addressPostalCode}.{" "}
					{LEGAL_ENTITY.nameProduct} is a product of that company, not a separate
					legal person.
				</p>
				<p>
					You accept these terms by creating an account or by calling the API. If you
					are agreeing on behalf of a company, you are confirming you have authority
					to bind it. You must be at least {AGE_MINIMUM}.
				</p>
				<p>
					Our{" "}
					<Link className="underline underline-offset-4" to="/privacy">
						privacy policy
					</Link>{" "}
					is part of this agreement.
				</p>
			</LegalSection>

			<LegalSection id="service" number={n("service")} title="What the service is">
				<p>
					{LEGAL_ENTITY.nameProduct} provides U.S. Treasury market data: fitted yield
					curves, individual securities with their prices and analytics, and Safe
					Rate's total-return indices, through a REST API at {LEGAL_ENTITY.hostApi}{" "}
					and an MCP server for AI assistants. Figures are end-of-day records for
					business days, not live prices. What is available is described in the{" "}
					<Link className="underline underline-offset-4" to="/docs">
						documentation
					</Link>{" "}
					and the generated API reference.
				</p>
				<p>
					Where a feature is described as coming soon, nothing in these terms obliges
					us to deliver it, and no roadmap item is a commitment.
				</p>
			</LegalSection>

			<LegalSection
				id="accounts"
				number={n("accounts")}
				title="Accounts, keys and your organization"
			>
				<p>
					Your account belongs to an organization, which is the billing and API-key
					boundary. Keys authenticate as the organization, so anyone holding one acts
					as you. An organization has one member today.
				</p>
				<p>
					Keep your keys secret. We store only a hash, so we cannot recover a lost
					key — rotate it from the dashboard. You are responsible for activity under
					your keys until you revoke them, and you should revoke immediately if one
					is exposed.
				</p>
			</LegalSection>

			<LegalSection
				id="plans"
				number={n("plans")}
				title="Plans, and what each licenses"
			>
				<p>
					Plans and prices are published on the{" "}
					<Link className="underline underline-offset-4" to="/pricing">
						pricing page
					</Link>{" "}
					and are the operative figures. The plans differ by who the data is for:
				</p>
				<div className="overflow-x-auto rounded-lg border border-slate-200">
					<table className="w-full min-w-lg border-collapse text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className="px-4 py-2 font-semibold">Plan</th>
								<th className="px-4 py-2 font-semibold">Price</th>
								<th className="px-4 py-2 font-semibold">What it licenses</th>
							</tr>
						</thead>
						<tbody>
							<tr className="border-t border-slate-100 align-top">
								<td className="px-4 py-2 font-medium text-neutral-900">
									{FREE_TIER.name}
								</td>
								<td className="px-4 py-2">Free</td>
								<td className="px-4 py-2">
									<p>{FREE_TIER.summary}</p>
									<ul className="mt-1 list-disc pl-5">
										{FREE_TIER.permits.map((line) => (
											<li key={line}>{line}</li>
										))}
									</ul>
								</td>
							</tr>
							{PLANS.map((plan) => (
								<tr className="border-t border-slate-100 align-top" key={plan.id}>
									<td className="px-4 py-2 font-medium text-neutral-900">{plan.name}</td>
									<td className="px-4 py-2">
										{plan.sale.kind === "checkout"
											? `$${plan.sale.priceUsdMonthly}/month`
											: "By agreement"}
									</td>
									<td className="px-4 py-2">
										<p>{plan.summary}</p>
										<ul className="mt-1 list-disc pl-5">
											{plan.permits.map((line) => (
												<li key={line}>{line}</li>
											))}
										</ul>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p>
					<strong className="text-neutral-900">Individual</strong> is for a natural
					person using the data on their own account. Using it for an employer or for
					clients is <strong className="text-neutral-900">Team</strong>, even if you
					pay personally.
				</p>
				<p>
					On Team, excerpts in your own client reports and presentations must be
					attributed to Safe Rate and must not amount to a copy of the feed. Showing
					the data to the public, or inside a product, feed, app or agent your
					customers use, and launching a product built to track an index (an ETF, an
					index fund, or a product whose payout references an index level), need an
					Enterprise agreement. Naming an index as a benchmark, a prospectus
					included, does not.
				</p>
			</LegalSection>

			<LegalSection
				id="payment"
				number={n("payment")}
				title="Payment, beta codes and cancellation"
			>
				<p>
					Fees are in U.S. dollars, billed monthly in advance through Stripe, and
					exclusive of taxes. Each plan has a rate limit, stated on the pricing page;
					requests above it are refused rather than billed.
				</p>
				<p>
					A beta or promotion code discounts a plan for as long as we offer it. We
					may end a code, and we will give you at least {BETA_END_NOTICE_DAYS} days'
					notice before removing a discount from your subscription. If no payment
					method is on file when a discount ends, your access stops until you add
					one.
				</p>
				<p>
					You can cancel at any time, effective at the end of the paid period. We do
					not refund partial months. If a payment fails we will tell you before we
					suspend anything.
				</p>
			</LegalSection>

			<LegalSection
				id="data"
				number={n("data")}
				title="The data, and where it comes from"
			>
				<p>
					Prices and security terms come from public U.S. Treasury sources, including
					TreasuryDirect and FedInvest. The fitted curves, the analytics and the
					indices are computed by Safe Rate from that data. The indices are
					constructed by Safe Rate and are not official U.S. Treasury statistics.
				</p>
				<p>
					The service does not provide economic series licensed to third parties, or
					swap data, and nothing in your plan licenses either.
				</p>
			</LegalSection>

			<LegalSection
				id="acceptable-use"
				number={n("acceptable-use")}
				title="What you may not do"
			>
				<p>
					Each rule below says where it comes from, so you know which are our
					decisions and which are obligations we cannot waive.
				</p>
				{PROHIBITED_USES.map((use) => (
					<Callout key={use.rule} title={use.rule}>
						<p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
							{RULE_ORIGIN_LABEL[use.origin]}
						</p>
						<p>{use.why}</p>
					</Callout>
				))}
				<p>
					Also the ordinary ones: do not break the law, do not attack or probe the
					service, and do not attempt to circumvent authentication.
				</p>
			</LegalSection>

			<LegalSection id="advice" number={n("advice")} title="Not investment advice">
				<p>
					Nothing in the service is investment, tax, legal or accounting advice, a
					recommendation, or an offer to buy or sell any security. Figures, including
					rich and cheap measures against the fitted curve, are descriptions of
					published data, not predictions or recommendations. You are responsible for
					your own decisions and for any advice you give your clients.
				</p>
			</LegalSection>

			<LegalSection
				id="accuracy"
				number={n("accuracy")}
				title="Accuracy, and what we do not warrant"
			>
				<p>
					The service is provided as is and as available. To the fullest extent the
					law allows, we disclaim all implied warranties, including merchantability,
					fitness for a particular purpose, title and non-infringement. We do not
					warrant that the service will be uninterrupted or error-free.
				</p>
				<p>
					Figures are end-of-day records, not live prices. Fitted curves carry a fit
					error, which the API reports. Recent daily index levels can be provisional
					and may be revised; month-end levels are final. We correct published
					figures when we find an error, and a correction can change history you have
					already retrieved.
				</p>
				<Callout title="What we do commit to, notwithstanding the above">
					<p>
						Every figure carries the date it is for, and the API says when a value is
						provisional, not computed, or absent rather than returning a zero in its
						place.
					</p>
				</Callout>
			</LegalSection>

			<LegalSection id="ip" number={n("ip")} title="Intellectual property">
				<p>
					We own the service: the software, the fitted curves and analytics, the
					indices, their names and tickers, the site and the brand. Nothing here
					transfers that to you.
				</p>
				<p>
					The underlying public Treasury data is not ours to own, and we make no
					claim to it. Your plan is a license to use what you retrieve as section{" "}
					{n("plans")} describes. Feedback you send us, we may use freely and without
					obligation.
				</p>
			</LegalSection>

			<LegalSection
				id="confidentiality"
				number={n("confidentiality")}
				title="Confidentiality and your data"
			>
				<p>
					Anything you send us that is not public — your queries, your configuration,
					your business context — we treat as confidential and use only to operate
					the service and support you. We do not sell it and we do not train models
					on it.
				</p>
				<p>
					We do produce aggregate operational statistics: total request volumes,
					error rates, latency. Those never identify you or your queries.
				</p>
			</LegalSection>

			<LegalSection
				id="availability"
				number={n("availability")}
				title="Availability and support"
			>
				<p>
					We do not offer a service level agreement on the Individual or Team plans.
					If you need one, that is an Enterprise agreement, in a signed order rather
					than implied here.
				</p>
				<p>
					We may change, deprecate or remove parts of the API. For a breaking change
					to a generally available endpoint we will give at least{" "}
					{BREAKING_CHANGE_NOTICE_DAYS} days' notice to account holders.
				</p>
				<p>
					Support is by email at{" "}
					<a className="underline underline-offset-4" href={`mailto:${email}`}>
						{email}
					</a>
					, on commercially reasonable efforts.
				</p>
			</LegalSection>

			<LegalSection
				id="liability"
				number={n("liability")}
				title="Limitation of liability"
			>
				<p>
					Neither party is liable for indirect, incidental, special, consequential or
					punitive damages, or for lost profits, revenue, trading losses, data or
					goodwill, even if told such damages were possible.
				</p>
				<p>
					Our total liability arising out of or relating to this agreement is limited
					to the greater of the fees you paid us in the {LIABILITY.capMonths} months
					before the claim arose, and ${LIABILITY.capFloorUsd}.
				</p>
				<p>
					These limits do not apply to your obligation to pay fees, to either party's
					fraud or wilful misconduct, or to anything the law does not permit us to
					limit. Some jurisdictions do not allow some of these exclusions, in which
					case they apply to the extent permitted.
				</p>
			</LegalSection>

			<LegalSection id="indemnity" number={n("indemnity")} title="Indemnity">
				<p>
					You will defend and indemnify us against third-party claims arising from
					your use of the service in breach of these terms, in particular a use
					beyond your plan (section {n("plans")}) or a breach of section{" "}
					{n("acceptable-use")}.
				</p>
				<p>
					We will defend and indemnify you against a third-party claim that the
					service as provided by us infringes their intellectual property, unless the
					claim arises from your combination of it with something else or from your
					breach of these terms.
				</p>
			</LegalSection>

			<LegalSection
				id="term"
				number={n("term")}
				title="Term, suspension and termination"
			>
				<p>
					This agreement runs while you have an account. Either of us may terminate
					it at any time; yours takes effect at the end of the paid period.
				</p>
				<p>
					We may suspend your access immediately for non-payment, for a security
					risk, or for a breach of section {n("acceptable-use")} that is causing
					harm. Where the circumstances allow it, we will tell you first and give you
					a chance to fix it.
				</p>
				<p>
					On termination your access stops. {RETENTION_AFTER_TERMINATION} Sections{" "}
					{[
						"data",
						"advice",
						"accuracy",
						"ip",
						"confidentiality",
						"liability",
						"indemnity",
						"law",
					]
						.map(n)
						.join(", ")}{" "}
					survive.
				</p>
			</LegalSection>

			<LegalSection id="law" number={n("law")} title="Governing law and disputes">
				<p>
					These terms are governed by the laws of the State of {GOVERNING_LAW.state}{" "}
					and applicable federal law, without regard to conflict-of-laws rules. Both
					parties submit to the exclusive jurisdiction of the state and federal
					courts located in {GOVERNING_LAW.venue}.
				</p>
				<p>
					There is no arbitration clause and no class-action waiver in this
					agreement. If we have a dispute, we would rather resolve it directly first
					— email us before you file.
				</p>
			</LegalSection>

			<LegalSection id="general" number={n("general")} title="General">
				<p>
					These terms, together with the privacy policy and any signed order, are the
					entire agreement between us and supersede anything said before. A signed
					order controls where it conflicts with this page.
				</p>
				<p>
					If a provision is unenforceable, the rest stands. Not enforcing something
					once does not waive it. You may not assign this agreement without our
					consent; we may assign it in a merger or sale of the business. Neither of
					us is liable for a failure caused by something genuinely outside our
					control. Nothing here creates a partnership, agency or employment
					relationship, and there are no third-party beneficiaries.
				</p>
			</LegalSection>

			<LegalSection
				id="changes"
				number={n("changes")}
				title="Changes to these terms"
			>
				<p>
					We may update these terms. The effective date at the top changes when we
					do. For a material change we will email account holders at least{" "}
					{MATERIAL_CHANGE_NOTICE_DAYS} days before it takes effect, and continuing
					to use the service after that means you accept it. If you do not, cancel
					before it applies.
				</p>
				<p>
					Section {n("plans")} is generated from our plan catalog, so it changes when
					a plan does. A change that narrows your rights is a material change and
					gets the notice above; one that widens them takes effect immediately.
				</p>
			</LegalSection>
		</LegalPage>
	);
}
