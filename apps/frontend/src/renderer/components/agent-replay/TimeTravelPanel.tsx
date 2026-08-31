import { GitBranch, Loader2, Plus, Target, Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTimeTravelStore } from "../../stores/time-travel-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

interface TimeTravelPanelProps {
	sessionId: string;
}

const formatPercent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * Time Travel — the half of `replay/api.py` that `agent-replay-store` does not
 * consume: checkpoints, forks and decision scores. It lives as a tab rather than
 * a separate view because it works on the session already selected here; the
 * store has always declared `"timeTravel"` in `ReplayTab`, with nothing
 * rendering it.
 */
export const TimeTravelPanel: React.FC<TimeTravelPanelProps> = ({
	sessionId,
}) => {
	const { t } = useTranslation();
	const {
		checkpoints,
		checkpointsLoading,
		selectedCheckpoint,
		forks,
		forksLoading,
		decisionScores,
		decisionScoresLoading,
		decisionHeatmap,
		forkFormVisible,
		forkFormCheckpointId,
		error,
		generateCheckpoints,
		fetchCheckpoints,
		deleteCheckpoint,
		selectCheckpoint,
		forkSession,
		fetchForks,
		deleteFork,
		openForkForm,
		closeForkForm,
		scoreDecisions,
		fetchDecisionScores,
		fetchDecisionHeatmap,
	} = useTimeTravelStore();

	const [modifiedPrompt, setModifiedPrompt] = useState("");
	const [additionalInstructions, setAdditionalInstructions] = useState("");
	const [forkProvider, setForkProvider] = useState("");
	const [forkModel, setForkModel] = useState("");

	useEffect(() => {
		if (!sessionId) return;
		fetchCheckpoints(sessionId);
		fetchForks(sessionId);
		fetchDecisionScores(sessionId);
		fetchDecisionHeatmap(sessionId);
	}, [
		sessionId,
		fetchCheckpoints,
		fetchForks,
		fetchDecisionScores,
		fetchDecisionHeatmap,
	]);

	// Critical decisions first: they are the ones worth forking from.
	const sortedScores = useMemo(
		() =>
			[...decisionScores].sort((a, b) => {
				if (a.is_critical !== b.is_critical) return a.is_critical ? -1 : 1;
				return b.impact_score - a.impact_score;
			}),
		[decisionScores],
	);

	async function handleFork() {
		if (!forkFormCheckpointId) return;
		await forkSession(sessionId, forkFormCheckpointId, {
			modifiedPrompt: modifiedPrompt.trim(),
			additionalInstructions: additionalInstructions.trim(),
			forkProvider: forkProvider.trim(),
			forkModel: forkModel.trim(),
		});
		setModifiedPrompt("");
		setAdditionalInstructions("");
		setForkProvider("");
		setForkModel("");
	}

	return (
		<div className="space-y-4">
			{error && (
				<div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
					{error}
				</div>
			)}

			{/* Checkpoints */}
			<Card>
				<CardHeader className="flex flex-row items-center justify-between py-3">
					<CardTitle className="text-sm">
						{t("replay:timeTravelPanel.checkpoints")}
					</CardTitle>
					<Button
						variant="outline"
						size="sm"
						onClick={() => generateCheckpoints(sessionId)}
						disabled={checkpointsLoading}
					>
						{checkpointsLoading ? (
							<Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
						) : (
							<Plus className="h-3.5 w-3.5 mr-1" />
						)}
						{t("replay:timeTravelPanel.generateCheckpoints")}
					</Button>
				</CardHeader>
				<CardContent className="pt-0">
					{checkpoints.length === 0 ? (
						<p className="text-sm text-muted-foreground py-3">
							{t("replay:timeTravelPanel.noCheckpoints")}
						</p>
					) : (
						<div className="space-y-1.5">
							{checkpoints.map((checkpoint) => {
								const isSelected = selectedCheckpoint?.id === checkpoint.id;
								return (
									<div
										key={checkpoint.id}
										className={`rounded-lg border p-2.5 ${isSelected ? "border-primary bg-primary/5" : ""}`}
									>
										<div className="flex items-start justify-between gap-2">
											<button
												type="button"
												className="text-left min-w-0 flex-1"
												onClick={() =>
													selectCheckpoint(isSelected ? null : checkpoint)
												}
											>
												<div className="flex items-center gap-2">
													<Badge variant="secondary" className="text-xs">
														#{checkpoint.step_index}
													</Badge>
													<span className="text-sm font-medium truncate">
														{checkpoint.label}
													</span>
													<Badge variant="outline" className="text-xs">
														{t(
															`replay:timeTravelPanel.checkpointType.${checkpoint.checkpoint_type}`,
														)}
													</Badge>
												</div>
												{checkpoint.description && (
													<p className="text-xs text-muted-foreground mt-0.5 truncate">
														{checkpoint.description}
													</p>
												)}
											</button>
											<div className="flex items-center gap-1 shrink-0">
												<Button
													variant="ghost"
													size="sm"
													onClick={() => openForkForm(checkpoint.id)}
												>
													<GitBranch className="h-3.5 w-3.5 mr-1" />
													{t("replay:timeTravelPanel.fork")}
												</Button>
												{checkpoint.checkpoint_type === "manual" && (
													<Button
														variant="ghost"
														size="sm"
														onClick={() =>
															deleteCheckpoint(sessionId, checkpoint.id)
														}
													>
														<Trash2 className="h-3.5 w-3.5" />
													</Button>
												)}
											</div>
										</div>
										{isSelected && (
											<div className="text-xs text-muted-foreground mt-2 flex items-center gap-3">
												<span>
													{t("replay:timeTravelPanel.tokensAtCheckpoint", {
														count: checkpoint.tokens_at_checkpoint,
													})}
												</span>
												<span>
													${checkpoint.cost_at_checkpoint.toFixed(4)}
												</span>
												<span>
													{t("replay:timeTravelPanel.filesCaptured", {
														count: Object.keys(checkpoint.file_snapshots)
															.length,
													})}
												</span>
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Fork form */}
			{forkFormVisible && (
				<Card>
					<CardHeader className="py-3">
						<CardTitle className="text-sm">
							{t("replay:timeTravelPanel.forkForm")}
						</CardTitle>
					</CardHeader>
					<CardContent className="pt-0 space-y-3">
						<div>
							<Label htmlFor="fork-prompt" className="text-xs">
								{t("replay:timeTravelPanel.modifiedPrompt")}
							</Label>
							<Textarea
								id="fork-prompt"
								rows={3}
								value={modifiedPrompt}
								onChange={(e) => setModifiedPrompt(e.target.value)}
								placeholder={t("replay:timeTravelPanel.modifiedPromptHint")}
							/>
						</div>
						<div>
							<Label htmlFor="fork-instructions" className="text-xs">
								{t("replay:timeTravelPanel.additionalInstructions")}
							</Label>
							<Textarea
								id="fork-instructions"
								rows={2}
								value={additionalInstructions}
								onChange={(e) => setAdditionalInstructions(e.target.value)}
							/>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div>
								<Label htmlFor="fork-provider" className="text-xs">
									{t("replay:timeTravelPanel.provider")}
								</Label>
								<Input
									id="fork-provider"
									value={forkProvider}
									onChange={(e) => setForkProvider(e.target.value)}
									placeholder={t("replay:timeTravelPanel.providerHint")}
								/>
							</div>
							<div>
								<Label htmlFor="fork-model" className="text-xs">
									{t("replay:timeTravelPanel.model")}
								</Label>
								<Input
									id="fork-model"
									value={forkModel}
									onChange={(e) => setForkModel(e.target.value)}
									placeholder={t("replay:timeTravelPanel.modelHint")}
								/>
							</div>
						</div>
						<div className="flex items-center gap-2">
							<Button size="sm" onClick={handleFork}>
								<GitBranch className="h-3.5 w-3.5 mr-1" />
								{t("replay:timeTravelPanel.createFork")}
							</Button>
							<Button variant="ghost" size="sm" onClick={closeForkForm}>
								{t("replay:timeTravelPanel.cancel")}
							</Button>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Forks */}
			<Card>
				<CardHeader className="py-3">
					<CardTitle className="text-sm">
						{t("replay:timeTravelPanel.forks")}
					</CardTitle>
				</CardHeader>
				<CardContent className="pt-0">
					{forksLoading ? (
						<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
					) : forks.length === 0 ? (
						<p className="text-sm text-muted-foreground py-2">
							{t("replay:timeTravelPanel.noForks")}
						</p>
					) : (
						<div className="space-y-1.5">
							{forks.map((fork) => (
								<div
									key={fork.fork_id}
									className="rounded-lg border p-2.5 flex items-start justify-between gap-2"
								>
									<div className="min-w-0">
										<div className="flex items-center gap-2">
											<Badge variant="outline" className="text-xs">
												{t(`replay:timeTravelPanel.forkStatus.${fork.status}`)}
											</Badge>
											<span className="text-sm font-mono truncate">
												{fork.fork_request.fork_model ||
													t("replay:timeTravelPanel.defaultModel")}
											</span>
										</div>
										{fork.fork_request.modified_prompt && (
											<p className="text-xs text-muted-foreground mt-0.5 truncate">
												{fork.fork_request.modified_prompt}
											</p>
										)}
									</div>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => deleteFork(fork.fork_id)}
									>
										<Trash2 className="h-3.5 w-3.5" />
									</Button>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Decision scores */}
			<Card>
				<CardHeader className="flex flex-row items-center justify-between py-3">
					<CardTitle className="text-sm">
						{t("replay:timeTravelPanel.decisions")}
					</CardTitle>
					<Button
						variant="outline"
						size="sm"
						onClick={() => scoreDecisions(sessionId)}
						disabled={decisionScoresLoading}
					>
						{decisionScoresLoading ? (
							<Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
						) : (
							<Target className="h-3.5 w-3.5 mr-1" />
						)}
						{t("replay:timeTravelPanel.scoreDecisions")}
					</Button>
				</CardHeader>
				<CardContent className="pt-0">
					{decisionHeatmap && (
						<div className="grid grid-cols-4 gap-2 mb-3">
							<div className="rounded-lg bg-muted p-2">
								<div className="text-lg font-bold">
									{decisionHeatmap.decision_count}
								</div>
								<div className="text-xs text-muted-foreground">
									{t("replay:timeTravelPanel.decisionCount")}
								</div>
							</div>
							<div className="rounded-lg bg-muted p-2">
								<div className="text-lg font-bold">
									{decisionHeatmap.critical_decisions}
								</div>
								<div className="text-xs text-muted-foreground">
									{t("replay:timeTravelPanel.criticalDecisions")}
								</div>
							</div>
							<div className="rounded-lg bg-muted p-2">
								<div className="text-lg font-bold">
									{formatPercent(decisionHeatmap.avg_confidence)}
								</div>
								<div className="text-xs text-muted-foreground">
									{t("replay:timeTravelPanel.avgConfidence")}
								</div>
							</div>
							<div className="rounded-lg bg-muted p-2">
								<div className="text-lg font-bold">
									{formatPercent(decisionHeatmap.avg_impact)}
								</div>
								<div className="text-xs text-muted-foreground">
									{t("replay:timeTravelPanel.avgImpact")}
								</div>
							</div>
						</div>
					)}

					{sortedScores.length === 0 ? (
						<p className="text-sm text-muted-foreground py-2">
							{t("replay:timeTravelPanel.noDecisions")}
						</p>
					) : (
						<div className="space-y-1.5">
							{sortedScores.map((score) => (
								<div
									key={score.step_id}
									className={`rounded-lg border p-2.5 ${score.is_critical ? "border-destructive/40 bg-destructive/5" : ""}`}
								>
									<div className="flex items-center justify-between gap-2">
										<div className="flex items-center gap-2">
											<Badge variant="secondary" className="text-xs">
												#{score.step_index}
											</Badge>
											{score.is_critical && (
												<Badge variant="destructive" className="text-xs">
													{t("replay:timeTravelPanel.critical")}
												</Badge>
											)}
										</div>
										<div className="text-xs text-muted-foreground flex items-center gap-3">
											<span>
												{t("replay:timeTravelPanel.confidence")}{" "}
												{formatPercent(score.confidence_score)}
											</span>
											<span>
												{t("replay:timeTravelPanel.impact")}{" "}
												{formatPercent(score.impact_score)}
											</span>
										</div>
									</div>
									{score.factors.length > 0 && (
										<p className="text-xs text-muted-foreground mt-1">
											{score.factors.join(" · ")}
										</p>
									)}
								</div>
							))}
						</div>
					)}

					{decisionHeatmap && decisionHeatmap.file_impact.length > 0 && (
						<div className="mt-3">
							<h4 className="text-xs font-semibold mb-1.5">
								{t("replay:timeTravelPanel.fileImpact")}
							</h4>
							<div className="space-y-1">
								{decisionHeatmap.file_impact.map((entry) => (
									<div
										key={entry.file_path}
										className="flex items-center justify-between gap-2 text-xs"
									>
										<span className="font-mono truncate">
											{entry.file_path}
										</span>
										<span className="text-muted-foreground shrink-0">
											{formatPercent(entry.impact_score)}
										</span>
									</div>
								))}
							</div>
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
};

export default TimeTravelPanel;
