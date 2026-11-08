import { useTranslation } from "react-i18next";
import type { IdeationType } from "../../../shared/types";
import { type TabItem, Tabs } from "../charter";
import { ALL_IDEATION_TYPES } from "./constants";
import { IDEATION_TYPE_ICONS } from "./TypeIcon";

export type IdeationTab = "all" | IdeationType;

interface IdeationFiltersProps {
	readonly activeTab: string;
	readonly onTabChange: (tab: string) => void;
	/** The ideas each tab lists, shown on its pill. */
	readonly counts: Readonly<Record<IdeationTab, number>>;
}

/** One pill per ideation type, plus "All". */
export function IdeationFilters({
	activeTab,
	onTabChange,
	counts,
}: IdeationFiltersProps) {
	const { t } = useTranslation("ideation");
	const tabs: TabItem<IdeationTab>[] = [
		{ id: "all", label: t("filters.all"), count: counts.all },
		...ALL_IDEATION_TYPES.map((type) => ({
			id: type,
			label: t(`types.${type}`),
			icon: IDEATION_TYPE_ICONS[type],
			count: counts[type],
		})),
	];
	return (
		<Tabs
			tabs={tabs}
			value={activeTab as IdeationTab}
			onChange={onTabChange}
			label={t("filters.label")}
		/>
	);
}
