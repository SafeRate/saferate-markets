import {
	ACCOUNT_DELETION_DAYS,
	AGE_MINIMUM,
	AUDIENCE_POSITION,
	LEGAL_ENTITY,
	PATHS_NOT_PUBLIC,
	RIGHTS_RESPONSE_DAYS,
	TRACKING_TOOLS,
	USAGE_RETENTION,
} from "@markets/schema";
import { Link } from "react-router";
import { Callout, LegalPage, LegalSection } from "@/components/LegalPage";
import type { Route } from "./+types/privacy";

export const meta: Route.MetaFunction = () => [
	{ title: `Privacy policy — ${LEGAL_ENTITY.nameProduct}` },
];

/**
 * The privacy policy. Structure and the shared sections follow OKLocate's. Every
 * category in section 3 corresponds to a table in packages/persistence
 * migrations, named so the page can be checked against the schema. The tools in
 * section 4 come from TRACKING_TOOLS and the untracked pages from
 * PATHS_NOT_PUBLIC, the same values that decide whether the scripts load, so the
 * policy and the code cannot disagree. NOT reviewed by counsel.
 */

const SECTIONS = [
	{ id: "short", title: "The short version" },
	{ id: "scope", title: "Who this covers" },
	{ id: "collect", title: "What we collect about you" },
	{ id: "cookies", title: "Cookies and tracking" },
	{ id: "vendors", title: "Who else touches it" },
	{ id: "retention", title: "How long we keep it" },
	{ id: "security", title: "How we protect it" },
	{ id: "rights", title: "Your rights, and how to use them" },
	{ id: "california", title: "California" },
	{ id: "europe", title: "Europe and the UK" },
	{ id: "children", title: "Children" },
	{ id: "changes", title: "Changes to this policy" },
];

const n = (id: string) => SECTIONS.findIndex((s) => s.id === id) + 1;

type TCategory = {
	title: string;
	tables: string;
	items: string[];
	why: string;
	basis: string;
	kept: string;
};

const CATEGORIES: TCategory[] = [
	{
		title: "Account identity",
		tables: "user · account · verification",
		items: [
			"Your email address, which is required: it is how you sign in",
			"A display name and avatar image, if you provide them",
			"Whether the email address has been verified",
		],
		why: "To create your account, sign you in, and tell one account from another.",
		basis: "Performance of our contract with you",
		kept: `For as long as the account exists, then deleted within ${ACCOUNT_DELETION_DAYS} days of a deletion request.`,
	},
	{
		title: "Sign-in sessions",
		tables: "session",
		items: [
			"A session token stored in a cookie on your device",
			"The IP address and browser user-agent the session was created from",
			"When the session expires",
		],
		why: "To keep you signed in, and to tell a legitimate session from a stolen one.",
		basis: "Our legitimate interests",
		kept: "Until the session expires or you sign out.",
	},
	{
		title: "Organization and subscription",
		tables:
			"organizations · organizationMembers · organizationSubscriptions · subscription",
		items: [
			"Your organization's name, and that you are its member",
			"Its plan, subscription status and any cancellation date",
			"The identifiers of its customer and subscription at our payment processor",
		],
		why: "An organization is the billing and API-key boundary, and its plan decides access and rate limit.",
		basis: "Performance of our contract with you",
		kept: "For the life of the organization.",
	},
	{
		title: "API keys",
		tables: "apiKeys",
		items: [
			"The label you gave the key, and its first few non-secret characters",
			"A SHA-256 hash of the key, never the key itself",
			"Who created it, when it was last used, whether it is revoked or rotated out",
		],
		why: "To authenticate requests and to let you recognize your own keys.",
		basis: "Performance of our contract with you",
		kept:
			"Revoked keys are kept as a record that they existed, for the life of the organization.",
	},
	{
		title: "API usage records",
		tables: "apiUsageEvents · apiUsageMonthly",
		items: [
			"One record per request: REST or MCP, the route pattern or tool name, the response status and how long it took",
			"Which API key made it",
			"Monthly totals derived from those records",
		],
		why: "To show you your usage and to operate and protect the service.",
		basis: "Performance of our contract with you",
		kept: USAGE_RETENTION,
	},
	{
		title: "Portfolio holdings, liabilities and plans",
		tables:
			"portfolios · portfolioTransactions · liabilityStreams · liabilityCashflows · builderPlans",
		items: [
			"The portfolios you create: a name, a benchmark index and how income is treated",
			"The trades you enter or upload: CUSIP, buy or sell, dates, face amount, price, and an account label if you give one",
			"Which of your team entered each trade, and whether it came from a file",
			"Liability streams you save: a name, and the dates, amounts and labels of the payments",
			"Plans you save in the Portfolio Builder: the inputs used and the recommended positions at the prices then",
		],
		why: "To value your portfolios and compute their returns, income and risk. Nothing else: holdings are not used to price, rank or recommend anything for anyone else, and are not shared or sold.",
		basis: "Performance of our contract with you",
		kept: `Until you delete the trade or the portfolio, which removes it permanently, or ${ACCOUNT_DELETION_DAYS} days after a request to delete your account.`,
	},
];

export default function Privacy() {
	const email = LEGAL_ENTITY.emailContact;
	return (
		<LegalPage
			kicker="Legal"
			lead={
				<p>
					What {LEGAL_ENTITY.nameProduct} holds about you, why, who else touches it,
					and what you can ask us to do about it. Written against the actual database
					schema rather than from a template.
				</p>
			}
			sections={SECTIONS}
			title="Privacy policy"
		>
			<LegalSection id="short" number={n("short")} title="The short version">
				<ul className="list-disc space-y-2 pl-5">
					<li>
						We do not sell your personal information. Our analytics tools may count as
						sharing under California law, so you can turn them off in one click and we
						honor Global Privacy Control automatically.
					</li>
					<li>
						We use {TRACKING_TOOLS.map((t) => t.name).join(" and ")} on our public
						pages only. Nothing third-party runs once you sign in: your dashboard,
						your usage and your API keys are never sent to an analytics vendor.
					</li>
					<li>
						Our usage records note which route or tool you called, not the securities
						or dates you asked about.
					</li>
					<li>
						Portfolios and trades you enter are yours: kept only to compute your
						analytics, never shared or sold, and deleted when you delete them.
					</li>
					<li>We do not train models on your queries, and we do not sell them.</li>
				</ul>
			</LegalSection>

			<LegalSection id="scope" number={n("scope")} title="Who this covers">
				<p>
					{LEGAL_ENTITY.nameProduct} is a product of {LEGAL_ENTITY.nameLegal}, a{" "}
					{LEGAL_ENTITY.form} with its office in {LEGAL_ENTITY.addressCity},{" "}
					{LEGAL_ENTITY.addressState}. {LEGAL_ENTITY.nameLegal} is the data
					controller for everything described here.
				</p>
				<p>
					It applies to {LEGAL_ENTITY.hostSite}, to the API and MCP server at{" "}
					{LEGAL_ENTITY.hostApi}, and to the email we send you. It does not apply to
					other Safe Rate products, which publish their own policies.
				</p>
			</LegalSection>

			<LegalSection
				id="collect"
				number={n("collect")}
				title="What we collect about you"
			>
				<p>
					Every category corresponds to tables in our database, which are named so
					this page can be checked against the schema rather than taken on trust.
				</p>
				{CATEGORIES.map((c) => (
					<div className="rounded-lg border border-slate-200 p-5" key={c.title}>
						<h3 className="font-semibold text-neutral-900">{c.title}</h3>
						<p className="mt-1 font-mono text-xs text-slate-500">{c.tables}</p>
						<ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
							{c.items.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
						<dl className="mt-3 grid grid-cols-1 gap-1 text-sm sm:grid-cols-[6rem_1fr]">
							<dt className="font-medium text-neutral-900">Why</dt>
							<dd>{c.why}</dd>
							<dt className="font-medium text-neutral-900">Basis</dt>
							<dd>{c.basis}</dd>
							<dt className="font-medium text-neutral-900">Kept</dt>
							<dd>{c.kept}</dd>
						</dl>
					</div>
				))}
				<Callout title="What we deliberately do not record">
					<p>
						Our usage records store the route pattern, such as{" "}
						<code className="font-mono">/v1/securities/:cusip</code>, and for MCP the
						tool name, not the CUSIPs, dates or arguments you sent. Which securities
						you look at is commercially revealing, so it is not kept in our records.
						Looking a security up, in the dashboard or the API, is not recorded;
						trades you enter in a portfolio are, because you asked us to keep them
						(Portfolio holdings, above).
					</p>
					<p>
						Our hosting provider's request logs do contain full request URLs, as any
						web server's do. They are kept for a short period and used only to operate
						the service and investigate abuse.
					</p>
				</Callout>
				<p>
					Card details are entered on our payment processor's page and never reach
					us. We hold only the identifiers above.
				</p>
			</LegalSection>

			<LegalSection
				id="cookies"
				number={n("cookies")}
				title="Cookies and tracking"
			>
				<p>
					Two strictly necessary cookies: the session token that keeps you signed in,
					and one that remembers if you turned analytics off. Neither does anything
					else.
				</p>
				<p>
					On our public pages we also use the tools below. Refusing them changes
					nothing about the service you receive.{" "}
					<Link className="underline underline-offset-4" to="/privacy-choices">
						Your privacy choices
					</Link>{" "}
					shows what is running for your browser and turns it off.
				</p>
				{TRACKING_TOOLS.map((tool) => (
					<Callout key={tool.id} title={`${tool.name} (${tool.vendor})`}>
						<p>{tool.purpose}</p>
					</Callout>
				))}
				<p>
					If your browser sends a Global Privacy Control signal, we treat that as
					turning them off and you do not have to tell us again.
				</p>
				<Callout title="Nothing third-party runs once you sign in">
					<p>
						Analytics and session replay never load on {PATHS_NOT_PUBLIC.join(", ")}.
						This is a security control: a session recorder captures what is on screen,
						and an API key is shown in full exactly once, when you create it.
					</p>
				</Callout>
			</LegalSection>

			<LegalSection id="vendors" number={n("vendors")} title="Who else touches it">
				<p>
					We do not sell your personal information. The vendors below process data on
					our behalf. The analytics vendors are the exception to "only on our
					behalf": their terms let them use what they collect for their own purposes,
					which is why section {n("california")} treats them as sharing and why they
					are confined to public pages and can be turned off.
				</p>
				<div className="overflow-x-auto rounded-lg border border-slate-200">
					<table className="w-full min-w-lg border-collapse text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className="px-4 py-2 font-semibold">Vendor</th>
								<th className="px-4 py-2 font-semibold">Role</th>
								<th className="px-4 py-2 font-semibold">What it sees</th>
							</tr>
						</thead>
						<tbody className="align-top">
							{[
								[
									"Cloudflare, Inc.",
									"Hosting, database, and outbound email",
									"Everything in section 3, and request logs. Sign-in emails are sent through it.",
								],
								[
									"Stripe, Inc.",
									"Payments and subscriptions",
									"Your email, payment details you enter on its page, and your subscription.",
								],
								[
									"Google LLC (Google Workspace)",
									"Business email",
									"Anything you choose to send us by email, including support and privacy requests.",
								],
								[
									"Google LLC (Google Analytics)",
									"Website analytics",
									"Pages visited on our public pages, referrer, approximate location and device. Not the dashboard.",
								],
								[
									"Microsoft Corporation (Clarity)",
									"Heatmaps and session replay",
									"How our public pages are used: clicks, scrolling, layout. Never the dashboard or sign-in. Microsoft describes itself as a controller for this data.",
								],
							].map(([vendor, role, sees]) => (
								<tr className="border-t border-slate-100" key={vendor}>
									<td className="px-4 py-2 font-medium text-neutral-900">{vendor}</td>
									<td className="px-4 py-2">{role}</td>
									<td className="px-4 py-2">{sees}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p>
					Beyond those, we disclose personal information only when the law requires
					it, or to establish or defend a legal claim. If we are compelled to hand
					over your data we will tell you, unless we are legally prohibited from
					doing so. If {LEGAL_ENTITY.nameLegal} is acquired or merged, your data
					would transfer with the business under this policy or one at least as
					protective.
				</p>
			</LegalSection>

			<LegalSection
				id="retention"
				number={n("retention")}
				title="How long we keep it"
			>
				<p>
					Retention is stated per category in section {n("collect")}. Our payment
					processor keeps billing records under its own obligations, including the
					tax and accounting rules that apply to it. Session replays expire on the
					vendor's own schedule, which Microsoft states as 30 days for most
					recordings.
				</p>
			</LegalSection>

			<LegalSection id="security" number={n("security")} title="How we protect it">
				<p>
					API keys are never stored. We keep a SHA-256 hash and a short non-secret
					prefix, which is enough to authenticate a request and to let you recognize
					your keys. A key is displayed in full exactly once, when you create it. If
					you lose it, rotate it: we cannot recover it for you, and that is the
					point.
				</p>
				<p>
					Everything travels over TLS, and access to production data is limited to
					the people who need it. No system is perfectly secure, and we would rather
					say that plainly. If we discover a breach affecting your personal
					information we will notify you and the relevant regulators as the law
					requires.
				</p>
			</LegalSection>

			<LegalSection
				id="rights"
				number={n("rights")}
				title="Your rights, and how to use them"
			>
				<p>
					Email{" "}
					<a className="underline underline-offset-4" href={`mailto:${email}`}>
						{email}
					</a>
					. We respond within {RIGHTS_RESPONSE_DAYS} days, we will not charge you for
					a request, and we will not treat you differently for making one. You can
					ask for access to what we hold, correction, deletion of your account
					(within {ACCOUNT_DELETION_DAYS} days), a machine-readable copy, or to
					object to or restrict processing based on our legitimate interests. You may
					also complain to your supervisory authority or state Attorney General; we
					would rather you told us first, but that is your choice.
				</p>
				<p>
					One limit on deletion we would rather state than bury: the session-replay
					provider offers no way to delete one person's recordings, only an entire
					project. They expire on their own; if you want them gone sooner, ask and we
					will delete the whole project.
				</p>
			</LegalSection>

			<LegalSection id="california" number={n("california")} title="California">
				<p>
					If you are a California resident, the CCPA as amended by the CPRA gives you
					the rights to know, delete, correct, and to opt out of sale or sharing,
					plus the right to limit the use of sensitive personal information.
				</p>
				<p>
					We do not sell personal information. Our analytics tools set cookies their
					vendors may use for their own purposes, which California treats as sharing;
					we treat it as though it is. You can turn them off from{" "}
					<Link className="underline underline-offset-4" to="/privacy-choices">
						your privacy choices
					</Link>
					, and we honor Global Privacy Control automatically, without asking where
					you live. We collect no sensitive personal information as the law defines
					it. You may use an authorized agent to exercise these rights.
				</p>
			</LegalSection>

			<LegalSection id="europe" number={n("europe")} title="Europe and the UK">
				<p>
					{AUDIENCE_POSITION.summary} So we do not treat the GDPR or the UK GDPR as
					applying to us, which is why analytics are opt-out rather than behind a
					consent banner. If we begin selling there, analytics move to prior opt-in.
				</p>
				<p>
					That is no reason to hold your data differently, so we do not: the lawful
					basis for each category is in section {n("collect")}, and the rights in
					section {n("rights")} are open to you wherever you live. Processing takes
					place in the United States. If you need a data processing agreement or
					European data residency, say so before you subscribe; today the honest
					answer is that we are not set up for it.
				</p>
			</LegalSection>

			<LegalSection id="children" number={n("children")} title="Children">
				<p>
					This is a business product, not directed at children, and you must be at
					least {AGE_MINIMUM} to hold an account. If we learn we have collected
					personal information from anyone younger, we delete it.
				</p>
			</LegalSection>

			<LegalSection
				id="changes"
				number={n("changes")}
				title="Changes to this policy"
			>
				<p>
					When we change this policy we update the effective date at the top. If a
					change materially reduces your rights or expands what we collect, we will
					email account holders before it takes effect. A new vendor in section{" "}
					{n("vendors")} is a change we announce, not one you discover.
				</p>
			</LegalSection>
		</LegalPage>
	);
}
