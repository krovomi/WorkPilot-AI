import { Brain, FolderTree, History } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useServerViewLive } from "../../hooks/useServerViewLive";
import { loadRecentMemories, useContextStore } from "../../stores/context-store";
import { ModuleHeader, ModuleStage, Tabs } from "../charter";
import { useMemorySearch, useProjectContext, useRefreshIndex } from "./hooks";
import { LifecycleTab } from "./lifecycle/LifecycleTab";
import { MemoriesTab } from "./MemoriesTab";
import { ProjectIndexTab } from "./ProjectIndexTab";
import type { ContextProps } from "./types";

export function Context(props: ContextProps) {
	const { projectId } = props;
	const { t } = useTranslation(["context", "navigation"]);
	// A server project's index and memories show a teammate's change at once.
	useServerViewLive(projectId, "context");

	const {
		projectIndex,
		indexLoading,
		indexError,
		memoryStatus,
		memoryState,
		recentMemories,
		memoriesLoading,
		searchResults,
		searchLoading,
	} = useContextStore();

	const [activeTab, setActiveTab] = useState<"index" | "memories" | "lifecycle">(
		"index",
	);

	// Custom hooks
	useProjectContext(projectId);
	const handleRefreshIndex = useRefreshIndex(projectId);
	const handleSearch = useMemorySearch(projectId);

	return (
		<ModuleStage data-testid="context-view">
			<ModuleHeader
				kicker={t("navigation:groups.explore")}
				title={t("navigation:items.context")}
				description={
					activeTab === "index"
						? t("context:projectIndex.description")
						: activeTab === "memories"
							? t("context:memories.description")
							: t("context:lifecycle.description")
				}
				icon={
					activeTab === "index"
						? FolderTree
						: activeTab === "memories"
							? Brain
							: History
				}
				tone="blue"
			/>
			<Tabs
				tabs={[
					{
						id: "index",
						label: t("context:tabs.projectIndex"),
						icon: FolderTree,
					},
					{ id: "memories", label: t("context:tabs.memories"), icon: Brain },
					{ id: "lifecycle", label: t("context:tabs.lifecycle"), icon: History },
				]}
				value={activeTab}
				onChange={setActiveTab}
				label={t("navigation:items.context")}
			/>
			<div className="relative z-[1] min-h-0 flex-1 overflow-hidden">
				{activeTab === "index" ? (
					<ProjectIndexTab
						projectIndex={projectIndex}
						indexLoading={indexLoading}
						indexError={indexError}
						onRefresh={handleRefreshIndex}
					/>
				) : activeTab === "lifecycle" ? (
					<LifecycleTab
						projectId={projectId}
						onServer={memoryStatus?.onServer === true}
					/>
				) : (
					<MemoriesTab
						projectId={projectId}
						onMemoryChanged={() => loadRecentMemories(projectId)}
						memoryStatus={memoryStatus}
						memoryState={memoryState}
						recentMemories={recentMemories}
						memoriesLoading={memoriesLoading}
						searchResults={searchResults}
						searchLoading={searchLoading}
						onSearch={handleSearch}
					/>
				)}
			</div>
		</ModuleStage>
	);
}
