import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/project-store";
import {
	pendingPlanApprovals,
	useSpecApprovalStore,
} from "../../stores/spec-approval-store";
import { startTask, submitReview, useTaskStore } from "../../stores/task-store";
import {
	AlertTriangle,
	Check,
	CheckCircle2,
	ClipboardCheck,
	FileText,
	MessageSquareReply,
} from "lucide-react";
import {
	CharterButton,
	Chip,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
} from "../charter";
import { Textarea } from "../ui/textarea";


/**
 * The plans waiting for a person, across the project's board.
 *
 * Each row is a task in plan review. Approving it is the card's own plan
 * approval (`submitReview` then `startTask`), and requesting changes sends the
 * feedback the same way, so the build reads the decision. The list is the
 * task store's: a plan approved here or on the card leaves it at once.
 */
export function SpecApprovalDashboard(): React.ReactElement {
	const { t } = useTranslation(["specApproval", "navigation"]);
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

	const pre = "wp-code mt-1 whitespace-pre-wrap";
	const extras = [
		["plan", content?.implementation_plan_json, true],
		["requirements", content?.requirements_json, false],
		["context", content?.context_json, false],
	] as const;

	return (
		<ModuleStage data-testid="spec-approval-view">
			<ModuleHeader
				kicker={t("navigation:groups.planning")}
				title={t("specApproval:title")}
				description={t("specApproval:subtitle")}
				icon={ClipboardCheck}
				tone="green"
				actions={
					<Chip tone={pending.length ? "amber" : "muted"}>
						{t("specApproval:pending.heading", { count: pending.length })}
					</Chip>
				}
			/>

			{!activeProject ? (
				<div className="relative z-[1] flex flex-1 items-center justify-center p-8">
					<EmptyStage icon={ClipboardCheck} title={t("specApproval:title")} tone="green">
						{t("specApproval:empty.noProject")}
					</EmptyStage>
				</div>
			) : (
				<>
					<Columns template="minmax(16rem, 1fr) minmax(0, 3fr)">
						<Column
							kicker={t("specApproval:kickers.queue")}
							title={t("specApproval:queueTitle")}
							meta={pending.length}
							tone="amber"
						>
							{pending.length === 0 ? (
								<EmptyStage icon={CheckCircle2} title={t("specApproval:pending.emptyTitle")} tone="green">
									{t("specApproval:pending.empty")}
								</EmptyStage>
							) : (
								<div className="grid gap-2">
									{pending.map((task) => (
										<button
											key={task.id}
											type="button"
											onClick={() => handleSelect(task.id, task.specId)}
											className="wp-card wp-card-pad wp-rail wp-step wp-tone-amber text-left"
											data-active={selectedId === task.id ? "true" : undefined}
										>
											<div className="wp-title truncate text-sm">{task.title}</div>
											<div className="wp-meta mt-0.5 font-mono">{task.specId}</div>
										</button>
									))}
								</div>
							)}
						</Column>

						<Column
							kicker={t("specApproval:kickers.plan")}
							title={selected ? selected.title : t("specApproval:empty.title")}
							meta={selected ? <span className="font-mono">{selected.specId}</span> : undefined}
						>
							{error && (
								<Notice tone="red" icon={AlertTriangle} role="alert">
									<span className="flex items-start justify-between gap-3">
										<span>{error}</span>
										<CharterButton size="sm" variant="ghost" onClick={() => setError(null)}>
											{t("specApproval:actions.dismiss")}
										</CharterButton>
									</span>
								</Notice>
							)}
							{!selected ? (
								<EmptyStage icon={FileText} title={t("specApproval:empty.title")} tone="green">
									{t("specApproval:empty.body")}
								</EmptyStage>
							) : isLoading && !content ? (
								<ScanLine label={t("specApproval:content.loading")} />
							) : content?.spec_md || content?.implementation_plan_json ? (
								<div className="space-y-3">
									{content.spec_md && (
										<Panel>
											<span className="wp-kicker">{t("specApproval:content.spec")}</span>
											<pre className={pre}>{content.spec_md}</pre>
										</Panel>
									)}
									{extras.map(
										([key, body, open]) =>
											body && (
												<Panel key={key}>
													<details open={open}>
														<summary className="wp-kicker cursor-pointer">
															{t(`specApproval:content.${key}`)}
														</summary>
														<pre className={pre}>{body}</pre>
													</details>
												</Panel>
											),
									)}
								</div>
							) : (
								<Notice tone="muted" icon={FileText}>
									{t("specApproval:content.unavailable")}
								</Notice>
							)}
						</Column>
					</Columns>

					{selected && (
						<Composer
							prompt={
								<Textarea
									id="spec-approval-feedback"
									value={feedback}
									onChange={(e) => setFeedback(e.target.value)}
									rows={2}
									aria-label={t("specApproval:decision.feedbackLabel")}
									placeholder={t("specApproval:decision.feedbackPlaceholder")}
									className="min-h-0 w-full flex-1 resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
								/>
							}
							actions={
								<>
									<CharterButton
										icon={MessageSquareReply}
										onClick={() => void decide(false)}
										disabled={isSubmitting || !canSubmitFeedback}
									>
										{t("specApproval:decision.requestChanges")}
									</CharterButton>
									<CharterButton
										variant="primary"
										icon={Check}
										busy={isSubmitting}
										onClick={() => void decide(true)}
										disabled={isSubmitting}
									>
										{t("specApproval:decision.approve")}
									</CharterButton>
								</>
							}
							hint={
								canSubmitFeedback
									? t("specApproval:decision.feedbackLabel")
									: t("specApproval:decision.feedbackRequired")
							}
						/>
					)}
				</>
			)}
		</ModuleStage>
	);
}

export default SpecApprovalDashboard;
