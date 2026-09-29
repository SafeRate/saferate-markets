/**
 * The shared store of finished backtests (migration 0005). A cache: every
 * read may miss, and a failed write is logged and ignored, never surfaced.
 */

const TWO_WEEKS_MS = 14 * 86_400_000;

export async function getBacktestResult(input: {
	db: D1Database;
	keyBacktest: string;
}): Promise<string | null> {
	const row = await input.db
		.prepare("select payload from backtestResults where keyBacktest = ?")
		.bind(input.keyBacktest)
		.first<{ payload: string }>();
	return row?.payload ?? null;
}

export async function putBacktestResult(input: {
	db: D1Database;
	keyBacktest: string;
	datePrices: string;
	payload: string;
}) {
	const now = Date.now();
	await input.db.batch([
		input.db
			.prepare(
				`insert into backtestResults (keyBacktest, datePrices, payload, createdAt)
				 values (?, ?, ?, ?)
				 on conflict (keyBacktest) do update set payload = excluded.payload, createdAt = excluded.createdAt`,
			)
			.bind(input.keyBacktest, input.datePrices, input.payload, now),
		input.db
			.prepare("delete from backtestResults where createdAt < ?")
			.bind(now - TWO_WEEKS_MS),
	]);
}
