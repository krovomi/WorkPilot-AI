import { AlertTriangle, FileCode, Sparkles, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	Idea,
	IdeationGenerationStatus,
	IdeationSession,
	IdeationType,
} from "../../../shared/types";
import type { IdeationTypeState } from "../../stores/ideation-store";
import {
	Bar,
	CharterButton,
	Chip,
	Chips,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	Panel,
	Section,
	type Tone,
} from "../charter";
import { IDEATION_TYPE_TONES } from "./constants";
import { IdeaCard } from "./IdeaCard";
import { IdeaDetailPanel } from "./IdeaDetailPanel";
import { IdeaSkeletonCard } from "./IdeaSkeletonCard";
import { TypeStateIcon } from "./TypeStateIcon";

const STATE_TONES: Record<IdeationTypeState, Tone> = {
	pending: "muted",
	generating: "accent",
	completed: "green",
	failed: "red",
};

interface GenerationProgressScreenProps {
	readonly generationStatus: IdeationGenerationStatus;
	readonly logs: string[];
	readonly typeStates: Record<IdeationType, IdeationTypeState>;
	readonly enabledTypes: IdeationType[];
	readonly session: IdeationSession | null;
	readonly onSelectIdea: (idea: Idea | null) => void;
	readonly selectedIdea: Idea | null;
	readonly onConvert: (idea: Idea) => void;
	readonly onGoToTask?: (taskId: string) => void;
	readonly onDismiss: (idea: Idea) => void;
	readonly onStop: () => void | Promise<void>;
}

export function GenerationProgressScreen({
	generationStatus,
	logs,
	typeStates,
	enabledTypes,
	session,
	onSelectIdea,
	selectedIdea,
	onConvert,
	onGoToTask,
	onDismiss,
	onStop,
}: GenerationProgressScreenProps) {
	const { t } = useTranslation(["ideation", "navigation"]);
	const logsEndRef = useRef<HTMLDivElement>(null);
	const [showLogs, setShowLogs] = useState(false);
	const [isStopping, setIsStopping] = useState(false);

	/**
	 * Handle stop button click with error handling and double-click prevention
	 */
	const handleStopClick = async () => {
		if (isStopping) return;

		setIsStopping(true);
		try {
			await onStop();
		} catch (err) {
			console.error("Failed to stop generation:", err);
		} finally {
			setIsStopping(false);
		}
	};

	// Auto-scroll to bottom when logs update
	useEffect(() => {
		if (logsEndRef.current && showLogs) {
			logsEndRef.current.scrollIntoView({ behavior: "smooth" });
		}
	}, [showLogs]);

	const getStreamingIdeasByType = (type: IdeationType): Idea[] => {
		if (!session) return [];
		return session.ideas.filter(
			(idea) =>
				idea.type === type &&
				idea.status !== "dismissed" &&
				idea.status !== "archived",
		);
	};

	const completedCount = enabledTypes.filter(
		(t) => typeStates[t] === "completed",
	).length;

	return (
		<ModuleStage scroll="page" data-testid="ideation-generation">
			<ModuleHeader
				kicker={t("navigation:groups.explore")}
				title={t("generation.title")}
				description={generationStatus.message}
				icon={Sparkles}
				tone="amber"
				actions={
					<>
						<CharterButton
							size="sm"
							variant="ghost"
							icon={FileCode}
							aria-pressed={showLogs}
							onClick={() => setShowLogs(!showLogs)}
						>
							{showLogs ? t("generation.hideLogs") : t("generation.showLogs")}
						</CharterButton>
						<CharterButton
							size="sm"
							variant="danger"
							icon={Square}
							onClick={handleStopClick}
							disabled={isStopping}
							title={t("generation.stopTooltip")}
						>
							{isStopping ? t("generation.stopping") : t("generation.stop")}
						</CharterButton>
					</>
				}
			/>

			<Page className="space-y-4 pt-1">
				<Panel className="space-y-3">
					<div className="flex items-center justify-between gap-3">
						<span className="wp-kicker">
							{t("generation.complete", {
								completed: completedCount,
								total: enabledTypes.length,
							})}
						</span>
						<span className="wp-meta">
							{Math.round(generationStatus.progress)}%
						</span>
					</div>
					<Bar value={generationStatus.progress} tone="amber" />
					<Chips>
						{enabledTypes.map((type) => (
							<Chip key={type} tone={STATE_TONES[typeStates[type]]} dot={false}>
								<TypeStateIcon state={typeStates[type]} />
								{t(`types.${type}`)}
								{typeStates[type] === "completed" && session && (
									<span className="font-semibold">
										{getStreamingIdeasByType(type).length}
									</span>
								)}
							</Chip>
						))}
					</Chips>
				</Panel>

				{showLogs && logs.length > 0 && (
					<pre className="wp-code max-h-40 overflow-auto p-3 text-xs">
						{logs.map((log, index) => (
							<div key={log.slice(0, 50)} className="leading-relaxed">
								<span className="wp-muted mr-2 select-none">
									{String(index + 1).padStart(3, "0")}
								</span>
								{log}
							</div>
						))}
						<div ref={logsEndRef} />
					</pre>
				)}

				{generationStatus.error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{generationStatus.error}
					</Notice>
				)}

				{enabledTypes.map((type) => {
					const ideas = getStreamingIdeasByType(type);
					const state = typeStates[type];
					return (
						<Section
							key={type}
							kicker={<TypeStateIcon state={state} />}
							title={t(`types.${type}`)}
							tone={IDEATION_TYPE_TONES[type]}
							meta={
								ideas.length > 0
									? t("generation.ideasCount", { count: ideas.length })
									: undefined
							}
						>
							<div className="grid gap-2.5">
								{ideas.map((idea) => (
									<IdeaCard
										key={idea.id}
										idea={idea}
										isSelected={false}
										onClick={() =>
											onSelectIdea(selectedIdea?.id === idea.id ? null : idea)
										}
										onConvert={onConvert}
										onGoToTask={onGoToTask}
										onDismiss={onDismiss}
										onToggleSelect={() => {
											/* Selection disabled during generation */
										}}
									/>
								))}
								{state === "generating" && (
									<>
										<IdeaSkeletonCard />
										<IdeaSkeletonCard />
									</>
								)}
								{state === "pending" && (
									<p className="wp-muted py-2 text-sm">
										{t("generation.waitingToStart")}
									</p>
								)}
								{state === "failed" && ideas.length === 0 && (
									<p className="py-2 text-sm text-destructive">
										{t("generation.failedCategory")}
									</p>
								)}
								{state === "completed" && ideas.length === 0 && (
									<p className="wp-muted py-2 text-sm">
										{t("generation.noIdeasCategory")}
									</p>
								)}
							</div>
						</Section>
					);
				})}
			</Page>

			{selectedIdea && (
				<IdeaDetailPanel
					idea={selectedIdea}
					onClose={() => onSelectIdea(null)}
					onConvert={onConvert}
					onGoToTask={onGoToTask}
					onDismiss={onDismiss}
				/>
			)}
		</ModuleStage>
	);
}
