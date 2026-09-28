// Ported from saferate-oklocate apps/web/app/components/LegalPage.tsx (2026-09-28).
import {
	LEGAL_ADDRESS_LINES,
	LEGAL_ENTITY,
	legalEffectiveDateLabel,
} from "@markets/schema";
import type { ReactNode } from "react";
import { Link } from "react-router";

/**
 * Shared chrome for /privacy and /terms.
 *
 * Two things it enforces rather than offers. Every section gets a stable `id`
 * and a numbered heading, because a legal document that cannot be cited by
 * section is a legal document nobody can point at in a dispute. And the
 * effective date and entity block come from the schema, so the two pages can
 * never drift into claiming different dates or a different publisher — they
 * cross-reference each other, and an ambiguous "as amended" between two
 * differently-dated documents is worse than either date alone.
 */

export const LegalSection = ({
	id,
	number,
	title,
	children,
}: {
	id: string;
	number: number;
	title: string;
	children: ReactNode;
}) => (
	<section className="mt-12 scroll-mt-24" id={id}>
		<h2 className="text-xl font-semibold tracking-tight text-neutral-900">
			<span className="mr-3 font-mono text-sm text-slate-600">{number}</span>
			{title}
		</h2>
		<div className="mt-4 flex flex-col gap-4 leading-relaxed text-slate-600">
			{children}
		</div>
	</section>
);

/** A claim we want a reader to be able to check, not merely to accept. */
export const Callout = ({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) => (
	<div className="rounded-lg border border-slate-200 bg-muted/30 p-5">
		<p className="text-sm font-medium text-neutral-900">{title}</p>
		<div className="mt-2 flex flex-col gap-3 text-sm leading-relaxed">
			{children}
		</div>
	</div>
);

export const LegalPage = ({
	kicker,
	title,
	lead,
	sections,
	children,
}: {
	kicker: string;
	title: string;
	lead: ReactNode;
	/** Section ids and titles, in order, for the contents list. */
	sections: { id: string; title: string }[];
	children: ReactNode;
}) => (
	<main className="mx-auto max-w-3xl px-6 py-16">
		<p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
			{kicker}
		</p>
		<h1 className="mt-4 text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl">
			{title}
		</h1>
		<p className="mt-4 text-sm text-slate-600">
			Effective {legalEffectiveDateLabel()} · {LEGAL_ENTITY.nameLegal}, a{" "}
			{LEGAL_ENTITY.form}, trading as {LEGAL_ENTITY.nameProduct}
		</p>
		<div className="mt-6 flex flex-col gap-4 text-lg leading-relaxed text-slate-600">
			{lead}
		</div>

		<nav className="mt-10 rounded-lg border border-slate-200 p-5">
			<p className="text-xs font-medium uppercase tracking-widest text-slate-600">
				Contents
			</p>
			<ol className="mt-3 flex flex-col gap-1.5">
				{sections.map((section, index) => (
					<li key={section.id} className="text-sm">
						<a
							className="text-slate-600 hover:text-slate-900"
							href={`#${section.id}`}
						>
							<span className="mr-3 font-mono text-xs">{index + 1}</span>
							{section.title}
						</a>
					</li>
				))}
			</ol>
		</nav>

		{children}

		<section className="mt-16 border-t border-slate-200 pt-8" id="contact">
			<h2 className="text-xl font-semibold tracking-tight text-neutral-900">
				Contact
			</h2>
			<p className="mt-3 text-slate-600">
				Questions about this document, or a request under it:
			</p>
			<address className="mt-4 not-italic text-sm leading-relaxed text-slate-600">
				<a
					className="text-neutral-900 underline underline-offset-4"
					href={`mailto:${LEGAL_ENTITY.emailContact}`}
				>
					{LEGAL_ENTITY.emailContact}
				</a>
				{LEGAL_ADDRESS_LINES.map((line) => (
					<span className="block" key={line}>
						{line}
					</span>
				))}
			</address>
			<p className="mt-6 text-sm text-slate-600">
				See also our{" "}
				<Link className="underline underline-offset-4" to="/privacy">
					privacy policy
				</Link>
				,{" "}
				<Link className="underline underline-offset-4" to="/terms">
					terms of service
				</Link>{" "}
				and{" "}
				<Link className="underline underline-offset-4" to="/privacy-choices">
					your privacy choices
				</Link>
				.
			</p>
		</section>
	</main>
);
