import {
	createApiKey,
	describeApiKey,
	listApiKeys,
	revokeApiKey,
	rotateApiKey,
} from "@markets/persistence";
import { PRODUCT_NAME, resolveMarketsEnv, SITE_HOSTS } from "@markets/schema";
import { Form, useNavigation } from "react-router";
import { requireOrganization } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.keys";

export const meta: Route.MetaFunction = () => [
	{ title: `API keys | ${PRODUCT_NAME}` },
];

export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const org = await requireOrganization(request, env);
	return {
		organizationName: org.nameOrganization,
		apiBase: SITE_HOSTS[resolveMarketsEnv(env.MARKETS_ENV)].api,
		keys: await listApiKeys({ db: env.DB, idOrganization: org.idOrganization }),
	};
};

export const action = async ({ request, context }: Route.ActionArgs) => {
	const env = context.cloudflare.env;
	const org = await requireOrganization(request, env);
	const { idOrganization } = org;

	const formData = await request.formData();
	const intent = String(formData.get("intent") ?? "");

	if (intent === "create") {
		const nameApiKey = String(formData.get("nameApiKey") ?? "").trim();
		if (!nameApiKey) {
			return { status: "error" as const, message: "Give the key a name." };
		}
		const created = await createApiKey({
			db: env.DB,
			idOrganization,
			idUser: org.idUser,
			nameApiKey,
		});
		// Returned to the page ONCE. Never persisted, never in a redirect URL —
		// a key in a URL lands in browser history, the Referer header and any
		// intermediate log.
		return { status: "created" as const, key: created.key };
	}

	if (intent === "rotate") {
		const idApiKey = String(formData.get("idApiKey") ?? "");
		// Scoped to this organization inside rotateApiKey, so a guessed uuid cannot
		// rotate another customer's credential out from under them.
		const rotated = await rotateApiKey({
			db: env.DB,
			idOrganization,
			idApiKey,
			idUser: org.idUser,
		});
		if (!rotated) {
			return {
				status: "error" as const,
				message: "That key cannot be rotated. It may already be revoked.",
			};
		}
		// Same contract as creation: shown once, never persisted, never in a
		// redirect URL.
		return {
			status: "rotated" as const,
			key: rotated.key,
			expiresAt: rotated.expiresAt,
		};
	}

	if (intent === "revoke") {
		const idApiKey = String(formData.get("idApiKey") ?? "");
		// Scoped to this organization inside revokeApiKey, so a guessed uuid from
		// another customer cannot be revoked here.
		const didRevoke = await revokeApiKey({
			db: env.DB,
			idOrganization,
			idApiKey,
		});
		return didRevoke
			? { status: "revoked" as const }
			: { status: "error" as const, message: "That key was already revoked." };
	}

	return { status: "error" as const, message: "Unknown action." };
};

const fmtDate = (v: unknown) =>
	v === null || v === undefined
		? "—"
		: new Date(Number(v)).toISOString().slice(0, 10);

const DashboardKeys = ({ loaderData, actionData }: Route.ComponentProps) => {
	const { apiBase, keys, organizationName } = loaderData;
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";

	return (
		<main className="max-w-3xl">
			<a
				className="text-sm text-slate-500 transition-colors hover:text-slate-900"
				href="/dashboard"
			>
				← Back to dashboard
			</a>
			<p className="mt-6 text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
				{organizationName}
			</p>
			<h1 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900">
				API keys
			</h1>
			<p className="mt-3 max-w-xl text-muted-foreground">
				One key works for both the REST API and the MCP server at{" "}
				<code className="font-mono text-sm">{apiBase}/mcp</code>. Send it as{" "}
				<code className="font-mono text-sm">Authorization: Bearer</code>. A key is
				shown once, at creation. Only a hash of it is stored, so we cannot show it
				to you again.
			</p>
			<p className="mt-3 text-sm">
				<a className="text-primary underline underline-offset-4" href="/docs">
					Read the API and MCP documentation
				</a>{" "}
				<span className="text-muted-foreground">
					for every endpoint, the MCP tools, and how to connect Claude.
				</span>
			</p>

			{actionData?.status === "created" ? (
				<section className="mt-8 rounded-lg border border-primary bg-muted/40 p-4">
					<p className="text-sm font-medium">
						Copy this now. It will not be shown again.
					</p>
					<code className="mt-3 block overflow-x-auto rounded border border-border bg-background p-3 font-mono text-sm">
						{actionData.key}
					</code>
				</section>
			) : null}

			{actionData?.status === "rotated" ? (
				<section className="mt-8 rounded-lg border border-primary bg-muted/40 p-4">
					<p className="text-sm font-medium">
						Copy this now. It will not be shown again.
					</p>
					<code className="mt-3 block overflow-x-auto rounded border border-border bg-background p-3 font-mono text-sm">
						{actionData.key}
					</code>
					<p className="mt-3 text-sm text-muted-foreground">
						The key you rotated keeps working until{" "}
						<span className="font-medium text-foreground">
							{fmtDate(actionData.expiresAt)}
						</span>
						, so you can deploy this one before it stops. Revoke it now instead if it
						leaked.
					</p>
				</section>
			) : null}

			{actionData?.status === "error" ? (
				<p className="mt-6 text-sm text-muted-foreground">{actionData.message}</p>
			) : null}

			<Form
				className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-end"
				method="post"
			>
				<input name="intent" type="hidden" value="create" />
				<div className="flex-1">
					<label className="text-sm font-medium" htmlFor="nameApiKey">
						Name
					</label>
					<input
						className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
						id="nameApiKey"
						name="nameApiKey"
						placeholder="production backend"
						required
						type="text"
					/>
				</div>
				<button
					className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-60"
					disabled={isSubmitting}
					type="submit"
				>
					Create key
				</button>
			</Form>

			<section className="mt-12">
				<h2 className="text-lg font-semibold tracking-tight">Your keys</h2>
				{keys.length === 0 ? (
					<p className="mt-3 text-sm text-muted-foreground">
						No keys yet. Create one above.
					</p>
				) : (
					<div className="mt-4 overflow-x-auto">
						<table className="w-full min-w-2xl border-collapse text-sm">
							<thead>
								<tr className="border-b border-border text-left">
									<th className="py-2 pr-4 font-medium">Name</th>
									<th className="py-2 pr-4 font-medium">Key</th>
									<th className="py-2 pr-4 font-medium">Created</th>
									<th className="py-2 pr-4 font-medium">Last used</th>
									<th className="py-2 font-medium" />
								</tr>
							</thead>
							<tbody>
								{keys.map((k) => {
									const isRevoked = k.revokedAt !== null;
									// Still usable, but on a deadline from a rotation. Distinct
									// from revoked: this key is LIVE and traffic on it still
									// works, which is the whole point of the grace period.
									const isExpiring =
										!isRevoked && k.expiresAt !== null && k.expiresAt !== undefined;
									return (
										<tr
											className={`border-b border-border/60 ${isRevoked ? "opacity-50" : ""}`}
											key={k.idApiKey}
										>
											<td className="py-2 pr-4">{k.nameApiKey}</td>
											<td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
												{describeApiKey(k.prefixApiKey)}
											</td>
											<td className="py-2 pr-4 text-muted-foreground">
												{fmtDate(k.createdAt)}
											</td>
											<td className="py-2 pr-4 text-muted-foreground">
												{fmtDate(k.lastUsedAt)}
											</td>
											<td className="py-2 text-right">
												{isRevoked ? (
													<span className="text-xs text-muted-foreground">
														revoked {fmtDate(k.revokedAt)}
													</span>
												) : isExpiring ? (
													// Rotated out. Revoke is still offered — a key rotated
													// because it leaked should not have to wait out the
													// grace period — but Rotate is not, because rotating a
													// key that is already being replaced just creates a
													// third key and a second deadline.
													<span className="flex items-center justify-end gap-3">
														<span className="text-xs text-muted-foreground">
															stops working {fmtDate(k.expiresAt)}
														</span>
														<Form method="post">
															<input name="intent" type="hidden" value="revoke" />
															<input name="idApiKey" type="hidden" value={k.idApiKey} />
															<button
																className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
																type="submit"
															>
																Revoke now
															</button>
														</Form>
													</span>
												) : (
													<span className="flex items-center justify-end gap-3">
														<Form method="post">
															<input name="intent" type="hidden" value="rotate" />
															<input name="idApiKey" type="hidden" value={k.idApiKey} />
															<button
																className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
																type="submit"
															>
																Rotate
															</button>
														</Form>
														<Form method="post">
															<input name="intent" type="hidden" value="revoke" />
															<input name="idApiKey" type="hidden" value={k.idApiKey} />
															<button
																className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
																type="submit"
															>
																Revoke
															</button>
														</Form>
													</span>
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
				<p className="mt-4 max-w-xl text-xs text-muted-foreground">
					<span className="font-medium text-foreground">Rotate</span> issues a
					replacement and keeps this key working for seven more days, so you can
					deploy the new one without downtime.{" "}
					<span className="font-medium text-foreground">Revoke</span> stops it
					immediately — use that if a key leaked.
				</p>
				<p className="mt-3 max-w-xl text-xs text-muted-foreground">
					Revoking is immediate and permanent. Keys are revoked rather than deleted,
					so your usage history stays attributable.
				</p>
			</section>

			<p className="mt-10 text-sm">
				<a className="text-primary underline underline-offset-4" href="/dashboard">
					Back to dashboard
				</a>
			</p>
		</main>
	);
};

export default DashboardKeys;
