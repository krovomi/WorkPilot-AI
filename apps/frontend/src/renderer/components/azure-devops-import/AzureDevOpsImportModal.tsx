/**
 * Azure DevOps import dialog (project settings): pick work items and import
 * them as tasks. The list, its search, filters and selection are the ones of
 * the import side panel; the list read for a project is kept five minutes for
 * both.
 */
import { Download, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AzureDevOpsImportResult, AzureDevOpsSyncStatus, AzureDevOpsWorkItem } from "../../../shared/types";
import { badgeVariants } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Label } from "../ui/label";
import { azureTypeColor } from "../work-item-import/tracker-colors";
import { useWorkItemSource } from "../work-item-import/use-work-item-source";
import { PickerFilters, PickerList, PickerRow, useWorkItemPicker } from "../work-item-import/work-item-picker";
import type { AzureDevOpsImportModalProps } from "./types";

const MAX_WORK_ITEMS = 1000;
/** The success message stays this long before the dialog's owner moves on. */
export const IMPORT_DONE_DELAY_MS = 1500;

export function AzureDevOpsImportModal({ projectId, open, onOpenChange, onImportComplete }: AzureDevOpsImportModalProps) {
	const { t } = useTranslation(["settings", "tasks"]);
	const source = useWorkItemSource<AzureDevOpsWorkItem, AzureDevOpsSyncStatus>({
		open,
		cacheKey: `azure-devops-workitems-cache-${projectId}`,
		checkConnection: () => globalThis.electronAPI.checkAzureDevOpsConnection(projectId),
		listItems: () =>
			globalThis.electronAPI.getAzureDevOpsWorkItems(projectId, undefined, undefined, MAX_WORK_ITEMS),
		messages: {
			notConfigured: t("settings:azureDevOpsImport.errorNotConfigured"),
			checkFailed: t("settings:azureDevOpsImport.errorCheckConnectionFailed"),
			loadFailed: t("settings:azureDevOpsImport.errorLoadWorkItemsFailed"),
			unknown: t("settings:azureDevOpsImport.errorUnknown"),
		},
	});
	const picker = useWorkItemPicker(source.items);
	const [requireReview, setRequireReview] = useState(false);
	const [importing, setImporting] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);
	const [imported, setImported] = useState<AzureDevOpsImportResult | null>(null);
	const doneTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(doneTimer.current), []);

	const connected = !!source.status?.connected;
	const showPicker = connected && !imported;
	const error = importError ?? source.error;

	const handleImport = async () => {
		setImporting(true);
		setImportError(null);
		try {
			const result = await globalThis.electronAPI.importAzureDevOpsWorkItems(
				projectId,
				[...picker.selectedIds],
				requireReview ? { requireReviewBeforeCoding: true } : undefined,
			);
			if (result.success && result.data?.success) {
				setImported(result.data);
				if (onImportComplete) doneTimer.current = setTimeout(onImportComplete, IMPORT_DONE_DELAY_MS);
			} else {
				// A refused import, or one the backend ran without importing anything, says why.
				setImportError(
					result.error || result.data?.errors?.[0] || t("settings:azureDevOpsImport.errorImportFailed"),
				);
			}
		} catch (err) {
			setImportError(err instanceof Error ? err.message : t("settings:azureDevOpsImport.errorUnknown"));
		} finally {
			setImporting(false);
		}
	};

	const handleOpenChange = (next: boolean) => {
		if (!next) {
			clearTimeout(doneTimer.current);
			picker.reset();
			setImportError(null);
			setImported(null);
		}
		onOpenChange(next);
	};

	const summary = imported
		? [
				t("settings:azureDevOpsImport.successCount", { count: imported.imported }),
				imported.failed > 0 ? t("settings:azureDevOpsImport.successFailedSuffix", { count: imported.failed }) : "",
			]
				.filter(Boolean)
				.join(" ")
		: "";

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-[900px] md:max-w-[1000px] h-[85vh] max-h-[85vh] flex flex-col w-full">
				<DialogHeader className="shrink-0">
					<DialogTitle className="flex items-center gap-2 text-foreground">
						<Download className="h-5 w-5" />
						{t("settings:azureDevOpsImport.title")}
					</DialogTitle>
					<DialogDescription>{t("settings:azureDevOpsImport.description")}</DialogDescription>
				</DialogHeader>

				<div className="flex-1 min-h-0 flex flex-col gap-4 overflow-hidden">
					{imported && (
						<div className="bg-success/10 border border-success/20 rounded-md p-4 shrink-0" role="status">
							<h4 className="font-semibold text-success mb-2">{t("settings:azureDevOpsImport.successTitle")}</h4>
							<p className="text-sm text-foreground/70">{summary}</p>
						</div>
					)}

					{error && (
						<div className="bg-destructive/10 border border-destructive/20 rounded-md p-4 shrink-0" role="alert">
							<p className="text-sm text-destructive">{error}</p>
						</div>
					)}

					{showPicker && (
						<>
							{source.status?.projectName && (
								<div className="text-sm text-foreground/70 bg-muted/50 p-3 rounded-md shrink-0">
									<strong>{t("settings:azureDevOpsImport.projectLabel")}</strong> {source.status.projectName}
								</div>
							)}

							<div className="space-y-4 shrink-0">
								<PickerFilters
									idPrefix="azure-devops-modal"
									picker={picker}
									labels={{
										search: t("settings:azureDevOpsImport.searchPlaceholder"),
										type: t("settings:azureDevOpsImport.filterTypeLabel"),
										allTypes: t("settings:azureDevOpsImport.filterTypeAll"),
										state: t("settings:azureDevOpsImport.filterStateLabel"),
										allStates: t("settings:azureDevOpsImport.filterStateAll"),
										selection: (selected, total) =>
											t("settings:azureDevOpsImport.selectionCount", { selected, total }),
									}}
									loading={source.loading}
									refreshing={source.refreshing}
									onRefresh={() => {
										picker.reset();
										void source.refresh();
									}}
								/>
							</div>

							<div className="flex-1 min-h-0 overflow-y-auto border-t border-border px-3 py-2">
								<PickerList
									picker={picker}
									loading={source.loading}
									labels={{
										empty: t("settings:azureDevOpsImport.emptyTitle"),
										emptyFiltered: t("settings:azureDevOpsImport.emptySubtitle"),
									}}
									renderRow={(item) => (
										<PickerRow
											item={item}
											displayId={`#${item.id}`}
											selected={picker.selectedIds.has(item.id)}
											onToggle={() => picker.toggle(item.id)}
											typeColor={azureTypeColor}
											badges={
												item.priority !== undefined && (
													<span className={badgeVariants({ variant: "outline" })}>
														{t("settings:azureDevOpsImport.priorityBadge", { priority: item.priority })}
													</span>
												)
											}
										/>
									)}
								/>
							</div>

							<div className="flex items-start gap-3 p-4 rounded-lg border border-border bg-muted/30 shrink-0">
								<Checkbox
									id="modal-require-review"
									checked={requireReview}
									onCheckedChange={(checked) => setRequireReview(checked === true)}
									disabled={importing}
									className="mt-0.5"
								/>
								<div className="flex-1 space-y-1">
									<Label
										htmlFor="modal-require-review"
										className="text-sm font-medium text-foreground cursor-pointer"
									>
										{t("tasks:form.requireReviewLabel")}
									</Label>
									<p className="text-xs text-muted-foreground">{t("tasks:form.requireReviewDescription")}</p>
								</div>
							</div>
						</>
					)}
				</div>

				<DialogFooter className="shrink-0">
					<Button variant="outline" onClick={() => handleOpenChange(false)}>
						{imported ? t("settings:azureDevOpsImport.done") : t("settings:azureDevOpsImport.cancel")}
					</Button>
					{showPicker && (
						<Button onClick={handleImport} disabled={picker.selectedIds.size === 0 || importing}>
							{importing ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<Download className="mr-2 h-4 w-4" />
							)}
							{importing
								? t("settings:azureDevOpsImport.importing")
								: t("settings:azureDevOpsImport.importButton", { count: picker.selectedIds.size })}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
