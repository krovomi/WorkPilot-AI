import {
	CheckSquare,
	Eye,
	EyeOff,
	Lightbulb,
	Play,
	Plus,
	RefreshCw,
	Settings2,
	Trash2,
	X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { IdeationType } from "../../../shared/types";
import { CharterButton, Chip, ModuleHeader } from "../charter";
import { IDEATION_TYPE_TONES } from "./constants";
import { TypeIcon } from "./TypeIcon";

interface IdeationHeaderProps {
	readonly totalIdeas: number;
	readonly ideaCountByType: Record<string, number>;
	readonly showDismissed: boolean;
	readonly selectedCount: number;
	readonly onToggleShowDismissed: () => void;
	readonly onOpenConfig: () => void;
	readonly onOpenAddMore: () => void;
	readonly onDismissAll: () => void;
	readonly onDeleteSelected: () => void;
	readonly onConvertSelected: () => void;
	readonly onSelectAll: () => void;
	readonly onClearSelection: () => void;
	readonly onRefresh: () => void;
	readonly hasActiveIdeas: boolean;
	readonly canAddMore: boolean;
}

/** The module band of Ideation: title, counts per type, then the actions. */
export function IdeationHeader({
	totalIdeas,
	ideaCountByType,
	showDismissed,
	selectedCount,
	onToggleShowDismissed,
	onOpenConfig,
	onOpenAddMore,
	onDismissAll,
	onDeleteSelected,
	onConvertSelected,
	onSelectAll,
	onClearSelection,
	onRefresh,
	hasActiveIdeas,
	canAddMore,
}: IdeationHeaderProps) {
	const { t } = useTranslation(["common", "ideation", "navigation"]);
	const hasSelection = selectedCount > 0;
	const dismissedLabel = showDismissed
		? t("accessibility.hideDismissedAriaLabel")
		: t("accessibility.showDismissedAriaLabel");

	return (
		<>
			<ModuleHeader
				kicker={t("navigation:groups.explore")}
				title={t("ideation:header.title")}
				description={t("ideation:header.subtitle")}
				icon={Lightbulb}
				tone="amber"
				actions={
					<>
						{hasSelection ? (
							<>
								<Chip tone="accent">
									{t("ideation:header.selectedCount", { count: selectedCount })}
								</Chip>
								<CharterButton
									size="sm"
									variant="primary"
									icon={Play}
									onClick={onConvertSelected}
								>
									{t("ideation:header.convertSelected")}
								</CharterButton>
								<CharterButton
									size="sm"
									variant="danger"
									icon={Trash2}
									onClick={onDeleteSelected}
								>
									{t("ideation:header.delete")}
								</CharterButton>
								<CharterButton
									size="sm"
									variant="ghost"
									icon={X}
									onClick={onClearSelection}
									aria-label={t("accessibility.clearSelectionAriaLabel")}
									title={t("accessibility.clearSelectionAriaLabel")}
								/>
							</>
						) : (
							hasActiveIdeas && (
								<CharterButton
									size="sm"
									variant="ghost"
									icon={CheckSquare}
									onClick={onSelectAll}
									aria-label={t("accessibility.selectAllAriaLabel")}
									title={t("accessibility.selectAllAriaLabel")}
								/>
							)
						)}
						<CharterButton
							size="sm"
							variant={showDismissed ? "default" : "ghost"}
							icon={showDismissed ? Eye : EyeOff}
							onClick={onToggleShowDismissed}
							aria-pressed={showDismissed}
							aria-label={dismissedLabel}
							title={dismissedLabel}
						/>
						<CharterButton
							size="sm"
							variant="ghost"
							icon={Settings2}
							onClick={onOpenConfig}
							aria-label={t("accessibility.configureAriaLabel")}
							title={t("accessibility.configureAriaLabel")}
						/>
						{hasActiveIdeas && !hasSelection && (
							<CharterButton
								size="sm"
								variant="ghost"
								icon={Trash2}
								onClick={onDismissAll}
								aria-label={t("accessibility.dismissAllAriaLabel")}
								title={t("accessibility.dismissAllAriaLabel")}
							/>
						)}
						<CharterButton
							size="sm"
							variant="ghost"
							icon={RefreshCw}
							onClick={onRefresh}
							aria-label={t("accessibility.regenerateIdeasAriaLabel")}
							title={t("accessibility.regenerateIdeasAriaLabel")}
						/>
						{canAddMore && (
							<CharterButton
								size="sm"
								icon={Plus}
								onClick={onOpenAddMore}
								title={t("accessibility.addMoreAriaLabel")}
							>
								{t("ideation:header.addMore")}
							</CharterButton>
						)}
					</>
				}
			/>
			<div className="wp-chips relative z-[2] px-5 pb-3">
				<Chip tone="muted" dot={false}>
					{t("ideation:header.ideasCount", { count: totalIdeas })}
				</Chip>
				{Object.entries(ideaCountByType).map(([type, count]) => (
					<Chip
						key={type}
						tone={IDEATION_TYPE_TONES[type as IdeationType]}
						dot={false}
						title={t(`ideation:types.${type}`)}
					>
						<TypeIcon type={type as IdeationType} className="h-3 w-3" />
						{count}
					</Chip>
				))}
			</div>
		</>
	);
}
