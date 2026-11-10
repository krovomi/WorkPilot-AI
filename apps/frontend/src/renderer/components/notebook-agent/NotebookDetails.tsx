import { AlertTriangle, GitBranch, Play, Wand2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	NotebookExecution,
	NotebookRefactorOutcome,
	ParsedNotebook,
} from "../../../shared/types/notebook-agent";
import { useProjectStore } from "../../stores/project-store";
import { CharterButton, Chip, Notice, ScanLine, Stat, Stats, type Tone } from "../charter";
import { GeneratedReviewBanner } from "../generated-review/GeneratedReviewBanner";

const MAX_EDGES = 12;
const RUN_TONES: Record<string, Tone> = { ok: "green", error: "red", skipped: "muted", empty: "muted" };
const SEVERITY_TONES: Record<string, Tone> = { error: "red", warning: "amber", info: "blue" };

interface NotebookDetailsProps {
	readonly notebook: ParsedNotebook;
	readonly projectPath: string | undefined;
}

/**
 * Ce que la vérification sait d'un notebook au-delà de ses alertes : quelle
 * cellule a besoin de quelle autre, les cellules longues qui deviendraient une
 * fonction, et une exécution complète dans un noyau neuf. Le refactor et le
 * nettoyage passent par une carte de revue, jamais par le dossier du projet.
 */
export function NotebookDetails({ notebook, projectPath }: NotebookDetailsProps): React.ReactElement | null {
	const { t } = useTranslation("notebookAgent");
	const projectId = useProjectStore((s) => s.projects.find((p) => p.path === projectPath)?.id);
	const [run, setRun] = useState<NotebookExecution | null>(null);
	const [running, setRunning] = useState(false);
	const [chosen, setChosen] = useState<number[]>([]);
	const [clean, setClean] = useState(false);
	const [applying, setApplying] = useState(false);
	const [outcome, setOutcome] = useState<NotebookRefactorOutcome | null>(null);
	const [error, setError] = useState<string | null>(null);

	const deps = notebook.dependencies;
	const proposals = notebook.proposals ?? [];
	const extractable = proposals.filter((p) => !p.reason);

	const execute = async () => {
		if (!projectPath) return;
		setRunning(true);
		setError(null);
		try {
			setRun(await globalThis.electronAPI.executeNotebook({ projectPath, notebook: notebook.path }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRunning(false);
		}
	};

	const apply = async () => {
		if (!projectPath) return;
		setApplying(true);
		setError(null);
		try {
			setOutcome(
				await globalThis.electronAPI.refactorNotebook({
					projectPath,
					notebook: notebook.path,
					extract: chosen,
					clean,
				}),
			);
			setChosen([]);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setApplying(false);
		}
	};

	const toggle = (index: number) =>
		setChosen((prev) => (prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]));

	return (
		<div className="mt-3 space-y-3 border-t border-border/50 pt-3 text-xs">
			{deps && deps.edges.length > 0 && (
				<section aria-label={t("deps.title")} className="space-y-1">
					<p className="wp-kicker">{t("deps.title")}</p>
					<p className={deps.inOrder ? "wp-muted" : "wp-tone-amber wp-ink"}>
						{deps.inOrder
							? t("deps.inOrder")
							: deps.order
								? t("deps.reorder", { order: deps.order.join(" → ") })
								: t("deps.cycle")}
					</p>
					<ul className="grid gap-0.5">
						{deps.edges.slice(0, MAX_EDGES).map((edge) => (
							<li key={`${edge.from}-${edge.to}`} className="wp-meta">
								{t("deps.edge", { to: edge.to, from: edge.from, names: edge.names.join(", ") })}
							</li>
						))}
					</ul>
					{deps.edges.length > MAX_EDGES && (
						<p className="wp-faint">{t("deps.more", { count: deps.edges.length - MAX_EDGES })}</p>
					)}
					{!deps.precise && <p className="wp-faint">{t("deps.approximate")}</p>}
				</section>
			)}

			{notebook.editable && (proposals.length > 0 || notebook.cells?.length) && (
				<section aria-label={t("refactor.title")} className="space-y-1.5">
					<p className="wp-kicker">{t("refactor.title")}</p>
					{proposals.map((proposal) =>
						proposal.reason ? (
							<p key={proposal.cellIndex} className="wp-muted">
								{t("refactor.refused", {
									index: proposal.cellIndex,
									lines: proposal.lines,
									reason: proposal.reason,
								})}
							</p>
						) : (
							<label key={proposal.cellIndex} className="flex items-start gap-2">
								<input
									type="checkbox"
									className="mt-0.5"
									checked={chosen.includes(proposal.cellIndex)}
									disabled={applying}
									onChange={() => toggle(proposal.cellIndex)}
								/>
								<span>
									{t("refactor.proposal", {
										index: proposal.cellIndex,
										lines: proposal.lines,
										module: proposal.module,
									})}
									<code className="ml-1 block font-mono text-2xs">
										{`${proposal.function}(${proposal.params.join(", ")})${proposal.returns.length ? ` → ${proposal.returns.join(", ")}` : ""}`}
									</code>
								</span>
							</label>
						),
					)}
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={clean}
							disabled={applying}
							onChange={(event) => setClean(event.target.checked)}
						/>
						<span>{t("refactor.clean")}</span>
					</label>
					<CharterButton
						size="sm"
						icon={Wand2}
						busy={applying}
						disabled={applying || !projectPath || (chosen.length === 0 && !clean)}
						onClick={() => void apply()}
					>
						{t("refactor.apply")}
					</CharterButton>
					{extractable.length === 0 && proposals.length === 0 && (
						<p className="wp-faint">{t("refactor.none")}</p>
					)}
					{outcome && (
						<div className="space-y-1">
							{outcome.review ? (
								<GeneratedReviewBanner review={outcome.review} projectId={projectId} />
							) : (
								<Notice tone="amber" icon={GitBranch} role="status">
									{t("refactor.nothing")}
								</Notice>
							)}
							{outcome.refused.map((item) => (
								<p key={item.cellIndex} className="wp-muted">
									{t("refactor.refused", { index: item.cellIndex, lines: "—", reason: item.reason })}
								</p>
							))}
						</div>
					)}
				</section>
			)}

			{notebook.runnable !== false && (
				<section aria-label={t("run.title")} className="space-y-1.5">
					<div className="flex items-center justify-between gap-2">
						<p className="wp-kicker">{t("run.title")}</p>
						<CharterButton
							size="sm"
							variant="ghost"
							icon={Play}
							busy={running}
							disabled={running || !projectPath}
							onClick={() => void execute()}
						>
							{t("run.start")}
						</CharterButton>
					</div>
					<p className="wp-faint">{t("run.warning")}</p>
					{running && <ScanLine label={t("run.running")} />}
					{run && <RunResult run={run} />}
				</section>
			)}

			{error && (
				<Notice tone="red" icon={AlertTriangle} role="alert">
					{error}
				</Notice>
			)}
		</div>
	);
}

function RunResult({ run }: { readonly run: NotebookExecution }): React.ReactElement {
	const { t } = useTranslation("notebookAgent");
	if (run.status !== "done") {
		return (
			<Notice tone={run.status === "timeout" ? "amber" : "red"} icon={AlertTriangle} role="status">
				<p>{t(`run.status.${run.status}`, { detail: run.detail })}</p>
				{run.hint && (
					<p className="mt-1">
						{t("run.hint")} <code className="font-mono">{run.hint}</code>
					</p>
				)}
			</Notice>
		);
	}
	return (
		<div className="space-y-2">
			<Stats>
				<Stat
					label={t("run.score")}
					value={run.score === null ? "—" : `${run.score} %`}
					tone={run.score === 100 ? "green" : "amber"}
				/>
				<Stat label={t("run.matching")} value={run.matching === null ? "—" : `${run.matching} %`} tone="blue" />
				<Stat label={t("run.duration")} value={t("run.seconds", { value: run.durationS })} tone="violet" />
			</Stats>
			<ul className="grid gap-1">
				{run.cells.map((cell) => (
					<li key={cell.cellIndex} className="flex flex-wrap items-center gap-2">
						<Chip tone={RUN_TONES[cell.status] ?? "muted"} dot={false}>
							{t(`run.cell.${cell.status}`)}
						</Chip>
						<span className="wp-meta">{t("cellIndex", { index: cell.cellIndex })}</span>
						{cell.seconds !== null && <span className="wp-faint">{t("run.seconds", { value: cell.seconds })}</span>}
						{cell.error && (
							<span className="wp-tone-red wp-ink font-mono">
								{cell.error.name}: {cell.error.value}
							</span>
						)}
					</li>
				))}
			</ul>
			{run.issues.length > 0 && (
				<ul className="grid gap-1">
					{run.issues.map((issue) => (
						<li key={`${issue.issueType}-${issue.cellIndex}`}>
							<Chip tone={SEVERITY_TONES[issue.severity] ?? "muted"} dot={false}>
								{t(`issueTypes.${issue.issueType}`, { defaultValue: issue.issueType })}
							</Chip>
							<span className="ml-2">{issue.message}</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
