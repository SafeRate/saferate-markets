import { z } from "zod";

/**
 * Usage recording. One event row plus a monthly rollup, written together.
 *
 * Unlike OKLocate there is no quota and no overage: the plan is rate-limited,
 * not metered for billing. Usage is still recorded from the first request so the
 * dashboard shows real figures and so a future quota has history to stand on.
 */

const ZDb = z.custom<D1Database>((v) => v !== null && v !== undefined);

export const ZSurface = z.enum(["rest", "mcp"]);
export type TSurface = z.infer<typeof ZSurface>;

/** 'YYYY-MM' in UTC. */
export const currentPeriodMonth = (now = Date.now()) =>
	new Date(now).toISOString().slice(0, 7);

const ZInputRecordUsage = z.object({
	db: ZDb,
	analytics: z.custom<AnalyticsEngineDataset>().optional(),
	idOrganization: z.string().min(1),
	idApiKey: z.string().min(1),
	surface: ZSurface,
	operation: z.string().min(1).max(160),
	statusCode: z.number().int(),
	durationMs: z.number().int().nonnegative().nullable(),
});

/**
 * Never throws. Metering must not break a request that already succeeded, so a
 * failure is logged loudly instead: a silent gap here is a dashboard figure that
 * is quietly too low, and the log is the only evidence it happened.
 */
export async function recordUsage(_input: z.infer<typeof ZInputRecordUsage>) {
	const input = ZInputRecordUsage.parse(_input);
	const now = Date.now();
	const succeeded = input.statusCode >= 200 && input.statusCode < 300 ? 1 : 0;

	try {
		await input.db.batch([
			input.db
				.prepare(
					/* sql */ `
					insert into apiUsageEvents
						(idApiUsageEvent, idOrganization, idApiKey, surface, operation,
						 statusCode, durationMs, createdAt)
					values (?, ?, ?, ?, ?, ?, ?, ?)
				`,
				)
				.bind(
					crypto.randomUUID(),
					input.idOrganization,
					input.idApiKey,
					input.surface,
					input.operation,
					input.statusCode,
					input.durationMs,
					now,
				),
			input.db
				.prepare(
					/* sql */ `
					insert into apiUsageMonthly
						(idApiUsageMonthly, idOrganization, periodMonth, surface,
						 countRequests, countSucceeded, updatedAt)
					values (?, ?, ?, ?, 1, ?, ?)
					on conflict (idOrganization, periodMonth, surface) do update set
						countRequests = countRequests + 1,
						countSucceeded = countSucceeded + ?,
						updatedAt = ?
				`,
				)
				.bind(
					crypto.randomUUID(),
					input.idOrganization,
					currentPeriodMonth(now),
					input.surface,
					succeeded,
					now,
					succeeded,
					now,
				),
		]);
	} catch (error) {
		console.error("[usage] failed to record", input.operation, error);
	}

	// Sampled; for exploration only. After D1, so a throw here cannot cost the
	// record.
	try {
		input.analytics?.writeDataPoint({
			blobs: [input.idOrganization, input.surface, input.operation],
			doubles: [input.statusCode, input.durationMs ?? 0],
			indexes: [input.idOrganization],
		});
	} catch (error) {
		console.error("[usage] analytics write failed", error);
	}
}

export const ZMonthlyUsage = z.object({
	periodMonth: z.string(),
	surface: ZSurface,
	countRequests: z.number(),
	countSucceeded: z.number(),
});

const ZInputGetMonthlyUsage = z.object({
	db: ZDb,
	idOrganization: z.string().min(1),
	limitMonths: z.number().int().positive().default(12),
});

export async function getMonthlyUsage(
	_input: z.input<typeof ZInputGetMonthlyUsage>,
) {
	const input = ZInputGetMonthlyUsage.parse(_input);
	const result = await input.db
		.prepare(
			/* sql */ `
			select periodMonth, surface, countRequests, countSucceeded
			from apiUsageMonthly
			where idOrganization = ?
			order by periodMonth desc, surface
			limit ?
		`,
		)
		.bind(input.idOrganization, input.limitMonths * 2)
		.all();
	return z.array(ZMonthlyUsage).parse(result.results ?? []);
}
