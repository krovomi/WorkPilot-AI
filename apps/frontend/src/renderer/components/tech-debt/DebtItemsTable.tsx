import { ListPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DebtItem } from "../../../preload/api/modules/tech-debt-api";
import { CharterButton, Chip, Panel } from "../charter";

interface Props {
	readonly items: DebtItem[];
	readonly onCreateTask: (item: DebtItem) => void;
	readonly creatingItemId?: string | null;
}

/** The debt items as charter cards: kind, location, message, cost / effort / ROI. */
export function DebtItemsTable({ items, onCreateTask, creatingItemId }: Props) {
	const { t } = useTranslation(["techDebt", "common"]);
	if (!items.length) {
		return <p className="wp-meta py-6 text-center">{t("techDebt:empty")}</p>;
	}
	return (
		<ul className="flex flex-col gap-2">
			{items.map((item) => (
				<li key={item.id}>
					<Panel rail tone="orange" className="flex flex-col gap-1.5">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<Chip tone="orange">{t(`techDebt:kinds.${item.kind}`, item.kind)}</Chip>
							<span className="wp-meta">
								{t("techDebt:columns.cost")} {item.cost.toFixed(2)} · {t("techDebt:columns.effort")}{" "}
								{item.effort.toFixed(2)} ·{" "}
								<b className="text-foreground">
									{t("techDebt:columns.roi")} {item.roi.toFixed(2)}
								</b>
							</span>
						</div>
						<span className="wp-mono break-all text-xs">
							{item.file_path}:{item.line}
						</span>
						<p className="text-sm">{item.message}</p>
						<div className="flex justify-end">
							<CharterButton
								size="sm"
								icon={ListPlus}
								disabled={creatingItemId === item.id}
								onClick={() => onCreateTask(item)}
							>
								{creatingItemId === item.id
									? t("techDebt:actions.creatingTask")
									: t("techDebt:actions.createTask")}
							</CharterButton>
						</div>
					</Panel>
				</li>
			))}
		</ul>
	);
}
