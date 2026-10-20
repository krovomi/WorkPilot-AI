/**
 * The translation editor: namespaces on the left, their keys on the right.
 *
 * Three decisions shape it.
 *
 * **A namespace at a time.** A key belongs to one namespace file per locale,
 * and that is also the unit a translator works in. Loading all 101 at once
 * would be a table nobody can find anything in and a save that rewrites the
 * whole directory.
 *
 * **Nothing is written until Save.** Every edit goes into a draft, the footer
 * counts it, and Discard puts everything back. That is what makes a delete
 * safe to do with one click: the row stays on screen, struck through, with the
 * way back next to it.
 *
 * **The rows are capped.** `common` holds 969 keys and rendering two editable
 * cells for each is a page that janks on every keystroke. The cap is visible,
 * raises on demand, and the search is right above it.
 */

import {
	AlertTriangle,
	ArrowLeftRight,
	Check,
	Loader2,
	Pencil,
	Plus,
	RotateCcw,
	Save,
	Search,
	Trash2,
	Undo2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useI18nEditorStore } from "../../../stores/i18n-editor-store";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { AddKeyDialog } from "./AddKeyDialog";
import { EntryCell } from "./EntryCell";
import { NamespaceList } from "./NamespaceList";
import {
	applyDraft,
	countChanges,
	filterRows,
	keyError,
	placeholdersOf,
	type RowFilter,
} from "./drafts";

const PAGE = 150;

export function TranslationEditor() {
	const { t } = useTranslation("phase35");
	const {
		phase,
		error,
		stale,
		locales,
		namespaces,
		selectedNamespace,
		view,
		draft,
		referenceLocale,
		lastSave,
		selectNamespace,
		setValue,
		revertValue,
		addKey,
		deleteKey,
		restoreKey,
		renameKey,
		discard,
		save,
		reloadKeepingDraft,
	} = useI18nEditorStore();

	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<RowFilter>("all");
	const [limit, setLimit] = useState(PAGE);
	const [adding, setAdding] = useState(false);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");

	const busy = phase === "saving" || phase === "loadingNamespace";
	const changes = countChanges(draft);

	const rows = useMemo(
		() =>
			view ? applyDraft(view.entries, draft, locales, referenceLocale) : [],
		[view, draft, locales, referenceLocale],
	);

	// Deleted keys are kept on screen rather than filtered away: a delete you
	// cannot see is a delete you cannot take back without losing everything else.
	const deletedRows = useMemo(() => {
		if (!view) return [];
		const marked = new Set(draft.deletes);
		return view.entries.filter((e) => marked.has(e.key));
	}, [view, draft.deletes]);

	const counts = useMemo(
		() => ({
			all: rows.length,
			missing: filterRows(rows, { query: "", filter: "missing", locales }).length,
			placeholder: filterRows(rows, { query: "", filter: "placeholder", locales })
				.length,
			mismatch: filterRows(rows, { query: "", filter: "mismatch", locales }).length,
		}),
		[rows, locales],
	);

	const visible = useMemo(
		() => filterRows(rows, { query, filter, locales }),
		[rows, query, filter, locales],
	);

	useEffect(() => {
		setLimit(PAGE);
	}, []);

	// Ctrl/Cmd+S is what anyone editing a file reaches for. Without it the
	// browser's own save dialog opens over the app, which is worse than nothing.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				if (changes > 0 && !busy) void save();
			}
		};
		globalThis.addEventListener("keydown", onKey);
		return () => globalThis.removeEventListener("keydown", onKey);
	}, [changes, busy, save]);

	const existingKeys = useMemo(
		() => [...rows.map((r) => r.key), ...deletedRows.map((e) => e.key)],
		[rows, deletedRows],
	);

	const commitRename = (originalKey: string) => {
		const next = renameDraft.trim();
		setRenaming(null);
		if (!next || keyError(next)) return;
		if (next !== originalKey && existingKeys.includes(next)) return;
		renameKey(originalKey, next);
	};

	return (
		<div className="flex h-[32rem] min-h-0 overflow-hidden rounded-lg border">
			<aside className="w-56 shrink-0 border-r bg-muted/20">
				<NamespaceList
					namespaces={namespaces}
					locales={locales}
					selected={selectedNamespace}
					onSelect={(ns) => {
						setQuery("");
						setFilter("all");
						setLimit(PAGE);
						void selectNamespace(ns);
					}}
					disabled={phase === "saving"}
				/>
			</aside>

			<section className="flex min-w-0 flex-1 flex-col">
				{selectedNamespace === null ? (
					<div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
						{t("i18nEditor.pickNamespace")}
					</div>
				) : (
					<>
						<header className="flex flex-wrap items-center gap-2 border-b p-2">
							<div className="relative min-w-40 flex-1">
								<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
								<input
									value={query}
									onChange={(e) => {
										setQuery(e.target.value);
										setLimit(PAGE);
									}}
									placeholder={t("i18nEditor.searchKeys")}
									aria-label={t("i18nEditor.searchKeys")}
									className="w-full rounded border bg-background py-1.5 pl-7 pr-2 text-xs"
								/>
							</div>
							<div className="flex gap-1">
								{(["all", "missing", "placeholder", "mismatch"] as const).map(
									(value) => (
										<Button
											key={value}
											size="sm"
											variant={filter === value ? "secondary" : "ghost"}
											className="h-7 px-2 text-[11px]"
											onClick={() => {
												setFilter(value);
												setLimit(PAGE);
											}}
											// A filter that can only ever show nothing is noise.
											disabled={value !== "all" && counts[value] === 0}
										>
											{t(`i18nEditor.filter.${value}`)}
											<span className="ml-1 tabular-nums opacity-60">
												{counts[value]}
											</span>
										</Button>
									),
								)}
							</div>
							<Button
								size="sm"
								variant="outline"
								className="h-7 px-2 text-[11px]"
								onClick={() => setAdding(true)}
								disabled={busy}
							>
								<Plus className="mr-1 h-3 w-3" />
								{t("i18nEditor.addKey")}
							</Button>
						</header>

						{stale && (
							<div className="flex items-center gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs">
								<AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
								<span className="flex-1">{t("i18nEditor.staleNotice")}</span>
								<Button
									size="sm"
									variant="outline"
									className="h-6 px-2 text-[11px]"
									onClick={() => void reloadKeepingDraft()}
								>
									<RotateCcw className="mr-1 h-3 w-3" />
									{t("i18nEditor.reloadKeepingEdits")}
								</Button>
							</div>
						)}
						{error && !stale && (
							<p className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">
								{error}
							</p>
						)}

						<div className="min-h-0 flex-1 overflow-auto">
							{phase === "loadingNamespace" ? (
								<div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
									<Loader2 className="h-4 w-4 animate-spin" />
									{t("common.loading")}
								</div>
							) : (
								<table className="w-full border-collapse text-xs">
									<thead className="sticky top-0 z-10 bg-background">
										<tr className="border-b">
											<th className="w-1/3 px-2 py-1.5 text-left font-medium">
												{t("i18nEditor.colKey")}
											</th>
											{locales.map((locale) => (
												<th
													key={locale}
													className="px-2 py-1.5 text-left font-medium"
												>
													<span className="font-mono">{locale}</span>
													{locale === referenceLocale && (
														<span className="ml-1 font-normal text-muted-foreground">
															{t("i18nEditor.reference")}
														</span>
													)}
												</th>
											))}
											<th className="w-16 px-2 py-1.5" />
										</tr>
									</thead>
									<tbody>
										{visible.slice(0, limit).map((row) => (
											<tr
												key={row.originalKey}
												className="group border-b align-top hover:bg-muted/30"
											>
												<td className="px-2 py-1.5">
													{renaming === row.originalKey ? (
														<input
															value={renameDraft}
															onChange={(e) => setRenameDraft(e.target.value)}
															onBlur={() => commitRename(row.originalKey)}
															onKeyDown={(e) => {
																if (e.key === "Enter") commitRename(row.originalKey);
																if (e.key === "Escape") setRenaming(null);
															}}
															aria-label={t("i18nEditor.renameKey")}
															className="w-full rounded border bg-background px-1.5 py-1 font-mono text-xs"
															// biome-ignore lint/a11y/noAutofocus: replaces the cell the user just clicked to rename
															autoFocus
														/>
													) : (
														<div className="flex items-start gap-1">
															<span
																className={cn(
																	"min-w-0 flex-1 break-all font-mono",
																	row.isNew && "text-primary",
																)}
																title={row.key}
															>
																{row.key}
															</span>
															{row.isNew && (
																<span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] text-primary">
																	{t("i18nEditor.newBadge")}
																</span>
															)}
															{row.isRenamed && (
																<span
																	className="shrink-0 text-muted-foreground"
																	title={t("i18nEditor.renamedFrom", {
																		key: row.originalKey,
																	})}
																>
																	<ArrowLeftRight className="h-3 w-3" />
																</span>
															)}
															{row.placeholderMismatch && (
																<span
																	className="shrink-0 text-amber-600"
																	title={t("i18nEditor.mismatchHint", {
																		vars: placeholdersOf(
																			row.values[referenceLocale] ?? "",
																		).join(", "),
																	})}
																>
																	<AlertTriangle className="h-3 w-3" />
																</span>
															)}
														</div>
													)}
												</td>
												{locales.map((locale) => (
													<td key={locale} className="px-2 py-1.5">
														<EntryCell
															value={row.values[locale]}
															locale={locale}
															entryKey={row.key}
															isDirty={row.dirtyLocales.includes(locale)}
															isReference={locale === referenceLocale}
															hasMismatch={row.placeholderMismatch}
															onChange={(v) => setValue(row.originalKey, locale, v)}
															onRevert={() => revertValue(row.originalKey, locale)}
															disabled={busy}
														/>
													</td>
												))}
												<td className="px-2 py-1.5">
													<div className="flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
														<Button
															size="sm"
															variant="ghost"
															className="h-6 w-6 p-0"
															disabled={busy}
															title={t("i18nEditor.renameKey")}
															aria-label={t("i18nEditor.renameKey")}
															onClick={() => {
																setRenaming(row.originalKey);
																setRenameDraft(row.key);
															}}
														>
															<Pencil className="h-3 w-3" />
														</Button>
														<Button
															size="sm"
															variant="ghost"
															className="h-6 w-6 p-0 text-destructive"
															disabled={busy}
															title={t("i18nEditor.deleteKey")}
															aria-label={t("i18nEditor.deleteKey")}
															onClick={() => deleteKey(row.originalKey)}
														>
															<Trash2 className="h-3 w-3" />
														</Button>
													</div>
												</td>
											</tr>
										))}

										{deletedRows.map((entry) => (
											<tr
												key={`deleted-${entry.key}`}
												className="border-b bg-destructive/5 align-top"
											>
												<td className="px-2 py-1.5">
													<span className="break-all font-mono line-through opacity-60">
														{entry.key}
													</span>
												</td>
												<td
													colSpan={locales.length}
													className="px-2 py-1.5 text-muted-foreground"
												>
													{t("i18nEditor.willBeDeleted")}
												</td>
												<td className="px-2 py-1.5">
													<Button
														size="sm"
														variant="ghost"
														className="h-6 w-6 p-0"
														disabled={busy}
														title={t("i18nEditor.undoDelete")}
														aria-label={t("i18nEditor.undoDelete")}
														onClick={() => restoreKey(entry.key)}
													>
														<Undo2 className="h-3 w-3" />
													</Button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							)}

							{phase !== "loadingNamespace" &&
								visible.length === 0 &&
								deletedRows.length === 0 && (
									<p className="p-8 text-center text-xs text-muted-foreground">
										{t("i18nEditor.noKeyMatches")}
									</p>
								)}

							{visible.length > limit && (
								<div className="flex items-center justify-center gap-3 p-3">
									<span className="text-xs text-muted-foreground">
										{t("i18nEditor.showing", {
											shown: limit,
											total: visible.length,
										})}
									</span>
									<Button
										size="sm"
										variant="outline"
										className="h-7 px-2 text-[11px]"
										onClick={() => setLimit((n) => n + PAGE)}
									>
										{t("i18nEditor.showMore")}
									</Button>
								</div>
							)}
						</div>

						<footer className="flex items-center gap-2 border-t px-3 py-2">
							<span
								className={cn(
									"flex-1 text-xs",
									changes > 0 ? "text-foreground" : "text-muted-foreground",
								)}
							>
								{changes > 0
									? t("i18nEditor.pendingChanges", { count: changes })
									: lastSave
										? lastSave.written.length > 0
											? t("i18nEditor.savedFiles", {
													count: lastSave.written.length,
												})
											: t("i18nEditor.savedNothingToWrite")
										: t("i18nEditor.noChanges")}
							</span>
							{changes > 0 && (
								<Button
									size="sm"
									variant="ghost"
									className="h-7 px-2 text-[11px]"
									onClick={discard}
									disabled={busy}
								>
									{t("i18nEditor.discard")}
								</Button>
							)}
							<Button
								size="sm"
								className="h-7 px-3 text-[11px]"
								onClick={() => void save()}
								disabled={changes === 0 || busy}
							>
								{phase === "saving" ? (
									<Loader2 className="mr-1 h-3 w-3 animate-spin" />
								) : changes === 0 && lastSave ? (
									<Check className="mr-1 h-3 w-3" />
								) : (
									<Save className="mr-1 h-3 w-3" />
								)}
								{t("i18nEditor.save")}
							</Button>
						</footer>
					</>
				)}
			</section>

			<AddKeyDialog
				open={adding}
				onOpenChange={setAdding}
				locales={locales}
				existingKeys={existingKeys}
				namespace={selectedNamespace ?? ""}
				onAdd={addKey}
			/>
		</div>
	);
}
