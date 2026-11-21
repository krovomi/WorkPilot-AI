/**
 * Import Confirm Dialog
 * Shows a confirmation dialog when importing work items (Azure DevOps / Jira)
 * Allows the user to enable "Require human review before coding" for imported tasks.
 */

import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskStatus } from "../../../shared/types";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import type { PanelKind } from "../work-item-import/drag";
import { azureTypeColor, jiraTypeColor } from "../work-item-import/tracker-colors";

/**
 * Common work item shape accepted by the import dialog.
 * Both AzureDevOpsWorkItem and JiraWorkItem satisfy this interface.
 */
export interface ImportableWorkItem {
	id: string | number;
	title: string;
	description?: string;
	state: string;
	workItemType: string;
	tags: string[];
}

interface ImportConfirmDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly workItems: ImportableWorkItem[];
	readonly targetColumn: TaskStatus | null;
	readonly isImporting: boolean;
	readonly onConfirm: (requireReviewBeforeCoding: boolean) => void;
	/** Called when the user explicitly cancels (closes the side panel too) */
	readonly onCancel?: () => void;
	/** The tracker the items come from. */
	readonly source: PanelKind | null;
}

export function ImportConfirmDialog({
	open,
	onOpenChange,
	workItems,
	targetColumn,
	isImporting,
	onConfirm,
	onCancel,
	source,
}: ImportConfirmDialogProps) {
	const { t } = useTranslation(["settings", "tasks", "common"]);
	const [requireReviewBeforeCoding, setRequireReviewBeforeCoding] =
		useState(false);

	// Jira words its own dialog ("issues"); its keys read as Jira keys, Azure DevOps ids as numbers.
	const section = source === "jira" ? "jiraImport" : "azureDevOpsImport";
	const typeColor = source === "jira" ? jiraTypeColor : azureTypeColor;

	return (
		<AlertDialog
			open={open}
			onOpenChange={(newOpen) => {
				if (!isImporting) {
					onOpenChange(newOpen);
				}
			}}
		>
			<AlertDialogContent className="sm:max-w-[550px]">
				<AlertDialogHeader>
					<AlertDialogTitle className="flex items-center gap-2">
						<Download className="h-5 w-5" />
						{t(`settings:${section}.importConfirmTitle`, {
							count: workItems.length,
						})}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{t(`settings:${section}.importConfirmDescription`, {
							column: targetColumn ? t(`tasks:status.${targetColumn}`) : "",
						})}
					</AlertDialogDescription>
				</AlertDialogHeader>

				{/* Work Items Preview */}
				<ScrollArea className="max-h-48 rounded-md border border-border p-2">
					<div className="space-y-1">
						{workItems.map((item) => (
							<div
								key={item.id}
								className="flex items-center gap-2 text-sm py-1.5 px-2 rounded hover:bg-muted/50"
							>
								<span className="font-mono text-xs text-muted-foreground shrink-0">
									{typeof item.id === "number" ? `#${item.id}` : item.id}
								</span>
								<Badge
									variant="outline"
									className={`${typeColor(item.workItemType)} shrink-0 text-xs`}
								>
									{item.workItemType}
								</Badge>
								<span className="truncate">{item.title}</span>
							</div>
						))}
					</div>
				</ScrollArea>

				{/* Review Requirement Toggle */}
				<div className="flex items-start gap-3 p-4 rounded-lg border border-border bg-muted/30">
					<Checkbox
						id="import-require-review"
						checked={requireReviewBeforeCoding}
						onCheckedChange={(checked) =>
							setRequireReviewBeforeCoding(checked === true)
						}
						disabled={isImporting}
						className="mt-0.5"
					/>
					<div className="flex-1 space-y-1">
						<Label
							htmlFor="import-require-review"
							className="text-sm font-medium text-foreground cursor-pointer"
						>
							{t("tasks:form.requireReviewLabel")}
						</Label>
						<p className="text-xs text-muted-foreground">
							{t("tasks:form.requireReviewDescription")}
						</p>
					</div>
				</div>

				<AlertDialogFooter>
					<Button
						variant="outline"
						onClick={() => {
							onOpenChange(false);
							onCancel?.();
						}}
						disabled={isImporting}
					>
						{t("common:buttons.cancel")}
					</Button>
					<Button
						onClick={() => onConfirm(requireReviewBeforeCoding)}
						disabled={isImporting}
					>
						{isImporting ? (
							<>
								<Loader2 className="h-4 w-4 mr-2 animate-spin" />
								{t(`settings:${section}.importing`)}
							</>
						) : (
							<>
								<Download className="h-4 w-4 mr-2" />
								{t(`settings:${section}.importConfirmButton`, {
									count: workItems.length,
								})}
							</>
						)}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
