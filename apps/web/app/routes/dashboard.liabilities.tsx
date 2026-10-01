import {
	listLiabilityStreams,
	saveLiabilityStream,
} from "@markets/persistence";
import { PRODUCT_NAME } from "@markets/schema";
import { Form, Link, redirect, useNavigation } from "react-router";
import { LiabilityInputFields } from "@/components/LiabilityInputFields";
import { money } from "@/lib/format";
import { readLiabilityInput } from "@/lib/liabilityInput";
import { WriteGate } from "@/components/WriteGate";
import { requireDashboard } from "@/lib/session.server";
import type { Route } from "./+types/dashboard.liabilities";

export const meta: Route.MetaFunction = () => [
	{ title: `Liabilities — ${PRODUCT_NAME}` },
];

export const loader = async ({ request, context }: Route.LoaderArgs) => {
	const env = context.cloudflare.env;
	const org = await requireDashboard(request, env);
	return {
		streams: await listLiabilityStreams({
			db: env.DB,
			idOrganization: org.idOrganization,
		}),
	};
};

export const action = async ({ request, context }: Route.ActionArgs) => {
	const env = context.cloudflare.env;
	const org = await requireDashboard(request, env);
	const form = await request.formData();
	const name = String(form.get("name") ?? "").trim();
	if (name === "") return { errors: ["Give the stream a name."] };
	const read = await readLiabilityInput(form);
	if (!read.ok) return { errors: read.errors };
	const id = await saveLiabilityStream({
		db: env.DB,
		idOrganization: org.idOrganization,
		idLiabilityStream: null,
		nameLiabilityStream: name,
		cashflows: read.rows.map((r) => ({
			dueDate: r.dueDate,
			amount: r.amount,
			label: r.label,
		})),
	});
	return redirect(`/dashboard/liabilities/${id}`);
};

const field =
	"mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm";

export default function Liabilities({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const busy = useNavigation().state !== "idle";
	return (
		<main className="max-w-4xl">
			<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
				Liabilities
			</h1>
			<p className="mt-2 text-sm text-slate-600">
				Payment schedules to fund: a fund's distributions, a pension's benefits, a
				known future purchase. Saved here, a stream can be funded in the Portfolio
				Builder and checked against a portfolio's income.
			</p>
			{loaderData.streams.length > 0 ? (
				<div className="mt-8 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
					<table className="w-full text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className="px-4 py-2 font-semibold">Stream</th>
								<th className="px-4 py-2 text-right font-semibold">Payments</th>
								<th className="px-4 py-2 text-right font-semibold">Total</th>
								<th className="px-4 py-2 font-semibold">From</th>
								<th className="px-4 py-2 font-semibold">To</th>
							</tr>
						</thead>
						<tbody>
							{loaderData.streams.map((s) => (
								<tr className="border-t border-slate-100" key={s.idLiabilityStream}>
									<td className="px-4 py-2">
										<Link
											className="font-medium text-primary hover:underline"
											to={`/dashboard/liabilities/${s.idLiabilityStream}`}
										>
											{s.nameLiabilityStream}
										</Link>
									</td>
									<td className="tabular px-4 py-2 text-right">
										{s.countCashflows ?? 0}
									</td>
									<td className="tabular px-4 py-2 text-right">
										{money(s.totalAmount ?? 0)}
									</td>
									<td className="tabular px-4 py-2 text-slate-600">{s.firstDue}</td>
									<td className="tabular px-4 py-2 text-slate-600">{s.lastDue}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
			<section className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
				<h2 className="font-semibold text-neutral-900">New liability stream</h2>
				<WriteGate to="save your own liability streams">
					<Form
						className="mt-4 space-y-3"
						encType="multipart/form-data"
						method="post"
					>
						<label className="block text-sm font-medium text-slate-700">
							Name
							<input
								className={field}
								maxLength={80}
								name="name"
								placeholder="Fund distributions 2027-2046"
								required
							/>
						</label>
						<LiabilityInputFields />
						{actionData?.errors ? (
							<ul className="space-y-1 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
								{actionData.errors.map((e) => (
									<li key={e}>{e}</li>
								))}
							</ul>
						) : null}
						<button
							className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
							disabled={busy}
							type="submit"
						>
							Save stream
						</button>
					</Form>
				</WriteGate>
			</section>
		</main>
	);
}
