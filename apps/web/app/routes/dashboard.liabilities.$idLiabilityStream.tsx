import {
	deleteLiabilityStream,
	getLiabilityStream,
	saveLiabilityStream,
} from "@markets/persistence";
import { PRODUCT_NAME } from "@markets/schema";
import { data, Form, Link, redirect } from "react-router";
import { LiabilityInputFields } from "@/components/LiabilityInputFields";
import { money } from "@/lib/format";
import { readLiabilityInput } from "@/lib/liabilityInput";
import { requireOrganization } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.liabilities.$idLiabilityStream";

export const meta: Route.MetaFunction = ({ data: loaded }) => [
	{
		title: `${loaded?.stream.nameLiabilityStream ?? "Liabilities"} — ${PRODUCT_NAME}`,
	},
];

export const loader = async ({
	request,
	context,
	params,
}: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const org = await requireOrganization(request, env);
	const stream = await getLiabilityStream({
		db: env.DB,
		idOrganization: org.idOrganization,
		idLiabilityStream: params.idLiabilityStream,
	});
	if (stream === null) throw data("No such liability stream.", { status: 404 });
	return { stream };
};

export const action = async ({
	request,
	context,
	params,
}: Route.ActionArgs) => {
	const env = context.cloudflare.env;
	const org = await requireOrganization(request, env);
	const scope = {
		db: env.DB,
		idOrganization: org.idOrganization,
		idLiabilityStream: params.idLiabilityStream,
	};
	const form = await request.formData();
	if (String(form.get("intent")) === "delete") {
		if (form.get("confirm") !== "yes")
			return { errors: ["Tick the box to confirm the delete."], saved: false };
		await deleteLiabilityStream(scope);
		return redirect("/dashboard/liabilities");
	}
	const name = String(form.get("name") ?? "").trim();
	if (name === "") return { errors: ["Give the stream a name."], saved: false };
	const read = await readLiabilityInput(form);
	if (!read.ok) return { errors: read.errors, saved: false };
	await saveLiabilityStream({
		...scope,
		nameLiabilityStream: name,
		cashflows: read.rows.map((r) => ({
			dueDate: r.dueDate,
			amount: r.amount,
			label: r.label,
		})),
	});
	return { errors: [] as string[], saved: true };
};

const field =
	"mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm";

export default function LiabilityStream({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const { stream } = loaderData;
	const lines = stream.cashflows
		.map(
			(c) =>
				`${c.dueDate}, ${c.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}${c.label ? `, ${c.label}` : ""}`,
		)
		.join("\n");
	const total = stream.cashflows.reduce((s, c) => s + c.amount, 0);
	return (
		<main className="max-w-4xl">
			<p className="text-sm">
				<Link
					className="text-primary underline-offset-4 hover:underline"
					to="/dashboard/liabilities"
				>
					← Liabilities
				</Link>
			</p>
			<div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
				<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
					{stream.nameLiabilityStream}
				</h1>
				<Link
					className="rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
					to={`/dashboard/builder?mode=match&stream=${stream.idLiabilityStream}`}
				>
					Fund it in the Builder
				</Link>
			</div>
			<p className="mt-1 text-sm text-slate-600">
				{stream.cashflows.length} payments totalling {money(total)},{" "}
				{stream.cashflows[0]?.dueDate} to {stream.cashflows.at(-1)?.dueDate}.
			</p>

			<div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
				<table className="w-full text-sm">
					<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
						<tr>
							<th className="px-4 py-2 font-semibold">Due</th>
							<th className="px-4 py-2 text-right font-semibold">Amount</th>
							<th className="px-4 py-2 font-semibold">Label</th>
						</tr>
					</thead>
					<tbody>
						{stream.cashflows.map((c) => (
							<tr className="border-t border-slate-100" key={c.idLiabilityCashflow}>
								<td className="tabular px-4 py-2">{c.dueDate}</td>
								<td className="tabular px-4 py-2 text-right">{money(c.amount, 2)}</td>
								<td className="px-4 py-2 text-slate-600">{c.label ?? ""}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<section className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
				<h2 className="font-semibold text-neutral-900">Edit</h2>
				<p className="mt-1 text-sm text-slate-600">
					Saving replaces the whole schedule with what is below.
				</p>
				<Form
					className="mt-4 space-y-3"
					encType="multipart/form-data"
					method="post"
				>
					<label className="block text-sm font-medium text-slate-700">
						Name
						<input
							className={field}
							defaultValue={stream.nameLiabilityStream}
							maxLength={80}
							name="name"
							required
						/>
					</label>
					<LiabilityInputFields defaultLines={lines} />
					{actionData?.errors.length ? (
						<ul className="space-y-1 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
							{actionData.errors.map((e) => (
								<li key={e}>{e}</li>
							))}
						</ul>
					) : null}
					{actionData?.saved ? (
						<p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
							Saved.
						</p>
					) : null}
					<button
						className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
						type="submit"
					>
						Save
					</button>
				</Form>
				<Form className="mt-6 border-t border-slate-100 pt-4" method="post">
					<input name="intent" type="hidden" value="delete" />
					<label className="mr-3 text-sm text-slate-600">
						<input className="mr-1" name="confirm" type="checkbox" value="yes" />
						Delete permanently; saved plans keep their positions but lose the link
					</label>
					<button
						className="text-sm text-red-700 underline underline-offset-4"
						type="submit"
					>
						Delete this stream
					</button>
				</Form>
			</section>
		</main>
	);
}
