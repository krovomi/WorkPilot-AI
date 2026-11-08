import { FileText } from "lucide-react";
import { EmptyStage, ModuleStage } from "../charter";
import { TooltipProvider } from "../ui/tooltip";
import {
	Step2ConfigureGenerate,
	Step3ReleaseArchive,
} from "./ChangelogDetails";
import { ChangelogFilters } from "./ChangelogFilters";
import { ChangelogHeader } from "./ChangelogHeader";
import { ChangelogList } from "./ChangelogList";
import { useChangelog } from "./hooks/useChangelog";
import { useTranslation } from "react-i18next";
import { SharedChangelogNote, useServerChangelogProject } from "./SharedChangelogNote";

export function Changelog() {
	const { t } = useTranslation();
	const {
		// State
		selectedProjectId,
		doneTasks,
		selectedTaskIds,
		existingChangelog,
		sourceMode,
		branches,
		tags,
		currentBranch: _currentBranch,
		defaultBranch,
		previewCommits,
		isLoadingGitData,
		isLoadingCommits,
		gitHistoryType,
		gitHistoryCount,
		gitHistorySinceDate,
		gitHistoryFromTag,
		gitHistoryToTag,
		gitHistorySinceVersion,
		includeMergeCommits,
		baseBranch,
		compareBranch,
		version,
		date,
		format,
		audience,
		emojiLevel,
		customInstructions,
		generationProgress,
		generatedChangelog,
		isGenerating,
		error,
		step,
		showAdvanced,
		saveSuccess,
		copySuccess,
		versionReason,
		canGenerate,
		canSave,
		canContinue,
		// Actions
		toggleTaskSelection,
		selectAllTasks,
		deselectAllTasks,
		setSourceMode,
		setGitHistoryType,
		setGitHistoryCount,
		setGitHistorySinceDate,
		setGitHistoryFromTag,
		setGitHistoryToTag,
		setGitHistorySinceVersion,
		setIncludeMergeCommits,
		setBaseBranch,
		setCompareBranch,
		setVersion,
		setDate,
		setFormat,
		setAudience,
		setEmojiLevel,
		setCustomInstructions,
		updateGeneratedChangelog,
		setShowAdvanced,
		setStep,
		handleLoadCommitsPreview,
		handleGenerate,
		handleSave,
		handleCopy,
		handleContinue,
		handleBack,
		handleDone,
		handleRefresh,
	} = useChangelog();
	const serverProject = Boolean(useServerChangelogProject());

	if (!selectedProjectId) {
		return (
			<ModuleStage data-testid="changelog-view">
				<div className="relative z-[1] flex flex-1 items-center justify-center p-8">
					<EmptyStage icon={FileText} title={t("changelog:noProject.title")} tone="green">
						{t("changelog:noProject.description")}
					</EmptyStage>
				</div>
			</ModuleStage>
		);
	}

	return (
		<TooltipProvider>
			<ModuleStage data-testid="changelog-view">
				{/* Header */}
				<ChangelogHeader step={step} onRefresh={handleRefresh} />

				{/* Content */}
				{step === 1 && (
					<SharedChangelogNote
						isGenerating={isGenerating}
						onOpen={(changelog, sharedVersion) => {
							updateGeneratedChangelog(changelog);
							if (sharedVersion) setVersion(sharedVersion);
							setStep(2);
						}}
					/>
				)}
				{step === 1 && (
					<div className="relative z-[1] flex min-h-0 flex-1 gap-4 px-5 pb-4">
						<ChangelogFilters
							sourceMode={sourceMode}
							onSourceModeChange={setSourceMode}
							doneTasksCount={doneTasks.length}
							branches={branches}
							tags={tags}
							defaultBranch={defaultBranch}
							isLoadingGitData={isLoadingGitData}
							isLoadingCommits={isLoadingCommits}
							gitHistoryType={gitHistoryType}
							gitHistoryCount={gitHistoryCount}
							gitHistorySinceDate={gitHistorySinceDate}
							gitHistoryFromTag={gitHistoryFromTag}
							gitHistoryToTag={gitHistoryToTag}
							gitHistorySinceVersion={gitHistorySinceVersion}
							includeMergeCommits={includeMergeCommits}
							onGitHistoryTypeChange={setGitHistoryType}
							onGitHistoryCountChange={setGitHistoryCount}
							onGitHistorySinceDateChange={setGitHistorySinceDate}
							onGitHistoryFromTagChange={setGitHistoryFromTag}
							onGitHistoryToTagChange={setGitHistoryToTag}
							onGitHistorySinceVersionChange={setGitHistorySinceVersion}
							onIncludeMergeCommitsChange={setIncludeMergeCommits}
							baseBranch={baseBranch}
							compareBranch={compareBranch}
							onBaseBranchChange={setBaseBranch}
							onCompareBranchChange={setCompareBranch}
							onLoadCommitsPreview={handleLoadCommitsPreview}
						/>
						<ChangelogList
							sourceMode={sourceMode}
							doneTasks={doneTasks}
							selectedTaskIds={selectedTaskIds}
							onToggleTask={toggleTaskSelection}
							onSelectAll={selectAllTasks}
							onDeselectAll={deselectAllTasks}
							previewCommits={previewCommits}
							isLoadingCommits={isLoadingCommits}
							onContinue={handleContinue}
							canContinue={canContinue}
						/>
					</div>
				)}
				{step === 2 && (
					<Step2ConfigureGenerate
						sourceMode={sourceMode}
						selectedTaskIds={selectedTaskIds}
						doneTasks={doneTasks}
						previewCommits={previewCommits}
						existingChangelog={existingChangelog}
						version={version}
						versionReason={versionReason}
						date={date}
						format={format}
						audience={audience}
						emojiLevel={emojiLevel}
						customInstructions={customInstructions}
						generationProgress={generationProgress}
						generatedChangelog={generatedChangelog}
						isGenerating={isGenerating}
						error={error}
						showAdvanced={showAdvanced}
						saveSuccess={saveSuccess}
						copySuccess={copySuccess}
						canGenerate={canGenerate}
						canSave={canSave}
						onBack={handleBack}
						onVersionChange={setVersion}
						onDateChange={setDate}
						onFormatChange={setFormat}
						onAudienceChange={setAudience}
						onEmojiLevelChange={setEmojiLevel}
						onCustomInstructionsChange={setCustomInstructions}
						onShowAdvancedChange={setShowAdvanced}
						onGenerate={handleGenerate}
						onSave={handleSave}
						onCopy={handleCopy}
						onChangelogEdit={updateGeneratedChangelog}
						serverProject={serverProject}
					/>
				)}
				{step === 3 && selectedProjectId && (
					<Step3ReleaseArchive
						projectId={selectedProjectId}
						version={version}
						selectedTaskIds={selectedTaskIds}
						doneTasks={doneTasks}
						generatedChangelog={generatedChangelog}
						serverProject={serverProject}
						onDone={handleDone}
					/>
				)}
			</ModuleStage>
		</TooltipProvider>
	);
}
