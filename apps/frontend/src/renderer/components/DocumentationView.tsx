/**
 * "Documentation" tab of Docs et dérive, in the UI charter
 * (docs/architecture/ui-charter.md): project coverage on the left, the
 * chosen file's symbols in the middle, drafts (doc comments or README) on
 * the right, and the composer at the bottom. Every language of
 * apps/backend/doc_languages is read; drafts follow each language's own doc
 * comment convention and are never written to the project.
 */
import {
	AlertTriangle,
	BookOpenCheck,
	Check,
	Copy,
	FileCode2,
	FileText,
	FolderTree,
	Play,
	ScanSearch,
	Sparkles,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	DocSymbol,
	DocSymbolStatus,
	DocumentationAction,
} from "../../shared/types/documentation";
import { useDocumentationStore } from "../stores/documentation-store";
import { useProjectStore } from "../stores/project-store";
import {
	Bar,
	CharterButton,
	Chip,
	Column,
	Columns,
	Composer,
	EmptyStage,
	Gauge,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
	Stat,
	Stats,
	type Tone,
} from "./charter";
import { FilePathAutocomplete } from "./FilePathAutocomplete";

interface DocumentationViewProps {
	readonly projectId: string;
}

const STATUS_TONE: Record<DocSymbolStatus, Tone> = {
	documented: "green",
	partial: "amber",
	missing: "red",
};

const LANGUAGE_TONE: Record<string, Tone> = {
	csharp: "violet",
	typescript: "blue",
	python: "amber",
	java: "orange",
	kotlin: "pink",
	scala: "red",
	swift: "orange",
	go: "green",
	rust: "orange",
	php: "violet",
	ruby: "red",
	dart: "blue",
	cpp: "muted",
};

export const coverageTone = (pct: number): Tone =>
	pct >= 80 ? "green" : pct >= 50 ? "amber" : "red";

function CopyButton({ text, label }: { readonly text: string; readonly label?: string }) {
	const { t } = useTranslation("documentation");
	const [copied, setCopied] = useState(false);
	return (
		<CharterButton
			size="sm"
			variant="ghost"
			icon={copied ? Check : Copy}
			onClick={async () => {
				await navigator.clipboard.writeText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 1800);
			}}
		>
			{copied ? t("actions.copied") : (label ?? t("actions.copy"))}
		</CharterButton>
	);
}

/** The draft without the declaration's indentation (copied with it). */
export function dedent(text: string): string {
	const lines = text.split("\n");
	const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
	const cut = indents.length ? Math.min(...indents) : 0;
	return lines.map((l) => l.slice(cut)).join("\n");
}

const symbolKey = (s: DocSymbol) => `${s.name}:${s.line_number}`;

// ── Columns ─────────────────────────────────────────────────────────────────

function ProjectColumn({ onPickFile }: { readonly onPickFile: (path: string) => void }) {
	const { t } = useTranslation("documentation");
	const overview = useDocumentationStore((s) => s.overview);
	const running = useDocumentationStore((s) => s.running);
	const status = useDocumentationStore((s) => s.status);
	const run = useDocumentationStore((s) => s.run);
	const selectedFile = useDocumentationStore((s) => s.file?.path);

	const meta = overview
		? t("project.meta", { files: overview.files_with_symbols, languages: overview.languages.length })
		: undefined;

	return (
		<Column
			kicker={t("project.kicker")}
			title={t("project.title")}
			meta={meta}
			tone="accent"
		>
			{running === "project" && <ScanLine label={status || t("progress.project")} />}
			{!overview && running !== "project" && (
				<EmptyStage
					icon={BookOpenCheck}
					title={t("project.emptyTitle")}
					action={
						<CharterButton variant="primary" icon={ScanSearch} onClick={() => run("project")}>
							{t("project.analyze")}
						</CharterButton>
					}
				>
					{t("project.emptyHint")}
				</EmptyStage>
			)}
			{overview && (
				<div className="flex flex-col gap-4">
					<Panel className="flex items-center gap-4">
						<Gauge value={overview.coverage_pct} tone={coverageTone(overview.coverage_pct)} />
						<div className="flex min-w-0 flex-col gap-1">
							<span className="wp-kicker">{t("coverage.title")}</span>
							<span className="wp-title">
								{overview.coverage_pct >= 80
									? t("coverage.wellDocumented")
									: overview.coverage_pct >= 50
										? t("coverage.needsImprovement")
										: t("coverage.poorlyDocumented")}
							</span>
							<span className="wp-meta">
								{overview.documented}/{overview.total}
							</span>
						</div>
						<CharterButton
							size="sm"
							variant="ghost"
							className="ml-auto self-start"
							icon={ScanSearch}
							disabled={running !== null}
							onClick={() => run("project")}
							title={t("project.reanalyze")}
							aria-label={t("project.reanalyze")}
						/>
					</Panel>
					<Stats>
						<Stat label={t("coverage.documented")} value={overview.documented} tone="green" />
						<Stat label={t("coverage.partial")} value={overview.partial} tone="amber" />
						<Stat label={t("coverage.missing")} value={overview.missing} tone="red" />
					</Stats>

					{overview.languages.length > 0 && (
						<div className="flex flex-col gap-2">
							<span className="wp-kicker wp-faint">{t("project.languages")}</span>
							{overview.languages.map((lang) => (
								<div key={lang.id} className="flex flex-col gap-1">
									<div className="flex items-center justify-between gap-2 text-xs">
										<span className="flex items-center gap-2">
											<span className={`wp-dot wp-tone-${LANGUAGE_TONE[lang.id] ?? "muted"}`} />
											{lang.label}
										</span>
										<span className="wp-meta">
											{lang.coverage_pct}% · {lang.files}
										</span>
									</div>
									<Bar value={lang.coverage_pct} tone={coverageTone(lang.coverage_pct)} />
								</div>
							))}
						</div>
					)}

					{overview.total === 0 ? (
						<p className="wp-meta">{t("project.noSymbols")}</p>
					) : overview.files.length === 0 ? (
						<Notice tone="green" icon={Check}>
							{t("project.allDocumented")}
						</Notice>
					) : (
						<div className="flex flex-col gap-1.5">
							<span className="wp-kicker wp-faint" title={t("project.priorityHint")}>
								{t("project.priority")}
							</span>
							<div className="wp-rows">
								{overview.files.map((file) => (
									<button
										key={file.path}
										type="button"
										className={`wp-row wp-tone-${coverageTone(file.coverage_pct)}`}
										data-active={selectedFile === file.path ? "true" : undefined}
										onClick={() => onPickFile(file.path)}
										title={file.path}
									>
										<span className="wp-dot" />
										<span className="wp-mono min-w-0 flex-1 truncate text-xs">{file.path}</span>
										<span className="wp-meta">
											{file.missing + file.partial}/{file.total}
										</span>
									</button>
								))}
							</div>
						</div>
					)}
					{overview.truncated && <p className="wp-meta">{t("project.truncated")}</p>}
				</div>
			)}
		</Column>
	);
}

function FileColumn() {
	const { t } = useTranslation("documentation");
	const file = useDocumentationStore((s) => s.file);
	const running = useDocumentationStore((s) => s.running);
	const status = useDocumentationStore((s) => s.status);
	const selected = useDocumentationStore((s) => s.selectedSymbol);
	const select = useDocumentationStore((s) => s.selectSymbol);
	const current = file?.symbols.find((s) => symbolKey(s) === selected) ?? null;

	return (
		<Column
			kicker={t("file.kicker")}
			title={<span className="wp-mono text-sm">{file?.path ?? "—"}</span>}
			meta={file ? t("file.meta", { pct: file.coverage_pct }) : undefined}
			tone="blue"
		>
			{running === "coverage" && <ScanLine label={status || t("progress.coverage")} />}
			{!file && running !== "coverage" && (
				<EmptyStage icon={FileCode2} title={t("file.emptyTitle")} tone="blue">
					{t("file.emptyHint")}
				</EmptyStage>
			)}
			{file && (
				<div className="flex flex-col gap-3">
					<Stats>
						<Stat label={t("coverage.documented")} value={file.documented} tone="green" />
						<Stat label={t("coverage.partial")} value={file.partial} tone="amber" />
						<Stat label={t("coverage.missing")} value={file.missing} tone="red" />
					</Stats>
					<span className="wp-meta">{t("file.symbols", { count: file.symbols.length })}</span>
					<div className="wp-rows">
						{file.symbols.map((sym) => (
							<button
								key={symbolKey(sym)}
								type="button"
								className={`wp-row wp-tone-${STATUS_TONE[sym.status]}`}
								data-active={selected === symbolKey(sym) ? "true" : undefined}
								onClick={() => select(selected === symbolKey(sym) ? null : symbolKey(sym))}
								title={sym.status === "partial" ? t("coverage.partialHint") : undefined}
							>
								<span className="wp-dot" />
								<span className="wp-mono min-w-0 flex-1 truncate text-xs">{sym.name}</span>
								<Chip dot={false}>{t(`kinds.${sym.symbol_type}`, sym.symbol_type)}</Chip>
								<span className="wp-meta">L{sym.line_number}</span>
							</button>
						))}
					</div>
					{current && (
						<Panel rail tone={STATUS_TONE[current.status]}>
							<div className="mb-2 flex items-center justify-between gap-2">
								<span className="wp-kicker">{t("file.existing")}</span>
								<span className="wp-meta">{t("file.line", { line: current.line_number })}</span>
							</div>
							{current.existing_doc ? (
								<pre className="wp-code">{current.existing_doc}</pre>
							) : (
								<p className="wp-muted text-xs">{t("file.noExisting")}</p>
							)}
						</Panel>
					)}
				</div>
			)}
		</Column>
	);
}

function DraftsColumn() {
	const { t } = useTranslation("documentation");
	const drafts = useDocumentationStore((s) => s.drafts);
	const readme = useDocumentationStore((s) => s.readme);
	const view = useDocumentationStore((s) => s.draftsView);
	const setView = useDocumentationStore((s) => s.setDraftsView);
	const running = useDocumentationStore((s) => s.running);
	const status = useDocumentationStore((s) => s.status);
	const selected = useDocumentationStore((s) => s.selectedSymbol);
	const isReadme = view === "readme";
	const readmeFile = readme ? [readme.source_path, "README.md"].join("/") : "";
	const busy: DocumentationAction | null = running === "docstrings" || running === "readme" ? running : null;
	const docs = drafts?.generated_docs ?? [];

	const actions = (
		<div className="flex items-center gap-1.5">
			<Chip tone="violet" pressed={!isReadme} onClick={() => setView("docs")}>
				{t("drafts.tabDocs")}
			</Chip>
			<Chip tone="violet" pressed={isReadme} onClick={() => setView("readme")}>
				{t("drafts.tabReadme")}
			</Chip>
		</div>
	);

	return (
		<Column
			kicker={t("drafts.kicker")}
			title={isReadme ? t("drafts.titleReadme") : t("drafts.titleDocs")}
			tone="violet"
			actions={actions}
		>
			{busy && <ScanLine label={status || t(`progress.${busy}`)} />}
			{!isReadme && !drafts && !busy && (
				<EmptyStage icon={Sparkles} title={t("drafts.emptyTitle")} tone="violet">
					{t("drafts.emptyHint")}
				</EmptyStage>
			)}
			{!isReadme && drafts && docs.length === 0 && (
				<Notice tone="green" icon={Check}>
					{t("drafts.noneNeeded")}
				</Notice>
			)}
			{!isReadme && docs.length > 0 && (
				<div className="flex flex-col gap-2.5">
					<div className="flex items-center justify-between gap-2">
						<span className="wp-meta">{t("drafts.count", { count: docs.length })}</span>
						<CopyButton
							text={docs.map((d) => `${d.name}\n${d.generated_doc}`).join("\n\n")}
							label={t("actions.copyAll")}
						/>
					</div>
					{docs.map((doc) => (
						<Panel
							key={symbolKey(doc)}
							rail
							tone={STATUS_TONE[doc.status]}
							data-active={selected === symbolKey(doc) ? "true" : undefined}
						>
							<div className="mb-2 flex items-center justify-between gap-2">
								<div className="min-w-0">
									<span className="wp-kicker">
										{t(`kinds.${doc.symbol_type}`, doc.symbol_type)} · L{doc.line_number}
									</span>
									<div className="wp-mono truncate text-sm font-medium">{doc.name}</div>
								</div>
								<CopyButton text={doc.generated_doc} />
							</div>
							<pre className="wp-code">{dedent(doc.generated_doc)}</pre>
						</Panel>
					))}
				</div>
			)}
			{isReadme && !readme && !busy && (
				<EmptyStage icon={FolderTree} title={t("drafts.emptyTitle")} tone="violet">
					{t("drafts.readmeEmptyHint")}
				</EmptyStage>
			)}
			{isReadme && readme && (
				<Panel>
					<div className="mb-2 flex items-center justify-between gap-2">
						<span className="wp-mono text-xs">{readmeFile}</span>
						<CopyButton text={readme.readme_content} />
					</div>
					<pre className="wp-code">{readme.readme_content}</pre>
				</Panel>
			)}
		</Column>
	);
}

// ── View ────────────────────────────────────────────────────────────────────

export function DocumentationView({ projectId }: DocumentationViewProps) {
	const { t } = useTranslation("documentation");
	const projectPath = useProjectStore(
		(s) => s.projects.find((p) => p.id === projectId)?.path ?? "",
	);
	const bindProject = useDocumentationStore((s) => s.bindProject);
	const setStatus = useDocumentationStore((s) => s.setStatus);
	const run = useDocumentationStore((s) => s.run);
	const cancel = useDocumentationStore((s) => s.cancel);
	const running = useDocumentationStore((s) => s.running);
	const error = useDocumentationStore((s) => s.error);
	const currentFile = useDocumentationStore((s) => s.file?.path ?? "");
	const [filePath, setFilePath] = useState(currentFile);
	const [dirPath, setDirPath] = useState("");

	useEffect(() => {
		if (projectPath) bindProject(projectPath);
	}, [projectPath, bindProject]);

	useEffect(() => globalThis.electronAPI?.onDocumentationProgress?.(setStatus), [setStatus]);

	useEffect(() => {
		if (currentFile) setFilePath(currentFile);
	}, [currentFile]);

	const pickFile = (path: string) => {
		setFilePath(path);
		void run("coverage", path);
	};
	const busy = running !== null;
	const file = filePath.trim();

	return (
		<ModuleStage data-testid="documentation-view">
			<Columns template="minmax(280px, 30%) minmax(300px, 32%) minmax(0, 1fr)">
				<ProjectColumn onPickFile={pickFile} />
				<FileColumn />
				<DraftsColumn />
			</Columns>
			{(error || !projectPath) && (
				<Notice tone="red" icon={AlertTriangle} role="alert" className="relative z-[2] mx-5 mb-2">
					{projectPath ? t("errors.failed", { error }) : t("errors.noProject")}
				</Notice>
			)}
			<Composer
				prompt={
					<FilePathAutocomplete
						value={filePath}
						onChange={setFilePath}
						rootPath={projectPath}
						mode="file"
						placeholder={t("composer.filePlaceholder")}
						className="h-8 border-0 bg-transparent font-mono text-xs shadow-none focus-visible:ring-0"
						disabled={!projectPath}
					/>
				}
				actions={
					busy ? (
						<CharterButton icon={X} onClick={() => cancel()}>
							{t("actions.cancel")}
						</CharterButton>
					) : (
						<>
							<CharterButton icon={Play} disabled={!file} onClick={() => run("coverage", file)}>
								{t("actions.check")}
							</CharterButton>
							<CharterButton
								variant="primary"
								icon={Sparkles}
								disabled={!file}
								onClick={() => run("docstrings", file)}
							>
								{t("actions.generateDocstrings")}
							</CharterButton>
						</>
					)
				}
				options={
					<>
						<span className="wp-field w-full max-w-[30rem]">
							{t("composer.folder")}
							<FilePathAutocomplete
								value={dirPath}
								onChange={setDirPath}
								rootPath={projectPath}
								mode="directory"
								placeholder={t("composer.folderPlaceholder")}
								className="h-6 border-0 bg-transparent px-1 font-mono text-xs shadow-none focus-visible:ring-0"
								disabled={!projectPath}
							/>
						</span>
						<CharterButton
							size="sm"
							icon={FileText}
							disabled={busy || !projectPath}
							onClick={() => run("readme", dirPath.trim())}
						>
							{t("actions.generateReadme")}
						</CharterButton>
					</>
				}
			/>
		</ModuleStage>
	);
}
