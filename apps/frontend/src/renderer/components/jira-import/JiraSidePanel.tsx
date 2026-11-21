/**
 * Jira side panel: Jira issues to drag onto a Kanban column.
 * The panel itself is `WorkItemSidePanel`; this file says how a Jira issue reads.
 */
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { JiraSyncStatus, JiraWorkItem } from "../../../shared/types/integrations";
import { badgeVariants } from "../ui/badge";
import { jiraPriorityColor, jiraTypeColor } from "../work-item-import/tracker-colors";
import { useWorkItemSource } from "../work-item-import/use-work-item-source";
import { type PanelLabels, WorkItemSidePanel } from "../work-item-import/WorkItemSidePanel";

interface JiraSidePanelProps {
	readonly projectId: string;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onOpenSettings?: () => void;
}

const MAX_ISSUES = 100;

/**
 * An issue key (`proj-12` reads `PROJ-12`), or a bare number in the connected
 * project, that is not already listed.
 */
export function jiraLookupKey(query: string, items: readonly JiraWorkItem[], projectKey?: string): string | null {
	let key: string | null = null;
	if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(query)) key = query.toUpperCase();
	else if (/^\d+$/.test(query) && projectKey) key = `${projectKey}-${query}`;
	if (key === null || items.some((item) => item.id.toUpperCase() === key)) return null;
	return key;
}

export function JiraSidePanel({ projectId, open, onOpenChange, onOpenSettings }: JiraSidePanelProps) {
	const { t } = useTranslation("settings");
	const source = useWorkItemSource<JiraWorkItem, JiraSyncStatus>({
		open,
		cacheKey: `jira-workitems-cache-${projectId}`,
		checkConnection: () => globalThis.electronAPI.checkJiraConnection(projectId),
		listItems: () => globalThis.electronAPI.getJiraIssues(projectId, MAX_ISSUES),
		messages: {
			notConfigured: t("jiraImport.errorNotConfigured"),
			checkFailed: t("jiraImport.errorCheckConnectionFailed"),
			loadFailed: t("jiraImport.errorLoadIssuesFailed"),
			unknown: t("jiraImport.errorUnknown"),
		},
	});
	const status = source.status;

	const labels: PanelLabels = {
		ariaLabel: t("jiraImport.sidePanelAriaLabel"),
		search: t("jiraImport.searchPlaceholder"),
		type: t("jiraImport.typeLabel"),
		allTypes: t("jiraImport.filterTypeAll"),
		state: t("jiraImport.statusLabel"),
		allStates: t("jiraImport.allStatuses"),
		selection: (selected, total) => t("jiraImport.selectedOfTotal", { selected, total }),
		searching: t("jiraImport.searchingByKey"),
		empty: t("jiraImport.noJiraIssues"),
		emptyFiltered: t("jiraImport.emptySubtitle"),
		dragHint: t("jiraImport.dragHint"),
		selected: (count) => t("jiraImport.selectedItems", { count }),
		more: (count) => t("jiraImport.moreItems", { count }),
		configure: t("jiraImport.configureButton"),
		resize: t("jiraImport.resize"),
	};

	return (
		<WorkItemSidePanel<JiraWorkItem, string>
			kind="jira"
			projectId={projectId}
			open={open}
			onOpenChange={onOpenChange}
			onOpenSettings={onOpenSettings}
			source={source}
			title={
				status?.projectKey
					? t("jiraImport.titleWithProject", { project: status.projectKey })
					: t("jiraImport.title")
			}
			info={
				status?.projectKey && (
					<p>
						<strong>{t("jiraImport.projectLabel")}</strong> {status.projectKey}
						{status.instanceUrl && (
							<span className="ml-2 text-xs text-muted-foreground">({status.instanceUrl})</span>
						)}
					</p>
				)
			}
			labels={labels}
			lookupKey={(query, items) => jiraLookupKey(query, items, status?.projectKey)}
			fetchItem={(key) => globalThis.electronAPI.getJiraIssue(projectId, key)}
			formatId={(item) => item.id}
			typeColor={jiraTypeColor}
			renderBadges={(item) =>
				item.priority && (
					<span className={cn(badgeVariants({ variant: "outline" }), jiraPriorityColor(item.priority))}>
						{item.priority}
					</span>
				)
			}
			renderDetails={(item) =>
				item.assignedTo && (
					<span className="block text-xs text-muted-foreground mt-1">
						{t("jiraImport.assignee", { name: item.assignedTo })}
					</span>
				)
			}
		/>
	);
}
