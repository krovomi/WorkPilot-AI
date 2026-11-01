import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/project-store";
import {
	pendingPlanApprovals,
	useSpecApprovalStore,
} from "../../stores/spec-approval-store";
import { startTask, submitReview, useTaskStore } from "../../stores/task-store";

/**
 * The plans waiting for a person, across the project's board.
 *
 * Each row is a task in plan review. Approving it is the card's own plan
 * approval (`submitReview` then `startTask`), and requesting changes sends the
 * feedback the same way, so the build reads the decision. The list is the
 * task store's: a plan approved here or on the card leaves it at once.
 */
export function SpecApprovalDashboard(): React.ReactElement {
	const { t } = useTranslation(["specApproval"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const projectPath = activeProject?.path;
	const tasks = useTaskStore((s) => s.tasks);
	const pending = useMemo(
		() => pendingPlanApprovals(tasks, activeProject?.id),
		[tasks, activeProject?.id],
	);

	const content = useSpecApprovalStore((s) => s.content);
	const isLoading = useSpecApprovalStore((s) => s.isLoading);
	const error = useSpecApprovalStore((s) => s.error);
	const loadContent = useSpecApprovalStore((s) => s.loadContent);
	const clear = useSpecApprovalStore((s) => s.clear);
	const setError = useSpecApprovalStore((s) => s.setError);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [feedback, setFeedback] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const selected = pending.find((task) => task.id === selectedId) ?? null;

	// A task that left plan review (approved here, on its card, or elsewhere)
	// is no longer selectable.
	useEffect(() => {
		if (selectedId && !selected) {
			setSelectedId(null);
			setFeedback("");
			clear();
		}
	}, [selectedId, selected, clear]);

	useEffect(() => () => clear(), [clear]);

	function handleSelect(taskId: string, specId: string) {
		setSelectedId(taskId);
		setFeedback("");
		if (projectPath) void loadContent(projectPath, specId);
	}

	async function decide(approved: boolean) {
		if (!selected) return;
		setIsSubmitting(true);
		try {
			const ok = await submitReview(
				selected.id,
				approved,
				approved ? undefined : feedback.trim(),
			);
			if (!ok) {
				setError(t("specApproval:decision.failed"));
				return;
			}
			if (approved) startTask(selected.id);
			setSelectedId(null);
			setFeedback("");
			clear();
		} finally {
			setIsSubmitting(false);
		}
	}

	// Sending a plan back without saying why leaves the planner with nothing
	// to act on, so the request is gated on the feedback field.
	const canSubmitFeedback = feedback.trim().length > 0;

	return (
		<div className="flex flex-col h-full bg-[var(--bg-primary)] text-[var(--text-primary)]">
			<div className="px-6 py-4 border-b border-[var(--border-color)]">
				<h1 className="text-xl font-semibold">{t("specApproval:title")}</h1>
				<p className="text-sm text-[var(--text-secondary)] mt-0.5">
					{t("specApproval:subtitle")}
				</p>
			</div>

			{!activeProject ? (
				<div className="flex-1 flex items-center justify-center text-center p-8">
					<p className="text-sm text-[var(--text-secondary)] max-w-sm">
						{t("specApproval:empty.noProject")}
					</p>
				</div>
			) : (
				<div className="flex flex-1 overflow-hidden">
					<div className="w-72 border-r border-[var(--border-color)] p-4 flex flex-col gap-5 overflow-auto">
						<div>
							<h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
								{t("specApproval:pending.heading", { count: pending.length })}
							</h3>
							{pending.length === 0 ? (
								<p className="text-xs text-[var(--text-secondary)]">
									{t("specApproval:pending.empty")}
								</p>
							) : (
								<div className="flex flex-col gap-1.5">
									{pending.map((task) => (
										<button
											key={task.id}
											type="button"
											onClick={() => handleSelect(task.id, task.specId)}
											className={`text-left rounded-lg p-2.5 transition-colors ${
												selectedId === task.id
													? "bg-[var(--accent)]/15 border border-[var(--accent)]/40"
													: "bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] border border-transparent"
											}`}
										>
											<div className="text-sm font-medium truncate">{task.title}</div>
											<div className="text-xs text-[var(--text-secondary)] font-mono">
												{task.specId}
											</div>
										</button>
									))}
								</div>
							)}
						</div>
					</div>

					<div className="flex-1 flex flex-col overflow-hidden">
						{error && (
							<div className="m-4 mb-0 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-start justify-between gap-3">
								<span>{error}</span>
								<button
									type="button"
									onClick={() => setError(null)}
									className="shrink-0 text-xs underline"
								>
									{t("specApproval:actions.dismiss")}
								</button>
							</div>
						)}

						{!selected ? (
							<div className="flex-1 flex items-center justify-center text-center p-8">
								<div>
									<h3 className="text-lg font-medium mb-2">
										{t("specApproval:empty.title")}
									</h3>
									<p className="text-sm text-[var(--text-secondary)] max-w-sm">
										{t("specApproval:empty.body")}
									</p>
								</div>
							</div>
						) : (
							<>
								<div className="flex-1 overflow-auto p-4">
									<h2 className="text-base font-semibold mb-1">{selected.title}</h2>
									<div className="text-xs text-[var(--text-secondary)] font-mono mb-4">
										{selected.specId}
									</div>

									{isLoading && !content ? (
										<p className="text-sm text-[var(--text-secondary)]">
											{t("specApproval:content.loading")}
										</p>
									) : content?.spec_md || content?.implementation_plan_json ? (
										<div className="flex flex-col gap-4">
											{content.spec_md && (
												<section>
													<h3 className="text-sm font-semibold mb-1">
														{t("specApproval:content.spec")}
													</h3>
													<pre className="text-xs font-mono whitespace-pre-wrap bg-[var(--bg-secondary)] rounded-lg p-3">
														{content.spec_md}
													</pre>
												</section>
											)}
											{content.implementation_plan_json && (
												<details open>
													<summary className="text-sm font-semibold cursor-pointer">
														{t("specApproval:content.plan")}
													</summary>
													<pre className="mt-1 text-xs font-mono whitespace-pre-wrap bg-[var(--bg-secondary)] rounded-lg p-3">
														{content.implementation_plan_json}
													</pre>
												</details>
											)}
											{content.requirements_json && (
												<details>
													<summary className="text-sm font-semibold cursor-pointer">
														{t("specApproval:content.requirements")}
													</summary>
													<pre className="mt-1 text-xs font-mono whitespace-pre-wrap bg-[var(--bg-secondary)] rounded-lg p-3">
														{content.requirements_json}
													</pre>
												</details>
											)}
											{content.context_json && (
												<details>
													<summary className="text-sm font-semibold cursor-pointer">
														{t("specApproval:content.context")}
													</summary>
													<pre className="mt-1 text-xs font-mono whitespace-pre-wrap bg-[var(--bg-secondary)] rounded-lg p-3">
														{content.context_json}
													</pre>
												</details>
											)}
										</div>
									) : (
										<p className="text-sm text-[var(--text-secondary)]">
											{t("specApproval:content.unavailable")}
										</p>
									)}
								</div>

								<div className="border-t border-[var(--border-color)] p-4 flex flex-col gap-3">
									<label
										htmlFor="spec-approval-feedback"
										className="text-xs text-[var(--text-secondary)]"
									>
										{t("specApproval:decision.feedbackLabel")}
									</label>
									<textarea
										id="spec-approval-feedback"
										value={feedback}
										onChange={(e) => setFeedback(e.target.value)}
										rows={3}
										placeholder={t("specApproval:decision.feedbackPlaceholder")}
										className="w-full resize-none rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] p-2 text-sm"
									/>
									<div className="flex items-center gap-2">
										<button
											type="button"
											onClick={() => void decide(true)}
											disabled={isSubmitting}
											className="px-4 py-2 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
										>
											{t("specApproval:decision.approve")}
										</button>
										<button
											type="button"
											onClick={() => void decide(false)}
											disabled={isSubmitting || !canSubmitFeedback}
											className="px-4 py-2 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
										>
											{t("specApproval:decision.requestChanges")}
										</button>
										{!canSubmitFeedback && (
											<span className="text-xs text-[var(--text-secondary)]">
												{t("specApproval:decision.feedbackRequired")}
											</span>
										)}
									</div>
								</div>
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

export default SpecApprovalDashboard;
