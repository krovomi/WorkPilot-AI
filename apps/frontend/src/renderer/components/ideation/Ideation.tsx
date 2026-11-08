import { Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Idea, IdeationType } from "../../../shared/types";
import { useViewState } from "../../contexts/ViewStateContext";
import { useServerViewLive } from "../../hooks/useServerViewLive";
import { CharterButton, ModuleStage, Notice, Page, Panel } from "../charter";
import { EnvConfigModal } from "../EnvConfigModal";
import { Checkbox } from "../ui/checkbox";
import { ALL_IDEATION_TYPES, IDEATION_TYPE_TONES } from "./constants";
import { GenerationProgressScreen } from "./GenerationProgressScreen";
import { useIdeation } from "./hooks/useIdeation";
import { IdeaCard } from "./IdeaCard";
import { IdeaDetailPanel } from "./IdeaDetailPanel";
import { IdeationDialogs } from "./IdeationDialogs";
import { IdeationEmptyState } from "./IdeationEmptyState";
import { type IdeationTab, IdeationFilters } from "./IdeationFilters";
import { IdeationHeader } from "./IdeationHeader";
import { IDEATION_TYPE_ICONS } from "./TypeIcon";

interface IdeationProps {
	readonly projectId: string;
	readonly onGoToTask?: (taskId: string) => void;
}

export function Ideation({ projectId, onGoToTask }: IdeationProps) {
	const { t } = useTranslation("ideation");
	// A server project's ideas show a teammate's change at once.
	useServerViewLive(projectId, "ideation");
	// Get showArchived from shared context for cross-page sync
	const { showArchived } = useViewState();

	// Pass showArchived directly to the hook to avoid render lag from useEffect sync
	const {
		session,
		generationStatus,
		isGenerating,
		isLoadingSession,
		config,
		logs,
		typeStates,
		selectedIdea,
		activeTab,
		showConfigDialog,
		showDismissed,
		showEnvConfigModal,
		showAddMoreDialog,
		typesToAdd,
		hasToken,
		isCheckingToken,
		summary,
		activeIdeas,
		selectedIds,
		convertingIdeas,
		setSelectedIdea,
		setActiveTab,
		setShowConfigDialog,
		setShowDismissed,
		setShowEnvConfigModal,
		setShowAddMoreDialog,
		setTypesToAdd,
		setConfig,
		handleGenerate,
		handleRefresh,
		handleStop,
		handleDismissAll,
		handleDeleteSelected,
		handleConvertSelectedToTasks,
		handleSelectAll,
		handleEnvConfigured,
		getAvailableTypesToAdd,
		handleAddMoreIdeas,
		toggleTypeToAdd,
		handleConvertToTask,
		handleGoToTask,
		handleDismiss,
		toggleIdeationType,
		toggleSelectIdea,
		clearSelection,
		getIdeasByType,
	} = useIdeation(projectId, { onGoToTask, showArchived });

	const getCheckboxState = (
		selectedCount: number,
		totalCount: number,
	): boolean | "indeterminate" => {
		if (selectedCount === totalCount) return true;
		if (selectedCount > 0) return "indeterminate";
		return false;
	};

	// Show generation progress with streaming ideas (use isGenerating flag for reliable state)
	if (isGenerating) {
		return (
			<GenerationProgressScreen
				generationStatus={generationStatus}
				logs={logs}
				typeStates={typeStates}
				enabledTypes={config.enabledTypes}
				session={session}
				onSelectIdea={setSelectedIdea}
				selectedIdea={selectedIdea}
				onConvert={handleConvertToTask}
				onGoToTask={handleGoToTask}
				onDismiss={handleDismiss}
				onStop={handleStop}
			/>
		);
	}

	const showEmptyState =
		isLoadingSession || !session || session.ideas.length === 0;

	const visibleIdeasOf = (type: IdeationType): Idea[] =>
		getIdeasByType(type).filter((idea) => {
			if (!showDismissed && idea.status === "dismissed") return false;
			if (!showArchived && idea.status === "archived") return false;
			return true;
		});
	const counts = Object.fromEntries([
		["all", activeIdeas.length],
		...ALL_IDEATION_TYPES.map((type) => [type, visibleIdeasOf(type).length]),
	]) as Record<IdeationTab, number>;
	const activeType =
		activeTab === "all" ? null : (activeTab as IdeationType);
	const listedIdeas = activeType ? visibleIdeasOf(activeType) : activeIdeas;

	return (
		<ModuleStage scroll="page" data-testid="ideation-view">
			{showEmptyState ? (
				<IdeationEmptyState
					config={config}
					hasToken={hasToken}
					isCheckingToken={isCheckingToken || isLoadingSession}
					onGenerate={handleGenerate}
					onOpenConfig={() => setShowConfigDialog(true)}
					onToggleIdeationType={toggleIdeationType}
				/>
			) : (
				<>
					<IdeationHeader
						totalIdeas={summary.totalIdeas}
						ideaCountByType={summary.byType}
						showDismissed={showDismissed}
						selectedCount={selectedIds.size}
						onToggleShowDismissed={() => setShowDismissed(!showDismissed)}
						onOpenConfig={() => setShowConfigDialog(true)}
						onOpenAddMore={() => {
							setTypesToAdd([]);
							setShowAddMoreDialog(true);
						}}
						onDismissAll={handleDismissAll}
						onDeleteSelected={handleDeleteSelected}
						onConvertSelected={handleConvertSelectedToTasks}
						onSelectAll={() => handleSelectAll(activeIdeas)}
						onClearSelection={clearSelection}
						onRefresh={handleRefresh}
						hasActiveIdeas={activeIdeas.length > 0}
						canAddMore={getAvailableTypesToAdd().length > 0}
					/>
					<IdeationFilters
						activeTab={activeTab}
						onTabChange={setActiveTab}
						counts={counts}
					/>

					<Page className="max-w-none space-y-3 pt-1">
						{activeType && (
							<Notice
								tone={IDEATION_TYPE_TONES[activeType]}
								icon={IDEATION_TYPE_ICONS[activeType]}
							>
								{t(`typeDescriptions.${activeType}`)}
							</Notice>
						)}
						{!activeType && activeIdeas.length > 0 && (
							<Panel className="flex items-center gap-3 py-2.5">
								<Checkbox
									checked={getCheckboxState(
										selectedIds.size,
										activeIdeas.length,
									)}
									onCheckedChange={(checked) => {
										if (checked) {
											handleSelectAll(activeIdeas);
										} else {
											clearSelection();
										}
									}}
									aria-label={t("header.selectAll")}
								/>
								<span className="wp-muted select-none text-sm">
									{t("header.selectAll")}
								</span>
								<CharterButton
									size="sm"
									icon={Play}
									className="ml-auto"
									onClick={async () => {
										handleSelectAll(activeIdeas);
										await handleConvertSelectedToTasks();
									}}
								>
									{t("header.importAll")}
								</CharterButton>
							</Panel>
						)}
						<div className="grid gap-2.5">
							{listedIdeas.map((idea) => (
								<IdeaCard
									key={idea.id}
									idea={idea}
									isSelected={selectedIds.has(idea.id)}
									onClick={() =>
										setSelectedIdea(
											selectedIdea?.id === idea.id ? null : idea,
										)
									}
									onConvert={handleConvertToTask}
									onGoToTask={handleGoToTask}
									onDismiss={handleDismiss}
									onToggleSelect={toggleSelectIdea}
								/>
							))}
							{listedIdeas.length === 0 && (
								<p className="wp-muted py-8 text-center text-sm">
									{activeType
										? t("generation.noIdeasCategory")
										: t("noIdeas")}
								</p>
							)}
						</div>
					</Page>

					{selectedIdea && (
						<IdeaDetailPanel
							idea={selectedIdea}
							onClose={() => setSelectedIdea(null)}
							onConvert={handleConvertToTask}
							onGoToTask={handleGoToTask}
							onDismiss={handleDismiss}
							isConverting={convertingIdeas.has(selectedIdea.id)}
						/>
					)}
				</>
			)}

			{/* Dialogs — always rendered so they mount/unmount cleanly without affecting sibling layout */}
			<IdeationDialogs
				showConfigDialog={showConfigDialog}
				showAddMoreDialog={showEmptyState ? false : showAddMoreDialog}
				config={config}
				typesToAdd={showEmptyState ? [] : typesToAdd}
				availableTypesToAdd={showEmptyState ? [] : getAvailableTypesToAdd()}
				onToggleIdeationType={toggleIdeationType}
				onToggleTypeToAdd={
					showEmptyState
						? () => {
								/* noop */
							}
						: toggleTypeToAdd
				}
				onSetConfig={setConfig}
				onCloseConfigDialog={() => setShowConfigDialog(false)}
				onCloseAddMoreDialog={() => setShowAddMoreDialog(false)}
				onConfirmAddMore={
					showEmptyState
						? () => {
								/* noop */
							}
						: handleAddMoreIdeas
				}
			/>

			{/* Environment Configuration Modal */}
			<EnvConfigModal
				open={showEnvConfigModal}
				onOpenChange={setShowEnvConfigModal}
				onConfigured={handleEnvConfigured}
				title={t("auth.title")}
				description={t("auth.description")}
				projectId={projectId}
			/>
		</ModuleStage>
	);
}
