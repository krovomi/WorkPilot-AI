/**
 * ArchitectureTabs — the documents open in the canvas.
 *
 * The canvas used to hold exactly one diagram, so starting a second design
 * meant destroying the first: "Nouveau diagramme" cleared what was there, and
 * the only way to keep it was to remember to export a JSON file first. A tab
 * row makes the documents independent, which is also what lets each one carry
 * its own construction history.
 *
 * Renaming is inline on double-click rather than behind a dialog — a tab you
 * cannot name is a row of "Architecture 1, 2, 3", which is the same as no
 * names at all.
 */

import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Architecture } from "../../stores/visual-to-code-store";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../ui/alert-dialog";

interface ArchitectureTabsProps {
	architectures: Architecture[];
	activeId: string | null;
	onSelect: (id: string) => void;
	onCreate: () => void;
	onRename: (id: string, name: string) => void;
	onDelete: (id: string) => void;
}

/** An architecture with nothing on it is not work; closing it asks nothing. */
function isEmpty(architecture: Architecture): boolean {
	return architecture.nodes.length === 0 && architecture.edges.length === 0;
}

export function ArchitectureTabs({
	architectures,
	activeId,
	onSelect,
	onCreate,
	onRename,
	onDelete,
}: ArchitectureTabsProps) {
	const { t } = useTranslation("visualProgramming");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draftName, setDraftName] = useState("");
	const [pendingDelete, setPendingDelete] = useState<Architecture | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (editingId) inputRef.current?.select();
	}, [editingId]);

	const startEditing = (architecture: Architecture) => {
		setEditingId(architecture.id);
		setDraftName(architecture.name);
	};

	const commitEditing = () => {
		if (editingId) onRename(editingId, draftName);
		setEditingId(null);
	};

	const requestDelete = (architecture: Architecture) => {
		if (isEmpty(architecture)) {
			onDelete(architecture.id);
			return;
		}
		setPendingDelete(architecture);
	};

	return (
		<>
			<div
				className="flex items-center gap-1 overflow-x-auto border-b bg-muted/30 px-2 py-1"
				// A horizontal tab strip is a tablist; without this, every tab
				// announces itself as an unrelated button.
				role="tablist"
				aria-label={t("architectures", "Architectures")}
			>
				{architectures.map((architecture) => {
					const active = architecture.id === activeId;
					return (
						<div
							key={architecture.id}
							className={`group flex shrink-0 items-center gap-1 rounded-t-md border-b-2 px-2.5 py-1 text-xs transition-colors ${
								active
									? "border-violet-500 bg-background font-medium text-violet-700 dark:text-violet-300"
									: "border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground"
							}`}
						>
							{editingId === architecture.id ? (
								<input
									ref={inputRef}
									value={draftName}
									onChange={(event) => setDraftName(event.target.value)}
									onBlur={commitEditing}
									onKeyDown={(event) => {
										if (event.key === "Enter") commitEditing();
										if (event.key === "Escape") setEditingId(null);
									}}
									aria-label={t("renameArchitecture", "Renommer l'architecture")}
									className="w-28 rounded border bg-background px-1 py-0.5 text-xs outline-none focus:border-primary"
								/>
							) : (
								<button
									type="button"
									role="tab"
									aria-selected={active}
									onClick={() => onSelect(architecture.id)}
									onDoubleClick={() => startEditing(architecture)}
									title={t(
										"architectureTabHint",
										"Double-cliquez pour renommer",
									)}
									className="max-w-[12rem] truncate"
								>
									{architecture.name}
								</button>
							)}
							<button
								type="button"
								onClick={() => requestDelete(architecture)}
								title={t("closeArchitecture", "Fermer l'architecture")}
								aria-label={`${t("closeArchitecture", "Fermer l'architecture")} — ${architecture.name}`}
								className="rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive focus:opacity-100 group-hover:opacity-70"
							>
								<X className="h-3 w-3" />
							</button>
						</div>
					);
				})}

				<button
					type="button"
					onClick={onCreate}
					title={t("newArchitecture", "Nouvelle architecture")}
					aria-label={t("newArchitecture", "Nouvelle architecture")}
					className="ml-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
				>
					<Plus className="h-3.5 w-3.5" />
				</button>
			</div>

			{/* Closing a tab deletes the document and its timeline; that is worth
			    one question, and only when there is something to lose. */}
			<AlertDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => !open && setPendingDelete(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("deleteArchitectureTitle", "Supprimer cette architecture ?")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("deleteArchitectureDesc", {
								defaultValue:
									"« {{name}} » et tout son historique de construction seront supprimés. Cette action est irréversible.",
								name: pendingDelete?.name ?? "",
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("cancel", "Annuler")}</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (pendingDelete) onDelete(pendingDelete.id);
								setPendingDelete(null);
							}}
						>
							{t("delete", "Supprimer")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
