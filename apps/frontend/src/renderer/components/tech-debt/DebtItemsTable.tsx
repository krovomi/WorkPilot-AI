import { ListPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DebtItem } from "../../../preload/api/modules/tech-debt-api";
import { Button } from "../ui/button";

interface Props {
	readonly items: DebtItem[];
	readonly onCreateTask: (item: DebtItem) => void;
	readonly creatingItemId?: string | null;
}

export function DebtItemsTable({ items, onCreateTask, creatingItemId }: Props) {
	const { t } = useTranslation(["techDebt", "common"]);
	if (!items.length) {
		return (
			<p className="text-sm text-muted-foreground py-6 text-center">
				{t("techDebt:empty")}
			</p>
		);
	}
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm">
				<thead>
					<tr className="text-left border-b">
						<th className="py-2 pr-2">{t("techDebt:columns.kind")}</th>
						<th className="py-2 pr-2">{t("techDebt:columns.file")}</th>
						<th className="py-2 pr-2">{t("techDebt:columns.message")}</th>
						<th className="py-2 pr-2 text-right">
							{t("techDebt:columns.cost")}
						</th>
						<th className="py-2 pr-2 text-right">
							{t("techDebt:columns.effort")}
						</th>
						<th className="py-2 pr-2 text-right">
							{t("techDebt:columns.roi")}
						</th>
						<th className="py-2 pr-2 text-right">
							{t("techDebt:columns.actions")}
						</th>
					</tr>
				</thead>
				<tbody>
					{items.map((item) => (
						<tr key={item.id} className="border-b last:border-0">
							<td className="py-2 pr-2">
								<span className="px-2 py-0.5 rounded-full bg-muted text-xs">
									{t(`techDebt:kinds.${item.kind}`, item.kind)}
								</span>
							</td>
							<td className="py-2 pr-2 font-mono text-xs">
								{item.file_path}:{item.line}
							</td>
							<td className="py-2 pr-2">{item.message}</td>
							<td className="py-2 pr-2 text-right">{item.cost.toFixed(2)}</td>
							<td className="py-2 pr-2 text-right">{item.effort.toFixed(2)}</td>
							<td className="py-2 pr-2 text-right font-semibold">
								{item.roi.toFixed(2)}
							</td>
							<td className="py-2 pr-2 text-right">
								<Button
									size="sm"
									variant="outline"
									disabled={creatingItemId === item.id}
									onClick={() => onCreateTask(item)}
								>
									<ListPlus className="h-3 w-3 mr-1" />
									{creatingItemId === item.id
										? t("techDebt:actions.creatingTask")
										: t("techDebt:actions.createTask")}
								</Button>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
