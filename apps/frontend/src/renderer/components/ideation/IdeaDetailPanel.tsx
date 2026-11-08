import {
	ChevronRight,
	ExternalLink,
	Lightbulb,
	Loader2,
	Play,
	X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Idea } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { CharterButton, toneClass } from "../charter";
import "../charter/charter.css";
import { IDEATION_TYPE_TONES } from "./constants";
import { CodeImprovementDetails } from "./details/CodeImprovementDetails";
import { CodeQualityDetails } from "./details/CodeQualityDetails";
import { DocumentationGapDetails } from "./details/DocumentationGapDetails";
import { PerformanceOptimizationDetails } from "./details/PerformanceOptimizationDetails";
import { SecurityHardeningDetails } from "./details/SecurityHardeningDetails";
import { UIUXDetails } from "./details/UIUXDetails";
import { IdeaChips } from "./IdeaCard";
import {
	isCodeImprovementIdea,
	isCodeQualityIdea,
	isDocumentationGapIdea,
	isPerformanceOptimizationIdea,
	isSecurityHardeningIdea,
	isUIUXIdea,
} from "./type-guards";

interface IdeaDetailPanelProps {
	readonly idea: Idea;
	readonly onClose: () => void;
	readonly onConvert: (idea: Idea) => void;
	readonly onGoToTask?: (taskId: string) => void;
	readonly onDismiss: (idea: Idea) => void;
	readonly isConverting?: boolean;
}

export function IdeaDetailPanel({
	idea,
	onClose,
	onConvert,
	onGoToTask,
	onDismiss,
	isConverting,
}: IdeaDetailPanelProps) {
	const { t } = useTranslation(["common", "ideation"]);
	const isDismissed = idea.status === "dismissed";
	const isConverted = idea.status === "converted";

	const taskId = idea.taskId;

	return (
		<aside
			className={cn(
				"wp-scope fixed inset-y-0 right-0 z-50 flex w-96 flex-col border-l border-border bg-card shadow-lg",
				toneClass(IDEATION_TYPE_TONES[idea.type]),
			)}
			aria-label={idea.title}
		>
			<div className="electron-no-drag shrink-0 border-b border-border p-4">
				<div className="flex items-start justify-between gap-2">
					<div className="min-w-0 flex-1">
						<IdeaChips idea={idea} />
						<h2 className="wp-title mt-2 text-base">{idea.title}</h2>
					</div>
					<CharterButton
						size="sm"
						variant="ghost"
						icon={ChevronRight}
						onClick={onClose}
						aria-label={t("accessibility.closePanelAriaLabel")}
						title={t("accessibility.closePanelAriaLabel")}
					/>
				</div>
			</div>

			<div className="flex-1 space-y-6 overflow-auto p-4">
				<div>
					<h3 className="wp-kicker mb-2 block">
						{t("common:ideation.description")}
					</h3>
					<p className="wp-muted text-sm">{idea.description}</p>
				</div>

				<div>
					<h3 className="wp-kicker mb-2 flex items-center gap-2">
						<Lightbulb className="h-3.5 w-3.5" aria-hidden="true" />
						{t("common:ideation.rationale")}
					</h3>
					<p className="wp-muted text-sm">{idea.rationale}</p>
				</div>

				{isCodeImprovementIdea(idea) && <CodeImprovementDetails idea={idea} />}
				{isUIUXIdea(idea) && <UIUXDetails idea={idea} />}
				{isDocumentationGapIdea(idea) && (
					<DocumentationGapDetails idea={idea} />
				)}
				{isSecurityHardeningIdea(idea) && (
					<SecurityHardeningDetails idea={idea} />
				)}
				{isPerformanceOptimizationIdea(idea) && (
					<PerformanceOptimizationDetails idea={idea} />
				)}
				{isCodeQualityIdea(idea) && <CodeQualityDetails idea={idea} />}
			</div>

			{!isDismissed && !isConverted && (
				<div className="flex shrink-0 flex-col gap-2 border-t border-border p-4">
					<CharterButton
						variant="primary"
						icon={isConverting ? Loader2 : Play}
						busy={isConverting}
						className="w-full justify-center"
						onClick={() => onConvert(idea)}
						disabled={isConverting}
					>
						{isConverting
							? t("common:ideation.converting")
							: t("common:ideation.convertToTask")}
					</CharterButton>
					<CharterButton
						icon={X}
						className="w-full justify-center"
						onClick={() => {
							onDismiss(idea);
							onClose();
						}}
					>
						{t("common:ideation.dismissIdea")}
					</CharterButton>
				</div>
			)}
			{isConverted && taskId && onGoToTask && (
				<div className="shrink-0 border-t border-border p-4">
					<CharterButton
						variant="primary"
						icon={ExternalLink}
						className="w-full justify-center"
						onClick={() => onGoToTask(taskId)}
					>
						{t("common:ideation.goToTask")}
					</CharterButton>
				</div>
			)}
		</aside>
	);
}
