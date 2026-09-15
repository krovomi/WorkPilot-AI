/**
 * ArchitectureHistoryDock — the construction steps of one architecture.
 *
 * Undo/redo answers "take back what I just did" and dies with the session.
 * This answers the other question: what did this architecture look like on
 * Tuesday, and can I have that back? So the rows are steps rather than edits —
 * a block added, removed, renamed, a connection drawn — and each one can be
 * put back on the canvas.
 *
 * Restoring **appends**: the steps taken after the one restored stay exactly
 * where they are. Going back to look at Tuesday must not be the act that
 * deletes Wednesday.
 */

import {
	Check,
	History,
	Loader2,
	RotateCcw,
	Star,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	ArchitectureVersionMeta,
	ChangeSummary,
} from "../../../shared/types/visual-to-code-history";
import { Button } from "../ui/button";

interface ArchitectureHistoryDockProps {
	open: boolean;
	architectureName: string;
	versions: ArchitectureVersionMeta[];
	loading: boolean;
	error: string | null;
	onClose: () => void;
	onRestore: (versionId: string) => void;
	onLabel: (versionId: string, label: string | null) => void;
	onDelete: (versionId: string) => void;
}

/**
 * A date the way a person reads it, in the language they chose.
 *
 * `Intl.RelativeTimeFormat` rather than the repo's `formatRelativeTime`, whose
 * output ("just now", "5m ago") is hardcoded English — which is a bug in a
 * product shipped in French and English, and one this panel would repeat sixty
 * rows at a time.
 */
function relativeTime(iso: string, locale: string): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";
	const seconds = Math.round((then - Date.now()) / 1000);
	const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	const units: [Intl.RelativeTimeFormatUnit, number][] = [
		["second", 60],
		["minute", 60],
		["hour", 24],
		["day", 7],
		["week", 4.35],
		["month", 12],
	];
	let value = seconds;
	for (const [unit, size] of units) {
		if (Math.abs(value) < size) return format.format(value, unit);
		value = Math.round(value / size);
	}
	return format.format(value, "year");
}

/** The one-line "what happened", built from counts the capture already made. */
function useChangeLine(): (summary: ChangeSummary | null) => string {
	const { t } = useTranslation("visualProgramming");
	return (summary) => {
		if (!summary) return t("historyInitial", "État initial");
		const parts: string[] = [];
		if (summary.addedNodes > 0) {
			parts.push(
				t("historyAddedBlocks", {
					defaultValue: "+{{count}} bloc",
					defaultValue_other: "+{{count}} blocs",
					count: summary.addedNodes,
				}),
			);
		}
		if (summary.removedNodes > 0) {
			parts.push(
				t("historyRemovedBlocks", {
					defaultValue: "−{{count}} bloc",
					defaultValue_other: "−{{count}} blocs",
					count: summary.removedNodes,
				}),
			);
		}
		if (summary.changedNodes > 0) {
			parts.push(
				t("historyChangedBlocks", {
					defaultValue: "{{count}} modifié",
					defaultValue_other: "{{count}} modifiés",
					count: summary.changedNodes,
				}),
			);
		}
		const edges = summary.addedEdges + summary.removedEdges;
		if (edges > 0) {
			parts.push(
				t("historyEdges", {
					defaultValue: "{{count}} connexion",
					defaultValue_other: "{{count}} connexions",
					count: edges,
				}),
			);
		}
		return parts.join(" · ") || t("historyNoChange", "Aucun changement");
	};
}

export function ArchitectureHistoryDock({
	open,
	architectureName,
	versions,
	loading,
	error,
	onClose,
	onRestore,
	onLabel,
	onDelete,
}: ArchitectureHistoryDockProps) {
	const { t, i18n } = useTranslation("visualProgramming");
	const changeLine = useChangeLine();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draftLabel, setDraftLabel] = useState("");
	const labelInputRef = useRef<HTMLInputElement>(null);

	// The field replaces a button the user just pressed, so it takes the focus
	// that button had. Done here rather than with `autoFocus`, which fires on
	// mount and would steal focus every time the dock opens.
	useEffect(() => {
		if (editingId) labelInputRef.current?.select();
	}, [editingId]);

	if (!open) return null;

	// Newest first: the step you want is almost always a recent one, and a
	// timeline that opens on the oldest row asks everyone to scroll.
	const rows = [...versions].reverse();

	const commitLabel = (versionId: string) => {
		onLabel(versionId, draftLabel.trim() || null);
		setEditingId(null);
	};

	return (
		<aside
			className="flex w-[22rem] shrink-0 flex-col border-l bg-background"
			aria-label={t("historyTitle", "Historique de construction")}
		>
			<div className="flex items-center gap-2 border-b px-3 py-2">
				<History className="h-4 w-4 shrink-0 text-violet-500" />
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-medium">
						{t("historyTitle", "Historique de construction")}
					</p>
					<p className="truncate text-xs text-muted-foreground">
						{architectureName}
					</p>
				</div>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 w-7 shrink-0 p-0"
					onClick={onClose}
					title={t("close", "Fermer")}
					aria-label={t("close", "Fermer")}
				>
					<X className="h-3.5 w-3.5" />
				</Button>
			</div>

			{error && (
				<div className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">
					{error}
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-y-auto p-1.5">
				{loading && versions.length === 0 && (
					<div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
						{t("historyLoading", "Lecture de l'historique…")}
					</div>
				)}

				{!loading && rows.length === 0 && (
					<p className="px-2 py-6 text-center text-xs text-muted-foreground">
						{t(
							"historyEmpty",
							"Aucune étape enregistrée. Ajoutez ou reliez un bloc : chaque changement de structure crée un point de retour.",
						)}
					</p>
				)}

				{rows.map((version, index) => (
					<div
						key={version.id}
						className="group rounded-md px-2 py-2 transition-colors hover:bg-muted/60"
					>
						<div className="flex items-start gap-2">
							{/* The newest row is where the canvas actually is. */}
							<span
								className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
									index === 0 ? "bg-violet-500" : "bg-border"
								}`}
								aria-hidden="true"
							/>
							<div className="min-w-0 flex-1">
								{editingId === version.id ? (
									<input
										ref={labelInputRef}
										value={draftLabel}
										onChange={(event) => setDraftLabel(event.target.value)}
										onBlur={() => commitLabel(version.id)}
										onKeyDown={(event) => {
											if (event.key === "Enter") commitLabel(version.id);
											if (event.key === "Escape") setEditingId(null);
										}}
										placeholder={t("historyLabelPlaceholder", "Nom de l'étape")}
										aria-label={t("historyLabel", "Nommer cette étape")}
										className="w-full rounded border bg-background px-1.5 py-0.5 text-xs outline-none focus:border-primary"
									/>
								) : (
									<p className="truncate text-xs font-medium">
										{version.label ?? changeLine(version.summary)}
									</p>
								)}
								<p className="truncate text-[11px] text-muted-foreground">
									{relativeTime(version.createdAt, i18n.language)}
									{" · "}
									{t("historyCounts", {
										defaultValue: "{{nodes}} blocs, {{edges}} connexions",
										nodes: version.nodeCount,
										edges: version.edgeCount,
									})}
								</p>
								{/* A named step still has to say what it was, or naming it
								    costs the information it replaced. */}
								{version.label && (
									<p className="truncate text-[11px] text-muted-foreground/80">
										{changeLine(version.summary)}
									</p>
								)}
								{version.restoredFrom && (
									<p className="truncate text-[11px] text-violet-600 dark:text-violet-400">
										{t("historyRestoredMark", "Retour à une étape antérieure")}
									</p>
								)}
							</div>
						</div>

						<div className="mt-1.5 flex gap-1 pl-4 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
							<Button
								size="sm"
								variant="outline"
								className="h-6 gap-1 px-1.5 text-[11px]"
								onClick={() => onRestore(version.id)}
								title={t("historyRestoreHint", {
									defaultValue:
										"Remet cette étape sur le canvas. Les étapes suivantes sont conservées.",
								})}
							>
								<RotateCcw className="h-3 w-3" />
								{t("historyRestore", "Restaurer")}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="h-6 w-6 p-0"
								onClick={() => {
									if (version.pinned) {
										onLabel(version.id, null);
										return;
									}
									setDraftLabel(version.label ?? "");
									setEditingId(version.id);
								}}
								title={
									version.pinned
										? t("historyUnpin", "Retirer le nom (l'étape redevient temporaire)")
										: t("historyPin", "Nommer cette étape pour la conserver")
								}
								aria-label={
									version.pinned
										? t("historyUnpin", "Retirer le nom (l'étape redevient temporaire)")
										: t("historyPin", "Nommer cette étape pour la conserver")
								}
							>
								{version.pinned ? (
									<Star className="h-3 w-3 fill-amber-400 text-amber-400" />
								) : (
									<Star className="h-3 w-3" />
								)}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="h-6 w-6 p-0 hover:text-destructive"
								onClick={() => onDelete(version.id)}
								title={t("historyDelete", "Supprimer cette étape")}
								aria-label={t("historyDelete", "Supprimer cette étape")}
							>
								<Trash2 className="h-3 w-3" />
							</Button>
						</div>
					</div>
				))}
			</div>

			<p className="shrink-0 border-t px-3 py-2 text-[11px] leading-snug text-muted-foreground">
				<Check className="mr-1 inline h-3 w-3" />
				{t(
					"historyFootnote",
					"Les étapes nommées sont conservées indéfiniment ; les autres au-delà des 60 dernières sont effacées.",
				)}
			</p>
		</aside>
	);
}
