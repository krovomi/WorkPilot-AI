import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/project-store";
import {
	type ApprovalStatus,
	type SpecApprovalRecord,
	useSpecApprovalStore,
} from "../../stores/spec-approval-store";

const STATUS_COLORS: Record<ApprovalStatus, string> = {
	pending: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
	approved: "text-green-400 bg-green-500/10 border-green-500/20",
	rejected: "text-red-400 bg-red-500/10 border-red-500/20",
	changes_requested: "text-blue-400 bg-blue-500/10 border-blue-500/20",
};

export function SpecApprovalDashboard(): React.ReactElement {
	const { t } = useTranslation(["specApproval"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const projectPath = activeProject?.path;

	const {
		pendingSpecs,
		history,
		selectedSpec,
		specContent,
		isLoading,
		isSubmitting,
		error,
		loadPendingSpecs,
		loadHistory,
		selectSpec,
		loadSpecContent,
		approve,
		reject,
		requestChanges,
		clearError,
	} = useSpecApprovalStore();

	const [feedback, setFeedback] = useState("");

	useEffect(() => {
		if (!projectPath) return;
		loadPendingSpecs(projectPath);
		loadHistory(projectPath);
	}, [projectPath, loadPendingSpecs, loadHistory]);

	function handleSelect(spec: SpecApprovalRecord) {
		selectSpec(spec);
		setFeedback("");
		if (projectPath) loadSpecContent(projectPath, spec.specNumber);
	}

	// Rejecting or asking for changes without saying why leaves the author with
	// nothing to act on, so both are gated on the feedback field.
	const canSubmitFeedback = feedback.trim().length > 0;

	return (
		<div className="flex flex-col h-full bg-[var(--bg-primary)] text-[var(--text-primary)]">
			{/* Header */}
			<div className="px-6 py-4 border-b border-[var(--border-color)]">
				<div className="flex items-center justify-between">
					<div>
						<h1 className="text-xl font-semibold">{t("specApproval:title")}</h1>
						<p className="text-sm text-[var(--text-secondary)] mt-0.5">
							{t("specApproval:subtitle")}
						</p>
					</div>
					<button
						type="button"
						onClick={() => {
							if (!projectPath) return;
							loadPendingSpecs(projectPath);
							loadHistory(projectPath);
						}}
						disabled={!projectPath || isLoading}
						className="px-3 py-2 rounded-lg bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
					>
						{t("specApproval:actions.refresh")}
					</button>
				</div>
			</div>

			{!activeProject ? (
				<div className="flex-1 flex items-center justify-center text-center p-8">
					<p className="text-sm text-[var(--text-secondary)] max-w-sm">
						{t("specApproval:empty.noProject")}
					</p>
				</div>
			) : (
				<div className="flex flex-1 overflow-hidden">
					{/* Left: pending + history */}
					<div className="w-72 border-r border-[var(--border-color)] p-4 flex flex-col gap-5 overflow-auto">
						<div>
							<h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
								{t("specApproval:pending.heading", {
									count: pendingSpecs.length,
								})}
							</h3>
							{pendingSpecs.length === 0 ? (
								<p className="text-xs text-[var(--text-secondary)]">
									{t("specApproval:pending.empty")}
								</p>
							) : (
								<div className="flex flex-col gap-1.5">
									{pendingSpecs.map((spec) => (
										<button
											key={spec.specNumber}
											type="button"
											onClick={() => handleSelect(spec)}
											className={`text-left rounded-lg p-2.5 transition-colors ${
												selectedSpec?.specNumber === spec.specNumber
													? "bg-[var(--accent)]/15 border border-[var(--accent)]/40"
													: "bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] border border-transparent"
											}`}
										>
											<div className="text-sm font-medium truncate">
												{spec.specName}
											</div>
											<div className="text-xs text-[var(--text-secondary)] font-mono">
												{spec.specNumber}
											</div>
										</button>
									))}
								</div>
							)}
						</div>

						{history.length > 0 && (
							<div>
								<h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
									{t("specApproval:history.heading")}
								</h3>
								<div className="flex flex-col gap-1.5">
									{history.map((spec) => (
										<div
											key={spec.specNumber}
											className="bg-[var(--bg-secondary)] rounded-lg p-2"
										>
											<div className="text-xs font-medium truncate">
												{spec.specName}
											</div>
											<span
												className={`inline-block mt-1 text-xs px-1.5 py-0.5 rounded border ${STATUS_COLORS[spec.status] ?? ""}`}
											>
												{t(`specApproval:status.${spec.status}`, spec.status)}
											</span>
										</div>
									))}
								</div>
							</div>
						)}
					</div>

					{/* Right: content + decision */}
					<div className="flex-1 flex flex-col overflow-hidden">
						{error && (
							<div className="m-4 mb-0 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-start justify-between gap-3">
								<span>{error}</span>
								<button
									type="button"
									onClick={clearError}
									className="shrink-0 text-xs underline"
								>
									{t("specApproval:actions.dismiss")}
								</button>
							</div>
						)}

						{!selectedSpec ? (
							<div className="flex-1 flex items-center justify-center text-center p-8">
								<div>
									<div className="text-5xl mb-4">📋</div>
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
									<h2 className="text-base font-semibold mb-1">
										{selectedSpec.specName}
									</h2>
									<div className="text-xs text-[var(--text-secondary)] font-mono mb-4">
										{selectedSpec.specDir}
									</div>

									{isLoading && !specContent ? (
										<p className="text-sm text-[var(--text-secondary)]">
											{t("specApproval:content.loading")}
										</p>
									) : specContent ? (
										<div className="flex flex-col gap-4">
											{specContent.spec_md && (
												<section>
													<h3 className="text-sm font-semibold mb-1">
														{t("specApproval:content.spec")}
													</h3>
													<pre className="text-xs font-mono whitespace-pre-wrap bg-[var(--bg-secondary)] rounded-lg p-3">
														{specContent.spec_md}
													</pre>
												</section>
											)}
											{specContent.requirements_json && (
												<details>
													<summary className="text-sm font-semibold cursor-pointer">
														{t("specApproval:content.requirements")}
													</summary>
													<pre className="mt-1 text-xs font-mono whitespace-pre-wrap bg-[var(--bg-secondary)] rounded-lg p-3">
														{specContent.requirements_json}
													</pre>
												</details>
											)}
											{specContent.implementation_plan_json && (
												<details>
													<summary className="text-sm font-semibold cursor-pointer">
														{t("specApproval:content.plan")}
													</summary>
													<pre className="mt-1 text-xs font-mono whitespace-pre-wrap bg-[var(--bg-secondary)] rounded-lg p-3">
														{specContent.implementation_plan_json}
													</pre>
												</details>
											)}
											{specContent.context_json && (
												<details>
													<summary className="text-sm font-semibold cursor-pointer">
														{t("specApproval:content.context")}
													</summary>
													<pre className="mt-1 text-xs font-mono whitespace-pre-wrap bg-[var(--bg-secondary)] rounded-lg p-3">
														{specContent.context_json}
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

								{/* Decision bar */}
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
											onClick={() =>
												projectPath &&
												approve(
													projectPath,
													selectedSpec.specNumber,
													feedback.trim() || undefined,
												)
											}
											disabled={isSubmitting}
											className="px-4 py-2 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
										>
											{t("specApproval:decision.approve")}
										</button>
										<button
											type="button"
											onClick={() =>
												projectPath &&
												requestChanges(
													projectPath,
													selectedSpec.specNumber,
													feedback.trim(),
												)
											}
											disabled={isSubmitting || !canSubmitFeedback}
											className="px-4 py-2 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
										>
											{t("specApproval:decision.requestChanges")}
										</button>
										<button
											type="button"
											onClick={() =>
												projectPath &&
												reject(
													projectPath,
													selectedSpec.specNumber,
													feedback.trim(),
												)
											}
											disabled={isSubmitting || !canSubmitFeedback}
											className="px-4 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
										>
											{t("specApproval:decision.reject")}
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
