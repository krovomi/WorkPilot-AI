import { ExternalLink, Play, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	DOCUMENTATION_CATEGORY_LABELS,
	UIUX_CATEGORY_LABELS,
} from "../../../shared/constants";
import type { Idea } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { CharterButton, Chip, toneClass } from "../charter";
import { Checkbox } from "../ui/checkbox";
import {
	IDEA_LEVEL_TONES,
	IDEA_STATUS_TONES,
	IDEATION_TYPE_TONES,
} from "./constants";
import { TypeIcon } from "./TypeIcon";
import {
	isCodeImprovementIdea,
	isCodeQualityIdea,
	isDocumentationGapIdea,
	isPerformanceOptimizationIdea,
	isSecurityHardeningIdea,
	isUIUXIdea,
} from "./type-guards";

/** The chips of an idea: its type, status, then the level its type carries. */
export function IdeaChips({ idea }: { readonly idea: Idea }) {
	const { t } = useTranslation("ideation");
	return (
		<div className="wp-chips">
			<Chip tone={IDEATION_TYPE_TONES[idea.type]} dot={false}>
				<TypeIcon type={idea.type} className="h-3 w-3" />
				{t(`types.${idea.type}`)}
			</Chip>
			{idea.status !== "draft" && (
				<Chip tone={IDEA_STATUS_TONES[idea.status]}>{idea.status}</Chip>
			)}
			{isCodeImprovementIdea(idea) && (
				<Chip tone={IDEA_LEVEL_TONES[idea.estimatedEffort]}>
					{idea.estimatedEffort}
				</Chip>
			)}
			{isUIUXIdea(idea) && (
				<Chip tone="muted" dot={false}>
					{UIUX_CATEGORY_LABELS[idea.category]}
				</Chip>
			)}
			{isDocumentationGapIdea(idea) && (
				<Chip tone="muted" dot={false}>
					{DOCUMENTATION_CATEGORY_LABELS[idea.category]}
				</Chip>
			)}
			{isSecurityHardeningIdea(idea) && (
				<Chip tone={IDEA_LEVEL_TONES[idea.severity]}>{idea.severity}</Chip>
			)}
			{isPerformanceOptimizationIdea(idea) && (
				<Chip tone={IDEA_LEVEL_TONES[idea.impact]}>
					{t("details.impactLevel", { level: idea.impact })}
				</Chip>
			)}
			{isCodeQualityIdea(idea) && (
				<Chip tone={IDEA_LEVEL_TONES[idea.severity]}>{idea.severity}</Chip>
			)}
		</div>
	);
}

interface IdeaCardProps {
	readonly idea: Idea;
	readonly isSelected: boolean;
	readonly onClick: () => void;
	readonly onConvert: (idea: Idea) => void;
	readonly onGoToTask?: (taskId: string) => void;
	readonly onDismiss: (idea: Idea) => void;
	readonly onToggleSelect: (ideaId: string) => void;
}

/** One idea: a card railed in its type's tone; the body opens the details. */
export function IdeaCard({
	idea,
	isSelected,
	onClick,
	onConvert,
	onGoToTask,
	onDismiss,
	onToggleSelect,
}: IdeaCardProps) {
	const { t } = useTranslation(["common", "ideation"]);
	const isDismissed = idea.status === "dismissed";
	const isArchived = idea.status === "archived";
	const isConverted = idea.status === "converted";
	const isInactive = isDismissed || isArchived;
	const taskId = idea.taskId;
	const showTaskLink = (isArchived || isConverted) && taskId && onGoToTask;

	return (
		<div
			className={cn(
				"wp-card wp-card-pad wp-rail flex items-start gap-3",
				toneClass(IDEATION_TYPE_TONES[idea.type]),
				isInactive && "opacity-55",
			)}
			data-active={isSelected ? "true" : undefined}
		>
			<Checkbox
				checked={isSelected}
				onCheckedChange={() => onToggleSelect(idea.id)}
				className="mt-0.5"
				aria-label={t("accessibility.selectIdeaAriaLabel", {
					title: idea.title,
				})}
			/>
			<button
				type="button"
				className="min-w-0 flex-1 cursor-pointer text-left"
				onClick={onClick}
			>
				<IdeaChips idea={idea} />
				<h3
					className={cn(
						"wp-title mt-2 text-sm",
						isInactive && "line-through",
					)}
				>
					{idea.title}
				</h3>
				<p className="wp-muted mt-1 line-clamp-2 text-xs">
					{idea.description}
				</p>
			</button>
			{!isInactive && !isConverted && (
				<div className="flex shrink-0 items-center gap-1">
					<CharterButton
						size="sm"
						variant="ghost"
						icon={Play}
						onClick={() => onConvert(idea)}
						aria-label={t("accessibility.convertToTaskAriaLabel")}
						title={t("accessibility.convertToTaskAriaLabel")}
					/>
					<CharterButton
						size="sm"
						variant="ghost"
						icon={X}
						onClick={() => onDismiss(idea)}
						aria-label={t("accessibility.dismissAriaLabel")}
						title={t("accessibility.dismissAriaLabel")}
					/>
				</div>
			)}
			{showTaskLink && (
				<CharterButton
					size="sm"
					variant="ghost"
					icon={ExternalLink}
					onClick={() => onGoToTask(taskId)}
					aria-label={t("accessibility.goToTaskAriaLabel")}
					title={t("accessibility.goToTaskAriaLabel")}
				/>
			)}
		</div>
	);
}
