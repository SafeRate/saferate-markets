const field =
	"mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm";

/** The two ways to give a liability schedule: pasted lines, or a CSV. */
export const LiabilityInputFields = ({
	defaultLines = "",
}: {
	defaultLines?: string;
}) => (
	<>
		<label className="block text-sm font-medium text-slate-700">
			Paste one per line: date, amount, and an optional label
			<textarea
				className={`${field} font-mono`}
				defaultValue={defaultLines}
				name="lines"
				placeholder={
					"2027-06-30, 1,000,000, Year 1 payout\n2028-06-30, 1,000,000\n12/31/2028, 250000, Special distribution"
				}
				rows={8}
			/>
		</label>
		<label className="mt-3 block text-sm font-medium text-slate-700">
			Or upload a CSV (columns matched by name: a date and an amount, a label
			optional)
			<input
				accept=".csv,text/csv"
				className="mt-1 block text-sm"
				name="file"
				type="file"
			/>
		</label>
	</>
);
