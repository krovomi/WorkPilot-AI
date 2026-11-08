import { AlertTriangle, NotebookPen, Play, RotateCcw, Square } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useNotebookAgentStore } from "../../stores/notebook-agent-store";
import type { ParsedNotebook } from "../../../shared/types/notebook-agent";
import {
	CharterButton,
	Chip,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	Panel,
	ScanLine,
	Section,
	Stat,
	Stats,
	type Tone,
} from "../charter";

const SEVERITY_TONES: Record<string, Tone> = {
	error: "red",
	warning: "amber",
	info: "blue",
};

interface NotebookViewProps {
	readonly projectPath?: string;
}

/** Notebooks checked cell by cell: Jupyter (any kernel), .NET Polyglot, Quarto, R Markdown. */
export function NotebookView({ projectPath }: NotebookViewProps): React.ReactElement {
	const { t } = useTranslation(["notebookAgent", "navigation"]);

	const phase = useNotebookAgentStore((s) => s.phase);
	const status = useNotebookAgentStore((s) => s.status);
	const notebooks = useNotebookAgentStore((s) => s.notebooks);
	const error = useNotebookAgentStore((s) => s.error);
	const startScan = useNotebookAgentStore((s) => s.startScan);
	const cancelScan = useNotebookAgentStore((s) => s.cancelScan);
	const reset = useNotebookAgentStore((s) => s.reset);

	const isScanning = phase === "scanning";
	const issues = notebooks.reduce((n, nb) => n + nb.issues.length, 0);
	const cells = notebooks.reduce((n, nb) => n + nb.totalCells, 0);

	return (
		<ModuleStage scroll="page" data-testid="notebook-agent-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("notebookAgent:title")}
				description={t("notebookAgent:description")}
				icon={NotebookPen}
				tone="violet"
				actions={
					<>
						{notebooks.length > 0 && !isScanning && (
							<CharterButton variant="ghost" icon={RotateCcw} onClick={reset}>
								{t("notebookAgent:actions.reset")}
							</CharterButton>
						)}
						{isScanning ? (
							<CharterButton variant="danger" icon={Square} onClick={() => cancelScan()}>
								{t("notebookAgent:actions.cancel")}
							</CharterButton>
						) : (
							<CharterButton
								variant="primary"
								icon={Play}
								onClick={() => projectPath && startScan(projectPath)}
								disabled={!projectPath}
							>
								{t("notebookAgent:actions.runScan")}
							</CharterButton>
						)}
					</>
				}
			/>
			<Page className="max-w-none space-y-4">
				{!projectPath && (
					<Notice tone="amber" icon={AlertTriangle}>
						{t("notebookAgent:errors.noProject")}
					</Notice>
				)}
				{isScanning && <ScanLine label={status || t("notebookAgent:actions.scanning")} />}
				{phase === "error" && error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{t("notebookAgent:errors.failed", { error })}
					</Notice>
				)}
				{notebooks.length > 0 ? (
					<>
						<Stats>
							<Stat label={t("notebookAgent:notebooks")} value={notebooks.length} tone="violet" />
							<Stat label={t("notebookAgent:totalCells")} value={cells} tone="blue" />
							<Stat label={t("notebookAgent:issues")} value={issues} tone={issues ? "amber" : "green"} />
						</Stats>
						<Section kicker={t("notebookAgent:kickers.notebooks")} title={t("notebookAgent:notebooksTitle")}>
							<div className="grid gap-2.5 lg:grid-cols-2">
								{notebooks.map((nb) => (
									<NotebookPanel key={nb.path} notebook={nb} />
								))}
							</div>
						</Section>
					</>
				) : (
					!isScanning && (
						<EmptyStage
							icon={NotebookPen}
							tone="violet"
							title={t(phase === "complete" ? "notebookAgent:emptyTitle" : "notebookAgent:idleTitle")}
						>
							{t("notebookAgent:noData")}
						</EmptyStage>
					)
				)}
			</Page>
		</ModuleStage>
	);
}

function NotebookPanel({ notebook }: { readonly notebook: ParsedNotebook }): React.ReactElement {
	const { t } = useTranslation("notebookAgent");
	const worst = notebook.issues.some((i) => i.severity === "error")
		? "red"
		: notebook.issues.length
			? "amber"
			: "green";
	return (
		<Panel rail tone={worst}>
			<div className="flex items-start justify-between gap-2">
				<span className="wp-title truncate font-mono text-sm" title={notebook.path}>
					{notebook.path}
				</span>
				<span className="wp-chips shrink-0">
					{notebook.kernel && (
						<Chip tone="violet" dot={false}>
							{notebook.kernel}
						</Chip>
					)}
					{notebook.language && (
						<Chip tone="muted" dot={false}>
							{notebook.language}
						</Chip>
					)}
				</span>
			</div>
			<p className="wp-meta mt-1">
				{t("cellSummary", {
					total: notebook.totalCells,
					code: notebook.codeCells,
					markdown: notebook.markdownCells,
				})}
			</p>
			{notebook.issues.length > 0 ? (
				<ul className="mt-2 grid gap-1.5">
					{notebook.issues.map((issue) => (
						<li key={`${issue.issueType}-${issue.cellIndex}`} className="text-xs">
							<div className="flex items-center gap-2">
								<Chip tone={SEVERITY_TONES[issue.severity] ?? "muted"} dot={false}>
									{t(`severities.${issue.severity}`, { defaultValue: issue.severity })}
								</Chip>
								<span className="wp-meta shrink-0">
									{t("cellIndex", { index: issue.cellIndex })} ·{" "}
									{t(`issueTypes.${issue.issueType}`, { defaultValue: issue.issueType })}
								</span>
							</div>
							<p className="mt-1">{issue.message}</p>
							{issue.suggestion && <p className="wp-tone-green wp-ink mt-0.5">{issue.suggestion}</p>}
						</li>
					))}
				</ul>
			) : (
				<p className="wp-muted mt-1.5 text-xs">{t("noIssues")}</p>
			)}
		</Panel>
	);
}
