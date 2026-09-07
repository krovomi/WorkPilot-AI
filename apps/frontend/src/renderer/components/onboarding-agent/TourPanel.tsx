import {
	Check,
	ChevronLeft,
	ChevronRight,
	FileCode,
	FileText,
	FolderTree,
	Rocket,
} from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useOnboardingAgentStore } from "../../stores/onboarding-agent-store";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { CategoryBadge, EmptyState } from "./shared";

const STEP_ICONS: Record<string, React.ReactNode> = {
	doc: <FileText className="w-4 h-4" />,
	entrypoint: <Rocket className="w-4 h-4" />,
	directory: <FolderTree className="w-4 h-4" />,
	file: <FileCode className="w-4 h-4" />,
};

export function TourPanel(): React.ReactElement | null {
	const { t } = useTranslation("onboardingAgent");
	const pkg = useOnboardingAgentStore((s) => s.pkg);
	const idx = useOnboardingAgentStore((s) => s.currentTourStep);
	const setIdx = useOnboardingAgentStore((s) => s.setCurrentTourStep);
	const completed = useOnboardingAgentStore((s) => s.completedTourSteps);
	const toggleDone = useOnboardingAgentStore((s) => s.toggleTourStepDone);

	if (!pkg) return null;
	if (pkg.tour.length === 0) {
		return <EmptyState message={t("emptyTour")} />;
	}

	const step = pkg.tour[Math.min(idx, pkg.tour.length - 1)];
	const isDone = completed.includes(step.order);
	const progress = Math.round((completed.length / pkg.tour.length) * 100);

	return (
		<div className="flex gap-4 h-full">
			{/* Step list — a tour you cannot see the shape of is a slideshow. */}
			<aside className="w-56 shrink-0 hidden md:flex md:flex-col gap-1 overflow-auto">
				{pkg.tour.map((entry, entryIdx) => {
					const done = completed.includes(entry.order);
					return (
						<button
							type="button"
							key={entry.file_path}
							onClick={() => setIdx(entryIdx)}
							className={`text-left px-2 py-1.5 rounded-md text-xs flex items-center gap-2 ${
								entryIdx === idx
									? "bg-accent text-accent-foreground"
									: "hover:bg-accent/50 text-muted-foreground"
							}`}
						>
							<span
								className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
									done ? "bg-success/20 text-success" : "bg-muted"
								}`}
							>
								{done ? (
									<Check className="w-3 h-3" />
								) : (
									<span>{entry.order}</span>
								)}
							</span>
							<span className="truncate">{entry.title}</span>
						</button>
					);
				})}
			</aside>

			<div className="flex-1 min-w-0 space-y-4">
				<div className="space-y-2">
					<div className="flex items-center justify-between gap-3">
						<span className="text-sm text-muted-foreground">
							{t("stepOfTotal", {
								current: idx + 1,
								total: pkg.tour.length,
							})}
						</span>
						<div className="flex gap-2">
							<Button
								size="icon"
								variant="outline"
								aria-label={t("actions.previous")}
								onClick={() => setIdx(Math.max(0, idx - 1))}
								disabled={idx === 0}
							>
								<ChevronLeft className="w-4 h-4" />
							</Button>
							<Button
								size="icon"
								variant="outline"
								aria-label={t("actions.next")}
								onClick={() => setIdx(Math.min(pkg.tour.length - 1, idx + 1))}
								disabled={idx === pkg.tour.length - 1}
							>
								<ChevronRight className="w-4 h-4" />
							</Button>
						</div>
					</div>
					<Progress value={progress} />
					<p className="text-xs text-muted-foreground">
						{t("tourProgress", {
							done: completed.length,
							total: pkg.tour.length,
						})}
					</p>
				</div>

				<div className="border rounded-md p-4 bg-card space-y-3">
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0">
							<h3 className="font-semibold flex items-center gap-2">
								{STEP_ICONS[step.category] ?? STEP_ICONS.file}
								{step.title}
							</h3>
							<p className="text-sm font-mono text-muted-foreground truncate">
								{step.file_path}
							</p>
						</div>
						<CategoryBadge
							category={step.category}
							label={t(`tourCategories.${step.category}`)}
						/>
					</div>

					<p className="text-sm whitespace-pre-wrap">{step.reason}</p>

					{step.suggested_questions.length > 0 && (
						<div>
							<p className="text-xs font-medium text-muted-foreground mb-1">
								{t("suggestedQuestions")}
							</p>
							<ul className="list-disc pl-5 space-y-1 text-sm">
								{step.suggested_questions.map((question) => (
									<li key={question}>{question}</li>
								))}
							</ul>
						</div>
					)}

					<div className="flex gap-2 pt-1">
						<Button
							size="sm"
							variant={isDone ? "outline" : "default"}
							onClick={() => toggleDone(step.order)}
						>
							<Check className="w-4 h-4 mr-1" />
							{isDone ? t("actions.markUndone") : t("actions.markDone")}
						</Button>
						{idx < pkg.tour.length - 1 && (
							<Button
								size="sm"
								variant="outline"
								onClick={() => {
									if (!isDone) toggleDone(step.order);
									setIdx(idx + 1);
								}}
							>
								{t("actions.nextStep")}
								<ChevronRight className="w-4 h-4 ml-1" />
							</Button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
