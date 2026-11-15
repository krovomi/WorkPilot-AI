/**
 * FindingItem - Individual finding display with checkbox and details
 */

import { CheckCircle, History } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils";
import { Badge } from "../../ui/badge";
import { Checkbox } from "../../ui/checkbox";
import { getCategoryIcon } from "../constants/severity-config";
import type {
	ReviewFeedbackInput,
	ReviewFeedbackVerdict,
} from "../../../../shared/types/review-feedback";
import type { PRReviewFinding } from "../hooks/useGitHubPRs";
import { FindingFeedback } from "./FindingFeedback";

interface FindingItemProps {
	finding: PRReviewFinding;
	selected: boolean;
	posted?: boolean;
	onToggle: () => void;
	/** Feedback controls (#361): shown when the review's project takes feedback. */
	feedback?: {
		verdict?: ReviewFeedbackVerdict;
		pending: boolean;
		onSubmit: (input: ReviewFeedbackInput) => Promise<boolean>;
	};
}

// Helper to translate category names
function getCategoryTranslationKey(category: string): string {
	// Map category values to translation keys
	const categoryMap: Record<string, string> = {
		security: "prReview.category.security",
		logic: "prReview.category.logic",
		quality: "prReview.category.quality",
		performance: "prReview.category.performance",
		style: "prReview.category.style",
		documentation: "prReview.category.documentation",
		testing: "prReview.category.testing",
		other: "prReview.category.other",
	};
	return categoryMap[category.toLowerCase()] || category;
}

export function FindingItem({
	finding,
	selected,
	posted = false,
	onToggle,
	feedback,
}: FindingItemProps) {
	const { t } = useTranslation("common");
	const CategoryIcon = getCategoryIcon(finding.category);

	// Get translated category name (falls back to original if translation not found)
	const categoryKey = getCategoryTranslationKey(finding.category);
	const categoryLabel = t(categoryKey, { defaultValue: finding.category });

	return (
		<div
			className={cn(
				"rounded-lg border bg-background p-3 space-y-2 transition-colors",
				selected && !posted && "ring-2 ring-primary/50",
				posted && "opacity-60",
			)}
		>
			{/* Finding Header */}
			<div className="flex items-start gap-3">
				{posted ? (
					<CheckCircle className="h-4 w-4 mt-0.5 text-success shrink-0" />
				) : (
					<Checkbox
						id={finding.id}
						checked={selected}
						onCheckedChange={onToggle}
						className="mt-0.5"
					/>
				)}
				<div className="flex-1 min-w-0 space-y-1">
					<div className="flex items-center gap-2 flex-wrap">
						<Badge variant="outline" className="text-xs shrink-0">
							<CategoryIcon className="h-3 w-3 mr-1" />
							{categoryLabel}
						</Badge>
						{posted && (
							<Badge
								variant="outline"
								className="text-xs shrink-0 text-success border-success/50"
							>
								{t("prReview.posted")}
							</Badge>
						)}
						{finding.learnedRejections ? (
							<Badge
								variant="outline"
								className="text-xs shrink-0 text-muted-foreground"
								title={t("prReview.feedback.learnedHint")}
							>
								<History className="h-3 w-3 mr-1" />
								{t("prReview.feedback.learnedBadge", {
									count: finding.learnedRejections,
								})}
							</Badge>
						) : null}
						<span className="font-medium text-sm break-words">
							{finding.title}
						</span>
					</div>
					<p className="text-sm text-muted-foreground break-words">
						{finding.description}
					</p>
					<div className="text-xs text-muted-foreground">
						<code className="bg-muted px-1 py-0.5 rounded break-all">
							{finding.file}:{finding.line}
							{finding.endLine &&
								finding.endLine !== finding.line &&
								`-${finding.endLine}`}
						</code>
					</div>
				</div>
			</div>

			{/* Suggested Fix */}
			{finding.suggestedFix && (
				<div className="ml-7 text-xs">
					<span className="text-muted-foreground font-medium">
						{t("prReview.suggestedFix")}
					</span>
					<pre className="mt-1 p-2 bg-muted rounded text-xs overflow-x-auto max-w-full whitespace-pre-wrap break-words">
						{finding.suggestedFix}
					</pre>
				</div>
			)}

			{feedback && !posted && (
				<FindingFeedback
					findingId={finding.id}
					verdict={feedback.verdict}
					pending={feedback.pending}
					onSubmit={feedback.onSubmit}
				/>
			)}
		</div>
	);
}
