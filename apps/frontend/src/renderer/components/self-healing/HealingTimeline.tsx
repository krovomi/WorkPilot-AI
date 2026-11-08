import type { HealingOperation } from "@shared/types/self-healing";
import { useTranslation } from "react-i18next";
import { Chip, Panel, type Tone } from "../charter";

interface HealingTimelineProps {
	readonly operation: HealingOperation;
}

const stepStatusColors: Record<string, string> = {
	completed: "bg-success",
	running: "bg-info animate-pulse",
	failed: "bg-destructive",
	skipped: "bg-warning",
	pending: "bg-muted-foreground",
};

export function HealingTimeline({ operation }: HealingTimelineProps) {
	const { t } = useTranslation(["selfHealing"]);

	let statusTone: Tone;
	let statusText: string;

	if (operation.success) {
		statusTone = "green";
		statusText = t("selfHealing:resolved");
	} else if (
		operation.completed_at &&
		operation.incident?.status === "escalated"
	) {
		statusTone = "amber";
		statusText = t("selfHealing:needsReview");
	} else if (operation.completed_at) {
		statusTone = "red";
		statusText = t("selfHealing:failed");
	} else {
		statusTone = "blue";
		statusText = t("selfHealing:inProgress");
	}

	return (
		<Panel rail tone={statusTone}>
			<div className="flex items-center justify-between mb-3">
				<h4 className="wp-step-title">
					{operation.incident?.title || t("selfHealing:healingOperation")}
				</h4>
				<Chip tone={statusTone}>{statusText}</Chip>
			</div>

			<div className="relative pl-4">
				{operation.steps.map((step, index) => (
					<div
						key={`${step.name}-${step.status}`}
						className="relative pb-4 last:pb-0"
					>
						{/* Vertical line */}
						{index < operation.steps.length - 1 && (
							<div className="absolute left-0 top-3 w-px h-full bg-border" />
						)}
						{/* Dot */}
						<div
							className={`absolute left-0 top-1.5 w-2 h-2 rounded-full -translate-x-[3px] ${stepStatusColors[step.status] || stepStatusColors.pending}`}
						/>
						{/* Content */}
						<div className="ml-3">
							<div className="flex items-center gap-2">
								<span className="text-sm text-foreground">
									{step.name}
								</span>
								{step.status === "skipped" && (
									<span className="text-xs text-warning">
										{t("selfHealing:stepSkipped")}
									</span>
								)}
							</div>
							{step.detail && (
								<p className="text-xs text-muted-foreground mt-0.5">
									{step.detail}
								</p>
							)}
						</div>
					</div>
				))}
			</div>

			{operation.duration_seconds != null && (
				<div className="mt-3 text-xs text-muted-foreground">
					{t("selfHealing:duration")}: {operation.duration_seconds.toFixed(1)}s
				</div>
			)}
		</Panel>
	);
}
