/**
 * Azure DevOps side panel: work items to drag onto a Kanban column.
 * The panel itself is `WorkItemSidePanel`; this file says how a work item reads.
 */
import { FolderGit2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { AzureDevOpsSyncStatus, AzureDevOpsWorkItem } from "../../../shared/types/integrations";
import { badgeVariants } from "../ui/badge";
import { azureTypeColor } from "../work-item-import/tracker-colors";
import { useWorkItemSource } from "../work-item-import/use-work-item-source";
import { type PanelLabels, WorkItemSidePanel } from "../work-item-import/WorkItemSidePanel";

interface AzureDevOpsSidePanelProps {
	readonly projectId: string;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onOpenSettings?: () => void;
}

/** Every work item type (custom ones included), up to this many. */
const MAX_WORK_ITEMS = 1000;

/** A work item number that is not already listed. */
export function azureLookupKey(query: string, items: readonly AzureDevOpsWorkItem[]): number | null {
	if (!/^\d+$/.test(query)) return null;
	const id = Number(query);
	return items.some((item) => item.id === id) ? null : id;
}

export function AzureDevOpsSidePanel({ projectId, open, onOpenChange, onOpenSettings }: AzureDevOpsSidePanelProps) {
	const { t } = useTranslation("settings");
	const source = useWorkItemSource<AzureDevOpsWorkItem, AzureDevOpsSyncStatus>({
		open,
		cacheKey: `azure-devops-workitems-cache-${projectId}`,
		checkConnection: () => globalThis.electronAPI.checkAzureDevOpsConnection(projectId),
		listItems: () =>
			globalThis.electronAPI.getAzureDevOpsWorkItems(projectId, undefined, undefined, MAX_WORK_ITEMS),
		messages: {
			notConfigured: t("azureDevOpsImport.errorNotConfigured"),
			checkFailed: t("azureDevOpsImport.errorCheckConnectionFailed"),
			loadFailed: t("azureDevOpsImport.errorLoadWorkItemsFailed"),
			unknown: t("azureDevOpsImport.errorUnknown"),
		},
	});
	const status = source.status;
	const connected = !!status?.connected;

	// The repository name for the title, read once per project when connected;
	// without it the title names the Azure DevOps project.
	const [repository, setRepository] = useState<{ projectId: string; name: string | null } | null>(null);
	const known = repository?.projectId === projectId;
	useEffect(() => {
		if (!connected || known) return;
		let current = true;
		globalThis.electronAPI
			.detectAzureDevOpsRepository(projectId)
			.then((result) => {
				if (current && result.success) setRepository({ projectId, name: result.data?.repository ?? null });
			})
			.catch(() => {
				// Best-effort: the title keeps the project name.
			});
		return () => {
			current = false;
		};
	}, [connected, known, projectId]);

	const titleContext = (repository?.projectId === projectId ? repository.name : null) ?? status?.projectName;
	const listedRepository = source.items[0]?.repository;

	const labels: PanelLabels = {
		ariaLabel: t("azureDevOpsImport.sidePanelAriaLabel"),
		search: t("azureDevOpsImport.searchPlaceholder"),
		type: t("azureDevOpsImport.filterTypeLabel"),
		allTypes: t("azureDevOpsImport.filterTypeAll"),
		state: t("azureDevOpsImport.filterStateLabel"),
		allStates: t("azureDevOpsImport.filterStateAll"),
		selection: (selected, total) => t("azureDevOpsImport.selectionCount", { selected, total }),
		searching: t("azureDevOpsImport.searchingById"),
		empty: t("azureDevOpsImport.emptyTitle"),
		emptyFiltered: t("azureDevOpsImport.emptySubtitle"),
		dragHint: t("azureDevOpsImport.dragInstructions"),
		selected: (count) => t("azureDevOpsImport.selectedItems", { count }),
		more: (count) => t("azureDevOpsImport.moreItems", { count }),
		configure: t("azureDevOpsImport.configureButton"),
		resize: t("azureDevOpsImport.resizeHandleAriaLabel"),
	};

	return (
		<WorkItemSidePanel<AzureDevOpsWorkItem, number>
			kind="azure-devops"
			projectId={projectId}
			open={open}
			onOpenChange={onOpenChange}
			onOpenSettings={onOpenSettings}
			source={source}
			title={
				titleContext
					? t("azureDevOpsImport.titleWithRepository", { repository: titleContext })
					: t("azureDevOpsImport.title")
			}
			info={
				status?.projectName && (
					<>
						<p>
							<strong>{t("azureDevOpsImport.projectLabel")}</strong> {status.projectName}
						</p>
						{listedRepository && (
							<p className="mt-1">
								<strong>{t("azureDevOpsImport.repositoryLabel")}</strong> {listedRepository}
							</p>
						)}
					</>
				)
			}
			labels={labels}
			lookupKey={azureLookupKey}
			fetchItem={(id) => globalThis.electronAPI.getAzureDevOpsWorkItem(projectId, id)}
			formatId={(item) => `#${item.id}`}
			typeColor={azureTypeColor}
			renderBadges={(item) => (
				<>
					{item.priority !== undefined && (
						<span className={badgeVariants({ variant: "outline" })}>
							{t("azureDevOpsImport.priorityBadge", { priority: item.priority })}
						</span>
					)}
					{item.repository && (
						<span className={cn(badgeVariants({ variant: "secondary" }), "gap-1")}>
							<FolderGit2 className="h-3 w-3" />
							{item.repository}
						</span>
					)}
				</>
			)}
		/>
	);
}
