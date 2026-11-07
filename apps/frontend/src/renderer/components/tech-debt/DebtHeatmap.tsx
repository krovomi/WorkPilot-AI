import { useTranslation } from "react-i18next";
import type { DebtItem } from "../../../preload/api/modules/tech-debt-api";
import { Bar } from "../charter";

interface Props {
	readonly items: DebtItem[];
}

export function DebtHeatmap({ items }: Props) {
	const { t } = useTranslation(["techDebt"]);
	const byFile = new Map<string, number>();
	for (const item of items) {
		byFile.set(item.file_path, (byFile.get(item.file_path) ?? 0) + item.roi);
	}
	const entries = Array.from(byFile.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 20);
	if (!entries.length) {
		return (
			<p className="wp-meta py-4 text-center">
				{t("techDebt:empty")}
			</p>
		);
	}
	const max = entries[0][1];
	return (
		<ul className="space-y-2">
			{entries.map(([file, score]) => {
				const pct = Math.max(4, Math.round((score / max) * 100));
				return (
					<li key={file} className="text-xs">
						<div className="mb-1 flex justify-between gap-2">
							<span className="wp-mono truncate">{file}</span>
							<span className="wp-meta">{score.toFixed(1)}</span>
						</div>
						<Bar value={pct} tone="orange" />
					</li>
				);
			})}
		</ul>
	);
}
