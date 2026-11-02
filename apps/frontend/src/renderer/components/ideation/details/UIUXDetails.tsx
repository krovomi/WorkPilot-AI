import { AlertCircle, CheckCircle2, FileCode, Users } from "lucide-react";
import { UIUX_CATEGORY_LABELS } from "../../../../shared/constants";
import type { UIUXImprovementIdea } from "../../../../shared/types";
import { Badge } from "../../ui/badge";
import { useTranslation } from "react-i18next";

interface UIUXDetailsProps {
	idea: UIUXImprovementIdea;
}

export function UIUXDetails({ idea }: UIUXDetailsProps) {
	const { t } = useTranslation();
	return (
		<>
			{/* Category */}
			<div>
				<Badge variant="outline" className="text-sm">
					{UIUX_CATEGORY_LABELS[idea.category]}
				</Badge>
			</div>

			{/* Current State */}
			<div>
				<h3 className="text-sm font-medium mb-2 flex items-center gap-2">
					<AlertCircle className="h-4 w-4" />
					{t("ideation:performanceDetails.currentState")}
				</h3>
				<p className="text-sm text-muted-foreground">{idea.currentState}</p>
			</div>

			{/* Proposed Change */}
			<div>
				<h3 className="text-sm font-medium mb-2 flex items-center gap-2">
					<CheckCircle2 className="h-4 w-4" />
					{t("ideation:details.proposedChange")}
				</h3>
				<p className="text-sm text-muted-foreground">{idea.proposedChange}</p>
			</div>

			{/* User Benefit */}
			<div>
				<h3 className="text-sm font-medium mb-2 flex items-center gap-2">
					<Users className="h-4 w-4" />
					{t("ideation:details.userBenefit")}
				</h3>
				<p className="text-sm text-muted-foreground">{idea.userBenefit}</p>
			</div>

			{/* Affected Components */}
			{idea.affectedComponents && idea.affectedComponents.length > 0 && (
				<div>
					<h3 className="text-sm font-medium mb-2 flex items-center gap-2">
						<FileCode className="h-4 w-4" />
						{t("ideation:details.affectedComponents")}
					</h3>
					<ul className="space-y-1">
						{idea.affectedComponents.map((component, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: no stable key available
							<li key={i} className="text-sm font-mono text-muted-foreground">
								{component}
							</li>
						))}
					</ul>
				</div>
			)}
		</>
	);
}
