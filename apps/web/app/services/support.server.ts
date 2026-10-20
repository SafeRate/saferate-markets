import { isTrialActive } from "@markets/schema";

/**
 * The /support page's accounts: each user with its organization's plan, its
 * email alerts and when it last signed in. Read-only.
 *
 * Better Auth writes user and session dates as ISO text through the D1 adapter
 * (supportsDates false); day() also reads epoch ms, in case a row has one.
 * Last sign-in counts only the account's own sessions, not an admin's
 * impersonation of it.
 */

const day = (column: string) =>
	`case when typeof(${column}) = 'text' then substr(${column}, 1, 10) when ${column} is null then null else date(${column} / 1000, 'unixepoch') end`;

/** Safe Rate's own addresses, marked so the outside accounts stand out. */
const INTERNAL = /@saferate\.com$/i;

type TRow = {
	idUser: string;
	email: string;
	emailVerified: number;
	role: string | null;
	createdOn: string | null;
	lastSignInOn: string | null;
	trialEndsAt: number | null;
	idPlan: string | null;
	statusSubscription: string | null;
	endedAt: number | null;
	rundown: number;
	auctionResults: number;
	auctionAnnouncements: number;
	paused: number;
};

export type TSupportAccount = ReturnType<typeof toAccount>;

const toAccount = (r: TRow, now: number) => {
	const live =
		r.statusSubscription !== null &&
		r.endedAt === null &&
		!["canceled", "incomplete_expired"].includes(r.statusSubscription);
	return {
		idUser: r.idUser,
		email: r.email,
		isVerified: r.emailVerified === 1,
		isAdmin: r.role === "admin",
		isInternal: INTERNAL.test(r.email),
		createdOn: r.createdOn,
		lastSignInOn: r.lastSignInOn,
		plan: live
			? `${r.idPlan} (${r.statusSubscription})`
			: isTrialActive(r.trialEndsAt, now)
				? `Team trial to ${new Date(r.trialEndsAt as number).toISOString().slice(0, 10)}`
				: "Free",
		rundown: r.rundown === 1,
		auctionResults: r.auctionResults === 1,
		auctionAnnouncements: r.auctionAnnouncements === 1,
		isPaused: r.paused === 1,
	};
};

export const listSupportAccounts = async (input: {
	db: D1Database;
	search: string;
	now?: number;
}) => {
	const { results } = await input.db
		.prepare(
			`select u.id as idUser, u.email, u.emailVerified, u.role,
			        ${day("u.createdAt")} as createdOn,
			        (select ${day("max(s.createdAt)")} from session s
			          where s.userId = u.id and s.impersonatedBy is null) as lastSignInOn,
			        o.trialEndsAt, os.idPlan, os.statusSubscription, os.endedAt,
			        coalesce(p.rundown, 1) as rundown,
			        coalesce(p.auctionResults, 0) as auctionResults,
			        coalesce(p.auctionAnnouncements, 0) as auctionAnnouncements,
			        coalesce(p.paused, 0) as paused
			   from user u
			   left join organizationMembers m on m.idUser = u.id
			   left join organizations o on o.idOrganization = m.idOrganization
			   left join organizationSubscriptions os on os.idOrganization = o.idOrganization
			   left join alertPreferences p on p.idUser = u.id
			  where ? = '' or lower(u.email) like '%' || lower(?) || '%'
			  order by u.createdAt desc
			  limit 200`,
		)
		.bind(input.search, input.search)
		.all<TRow>();
	const now = input.now ?? Date.now();
	return results.map((r) => toAccount(r, now));
};
