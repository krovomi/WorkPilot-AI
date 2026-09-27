import { Loader2, ScanEye } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import type {
	VisualDiff,
	VisualFinding,
	VisualMockup,
	VisualSeverity,
} from "../../lib/agent-tools-api";
import { useDocintelVisualStore } from "../../stores/docintel-visual-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export interface VisualReviewCardProps {
	readonly task: Task;
	/** Absolute project path; the server derives the spec directory from it. */
	readonly projectPath?: string;
}

/** Kinds the card has a label for; anything else falls back to the raw kind. */
const KINDS = new Set([
	"untranslated-key",
	"interpolation",
	"language",
	"foreign-label",
	"truncated",
	"ellipsis",
	"clipped",
	"overflow",
	"crash",
	"error-page",
	"login",
	"blank",
	"expected-screen",
	"mockup-missing",
	"mockup-near",
	"placeholder",
]);

const SEVERITY_VARIANT: Record<VisualSeverity, "destructive" | "outline" | "secondary"> = {
	high: "destructive",
	medium: "outline",
	low: "secondary",
};

const MAX_FINDINGS = 12;
const MAX_LABELS = 8;

/**
 * Ce que les écrans de la tâche montrent — lus par OCR, avant la revue.
 *
 * Les captures de l'application qui tourne (l'aperçu de l'Émulateur, Visual
 * Proof, l'image de l'appareil, les captures de la fiche du store) sont lues
 * par la chaîne OCR locale et vérifiées : une clé de traduction affichée telle
 * quelle, une langue qui n'est pas celle de l'écran, un libellé coupé, un écran
 * de crash ou de connexion. Deux comparaisons s'y ajoutent : la même route sur
 * la branche de base et sur la tâche (ce qui a changé à l'écran), et la
 * maquette (Figma d'abord, sinon l'image jointe) face au rendu.
 *
 * Tout texte affiché ici vient d'un écran : c'est une donnée, rendue comme du
 * texte et jamais interprétée. L'OCR se trompe ; la carte le dit, et la QA
 * vérifie chaque constat sur la capture avant de le retenir.
 *
 * Elle ne s'affiche que quand il y a une capture ou un relevé : pas de capture,
 * pas de carte.
 */
export function VisualReviewCard({ task, projectPath }: VisualReviewCardProps) {
	const { t } = useTranslation(["tasks"]);
	const [expanded, setExpanded] = useState(false);

	const load = useDocintelVisualStore((s) => s.load);
	const run = useDocintelVisualStore((s) => s.run);
	const clear = useDocintelVisualStore((s) => s.clear);
	const entry = useDocintelVisualStore((s) => s.byTask[task.id]);
	const data = entry?.data ?? null;

	useEffect(() => {
		if (!projectPath) return;
		void load(task.id, { projectDir: projectPath, specId: task.specId });
		return () => clear(task.id);
	}, [task.id, task.specId, projectPath, load, clear]);

	if (!projectPath || data === null) return null;

	const record = data.record && !data.record.skipped ? data.record : null;
	if (!record && data.captures.length === 0) return null;

	const findings = record?.findings ?? [];
	const diffs = (record?.diffs ?? []).filter(
		(d) => d.changed.length + d.added.length + d.removed.length > 0,
	);
	const mockups = (record?.mockups ?? []).filter((m) => m.status === "compared");
	const counts = data.counts;
	const running = entry?.busy === "running";

	return (
		<div className="rounded-lg border border-border bg-muted/20">
			<div className="flex items-start justify-between gap-3 p-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<ScanEye className="h-4 w-4 shrink-0 text-primary" aria-hidden />
						<span className="text-sm font-medium">{t("tasks:visualReview.title")}</span>
						<Badge variant="outline" className="text-[10px]">
							{t("tasks:visualReview.badge.captures", {
								count: data.captures.length,
							})}
						</Badge>
						{counts &&
							(["high", "medium", "low"] as const).map((severity) =>
								counts[severity] > 0 ? (
									<Badge
										key={severity}
										variant={SEVERITY_VARIANT[severity]}
										className="text-[10px]"
									>
										{t(`tasks:visualReview.badge.${severity}`, {
											count: counts[severity],
										})}
									</Badge>
								) : null,
							)}
						{diffs.length > 0 && (
							<Badge variant="outline" className="text-[10px]">
								{t("tasks:visualReview.badge.diffs", { count: diffs.length })}
							</Badge>
						)}
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{record
							? t("tasks:visualReview.subtitle")
							: t("tasks:visualReview.notRead")}
					</p>
					{data.pending > 0 && record && (
						<p className="mt-1 text-xs text-warning">
							{t("tasks:visualReview.pending", { count: data.pending })}
						</p>
					)}
					{entry?.error && (
						<p role="alert" className="mt-1 text-xs text-destructive">
							{t("tasks:visualReview.error", { error: entry.error })}
						</p>
					)}
				</div>
				<div className="flex shrink-0 gap-2">
					{(data.pending > 0 || !record) && (
						<Button
							size="sm"
							variant="outline"
							disabled={running}
							onClick={() =>
								void run(task.id, { projectDir: projectPath, specId: task.specId })
							}
						>
							{running && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
							{t("tasks:visualReview.read")}
						</Button>
					)}
					{record && (findings.length > 0 || diffs.length > 0 || mockups.length > 0) && (
						<Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
							{expanded ? t("tasks:visualReview.collapse") : t("tasks:visualReview.expand")}
						</Button>
					)}
				</div>
			</div>

			{expanded && record && (
				<div className="space-y-3 border-t border-border p-3 text-xs">
					{findings.length > 0 && (
						<section>
							<h4 className="mb-1 font-medium">{t("tasks:visualReview.findings")}</h4>
							<ul className="space-y-1">
								{findings.slice(0, MAX_FINDINGS).map((finding) => (
									<FindingRow
										key={`${finding.kind}|${finding.capture}|${finding.text}|${finding.detail}`}
										finding={finding}
									/>
								))}
							</ul>
							{findings.length > MAX_FINDINGS && (
								<p className="mt-1 text-muted-foreground">
									{t("tasks:visualReview.more", {
										count: findings.length - MAX_FINDINGS,
									})}
								</p>
							)}
						</section>
					)}
					{diffs.length > 0 && (
						<section>
							<h4 className="mb-1 font-medium">{t("tasks:visualReview.diffs")}</h4>
							{diffs.map((diff) => (
								<DiffBlock key={diff.key} diff={diff} />
							))}
						</section>
					)}
					{mockups.length > 0 && (
						<section>
							<h4 className="mb-1 font-medium">{t("tasks:visualReview.mockups")}</h4>
							{mockups.map((mockup) => (
								<MockupRow key={`${mockup.source}-${mockup.frame}`} mockup={mockup} />
							))}
						</section>
					)}
					<p className="text-muted-foreground">{t("tasks:visualReview.ocrCaveat")}</p>
				</div>
			)}
		</div>
	);
}

function FindingRow({ finding }: { finding: VisualFinding }) {
	const { t } = useTranslation(["tasks"]);
	const kind = KINDS.has(finding.kind)
		? t(`tasks:visualReview.kind.${finding.kind}`)
		: finding.kind;
	return (
		<li className="flex flex-wrap items-baseline gap-2">
			<Badge variant={SEVERITY_VARIANT[finding.severity] ?? "outline"} className="text-[10px]">
				{t(`tasks:visualReview.severity.${finding.severity}`)}
			</Badge>
			<span>{kind}</span>
			{finding.text && <code className="rounded bg-muted px-1">{finding.text}</code>}
			{finding.detail && <span className="text-muted-foreground">({finding.detail})</span>}
			<span className="truncate font-mono text-[10px] text-muted-foreground">
				{finding.capture}
			</span>
		</li>
	);
}

function DiffBlock({ diff }: { diff: VisualDiff }) {
	const { t } = useTranslation(["tasks"]);
	return (
		<div className="mb-2">
			<p className="font-mono">
				{diff.route || diff.key}
				{diff.locale ? ` · ${diff.locale}` : ""}
				<span className="ml-2 font-sans text-muted-foreground">
					{t("tasks:visualReview.diffSummary", {
						changed: diff.changed.length,
						added: diff.added.length,
						removed: diff.removed.length,
					})}
				</span>
			</p>
			<ul className="ml-3 list-disc">
				{diff.changed.slice(0, MAX_LABELS).map((change) => (
					<li key={`c-${change.before}-${change.after}`}>
						{t("tasks:visualReview.changed")} <code>{change.before}</code> →{" "}
						<code>{change.after}</code>
					</li>
				))}
				{diff.added.slice(0, MAX_LABELS).map((label) => (
					<li key={`a-${label}`}>
						{t("tasks:visualReview.added")} <code>{label}</code>
					</li>
				))}
				{diff.removed.slice(0, MAX_LABELS).map((label) => (
					<li key={`r-${label}`}>
						{t("tasks:visualReview.removed")} <code>{label}</code>
					</li>
				))}
			</ul>
		</div>
	);
}

function MockupRow({ mockup }: { mockup: VisualMockup }) {
	const { t } = useTranslation(["tasks"]);
	return (
		<div className="mb-1">
			<p>
				{t(`tasks:visualReview.mockupKind.${mockup.kind}`)}{" "}
				<span className="font-mono">{mockup.frame}</span>{" "}
				{t("tasks:visualReview.coverage", {
					percent: Math.round((mockup.coverage ?? 0) * 100),
					matched: mockup.matched ?? 0,
					total: mockup.total ?? 0,
				})}
			</p>
			{(mockup.missing ?? []).length > 0 && (
				<p className="ml-3 text-muted-foreground">
					{t("tasks:visualReview.missing")}{" "}
					{(mockup.missing ?? []).slice(0, MAX_LABELS).map((label) => (
						<code key={label} className="mr-1 rounded bg-muted px-1">
							{label}
						</code>
					))}
				</p>
			)}
		</div>
	);
}
