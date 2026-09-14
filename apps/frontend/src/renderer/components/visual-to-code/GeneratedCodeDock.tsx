/**
 * GeneratedCodeDock — the generation, while it is happening.
 *
 * The result used to arrive in a modal at the very end, which left a two-minute
 * run looking like a spinner over a dead page: every file was already written
 * and none of them could be seen. A dock instead of a dialog, for three
 * reasons — it can open at the *start* rather than the end, the canvas stays
 * visible beside the code it produced, and a modal that pops up two minutes
 * after the click lands on whatever the user was doing instead.
 *
 * Everything it renders comes from the store, so it shows the same run whether
 * the page was open the whole time or is being reopened after a detour.
 */

import {
	AlertCircle,
	CheckCircle2,
	Download,
	FileCode2,
	Loader2,
	X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { saveAs } from "file-saver";
import type { GeneratedFile } from "@preload/api/modules/visual-programming-api";
import { useVisualToCodeStore } from "../../stores/visual-to-code-store";
import { Button } from "../ui/button";
import { CodeEditor } from "../ui/code-editor";

/** Strip the directories: the row is narrow and the path is shown under it. */
function baseName(filename: string): string {
	return filename.split(/[\\/]/).pop() || filename;
}

function download(file: GeneratedFile): void {
	saveAs(new Blob([file.content], { type: "text/plain" }), baseName(file.filename));
}

export function GeneratedCodeDock() {
	const { t } = useTranslation("visualProgramming");
	const {
		phase,
		error,
		status,
		streamedFiles,
		writingFile,
		codeResult,
		selectedFile,
		selectFile,
		setDockOpen,
		dockOpen,
	} = useVisualToCodeStore();

	if (!dockOpen) return null;

	const running = phase === "generating";
	const current = streamedFiles[selectedFile];
	// `status` is the backend's own English progress line; the filename is more
	// useful than either when there is one, because it is the only signal that
	// says the model is *producing* rather than merely running.
	const progressLine = writingFile ?? status;

	return (
		<aside
			className="flex w-[26rem] shrink-0 flex-col border-l bg-background"
			aria-label={t("generatedCodeTitle", "Code généré par IA")}
		>
			{/* Header */}
			<div className="flex items-center gap-2 border-b px-3 py-2">
				{running ? (
					<Loader2 className="h-4 w-4 shrink-0 animate-spin text-violet-500" />
				) : phase === "error" ? (
					<AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
				) : (
					<CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
				)}
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-medium">
						{t("generatedCodeTitle", "Code généré par IA")}
					</p>
					{running && progressLine && (
						<p className="truncate text-xs text-muted-foreground">
							{writingFile
								? t("dockWriting", "Écriture de {{file}}…", {
										file: baseName(writingFile),
									})
								: progressLine}
						</p>
					)}
					{!running && streamedFiles.length > 0 && (
						<p className="truncate text-xs text-muted-foreground">
							{t("dockFileCount", "{{count}} fichier(s)", {
								count: streamedFiles.length,
							})}
						</p>
					)}
				</div>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 w-7 shrink-0 p-0"
					onClick={() => setDockOpen(false)}
					title={t("close", "Fermer")}
					aria-label={t("close", "Fermer")}
				>
					<X className="h-3.5 w-3.5" />
				</Button>
			</div>

			{phase === "error" && error && (
				<div className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">
					{error}
				</div>
			)}

			{/* A run that ended before the model finished. Saying so is the
			    difference between an incomplete answer and a wrong one. */}
			{codeResult?.truncated && (
				<div className="flex items-start gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
					<AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
					<span>
						{t(
							"dockTruncated",
							"La génération s'est interrompue avant la fin. Voici les fichiers déjà complets.",
						)}
					</span>
				</div>
			)}

			{/* File list — each row appears the moment its file is complete. */}
			<div className="max-h-[38%] shrink-0 overflow-y-auto border-b p-1.5">
				{streamedFiles.map((file, index) => (
					<button
						type="button"
						key={file.filename}
						onClick={() => selectFile(index)}
						className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
							index === selectedFile
								? "bg-violet-500/10 text-violet-700 dark:text-violet-300"
								: "hover:bg-muted"
						}`}
					>
						<FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-xs font-medium">
								{baseName(file.filename)}
							</span>
							<span className="block truncate text-[11px] text-muted-foreground">
								{file.filename}
							</span>
						</span>
					</button>
				))}

				{/* The file being written, as a row that is visibly not finished. */}
				{running && writingFile && (
					<div className="flex items-center gap-2 rounded-md px-2 py-1.5">
						<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin opacity-60" />
						<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
							{baseName(writingFile)}
						</span>
					</div>
				)}

				{/* Nothing yet. Not an error — the first file simply has not closed. */}
				{streamedFiles.length === 0 && !writingFile && (
					<p className="px-2 py-3 text-center text-xs text-muted-foreground">
						{running
							? t("dockWaiting", "En attente des premiers fichiers…")
							: phase === "error"
								? t("dockNoFiles", "Aucun fichier n'a été produit.")
								: t("dockEmpty", "Lancez « Aperçu du code » pour générer.")}
					</p>
				)}
			</div>

			{/* The selected file */}
			<div className="flex min-h-0 flex-1 flex-col">
				{current ? (
					<>
						<p className="truncate border-b px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
							{current.filename}
						</p>
						{/* CodeMirror owns its own scrolling at h-full; an
						    overflow wrapper here would give it a second one. */}
						<div className="min-h-0 flex-1 p-1.5">
							<CodeEditor
								value={current.content}
								filename={current.filename}
								readOnly
							/>
						</div>
					</>
				) : (
					<div className="flex flex-1 items-center justify-center px-6">
						<p className="text-center text-xs text-muted-foreground">
							{running
								? t(
										"dockStreamingHint",
										"Les fichiers s'affichent ici au fur et à mesure qu'ils sont produits.",
									)
								: ""}
						</p>
					</div>
				)}
			</div>

			{/* Summary and downloads — only once there is something to download. */}
			{streamedFiles.length > 0 && (
				<div className="shrink-0 border-t p-2">
					{codeResult?.summary && (
						<p className="mb-2 line-clamp-3 text-xs text-muted-foreground">
							{codeResult.summary}
						</p>
					)}
					<div className="flex gap-1.5">
						<Button
							size="sm"
							variant="outline"
							className="h-7 flex-1 gap-1.5 text-xs"
							disabled={!current}
							onClick={() => current && download(current)}
						>
							<Download className="h-3.5 w-3.5" />
							{t("downloadFile", "Télécharger ce fichier")}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							className="h-7 gap-1.5 text-xs"
							onClick={() => {
								for (const file of streamedFiles) download(file);
							}}
						>
							{t("downloadAll", "Tout télécharger")}
						</Button>
					</div>
				</div>
			)}
		</aside>
	);
}
