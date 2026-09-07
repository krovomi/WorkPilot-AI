import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOnboardingAgentStore } from "../../stores/onboarding-agent-store";
import { CategoryBadge, DifficultyBadge, EmptyState } from "./shared";

export function FirstTasksPanel(): React.ReactElement | null {
	const { t } = useTranslation("onboardingAgent");
	const pkg = useOnboardingAgentStore((s) => s.pkg);
	const [filter, setFilter] = useState<string>("all");

	if (!pkg) return null;
	if (pkg.first_tasks.length === 0) {
		return <EmptyState message={t("emptyFirstTasks")} />;
	}

	const categories = Array.from(
		new Set(pkg.first_tasks.map((task) => task.category)),
	);
	const visible = pkg.first_tasks.filter(
		(task) => filter === "all" || task.category === filter,
	);

	return (
		<div className="space-y-3">
			<p className="text-sm text-muted-foreground">{t("firstTasksIntro")}</p>

			<div className="flex flex-wrap gap-1.5">
				<button
					type="button"
					onClick={() => setFilter("all")}
					className={`px-2 py-0.5 rounded-md text-xs border ${
						filter === "all" ? "bg-accent" : "hover:bg-accent/50"
					}`}
				>
					{t("filters.all", { count: pkg.first_tasks.length })}
				</button>
				{categories.map((category) => (
					<button
						type="button"
						key={category}
						onClick={() => setFilter(category)}
						className={`px-2 py-0.5 rounded-md text-xs border ${
							filter === category ? "bg-accent" : "hover:bg-accent/50"
						}`}
					>
						{t(`taskCategories.${category}`)}
					</button>
				))}
			</div>

			<div className="space-y-2">
				{visible.map((task) => (
					<div
						key={`${task.category}:${task.file_path}:${task.line}`}
						className="border rounded-md p-3 bg-card"
					>
						<div className="flex items-start justify-between gap-3">
							<p className="font-medium text-sm">{task.title}</p>
							<div className="flex gap-1 shrink-0">
								<CategoryBadge
									category={task.category}
									label={t(`taskCategories.${task.category}`)}
								/>
								<DifficultyBadge
									difficulty={task.difficulty}
									label={t(`difficulty.${task.difficulty}`)}
								/>
							</div>
						</div>
						<p className="text-xs font-mono text-muted-foreground mt-1">
							{task.file_path}
							{task.line > 1 ? `:${task.line}` : ""}
						</p>
						{task.source_comment && (
							<p className="text-xs text-muted-foreground mt-1 break-all">
								{task.source_comment}
							</p>
						)}
						{task.why && (
							<p className="text-xs italic text-muted-foreground mt-1">
								{task.why}
							</p>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
