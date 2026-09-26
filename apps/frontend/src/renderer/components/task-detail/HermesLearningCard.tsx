import {
	ArrowRight,
	Brain,
	BrainCircuit,
	Check,
	ChevronDown,
	ChevronRight,
	CircleAlert,
	CircleCheck,
	Filter,
	Inbox,
	Loader2,
	RefreshCw,
	Sparkles,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import type { HermesCandidate } from "../../lib/agent-tools-api";
import { cn } from "../../lib/utils";
import { useHermesStore } from "../../stores/hermes-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

export interface HermesLearningCardProps {
	/** La tâche ouverte : un skill gardé depuis ce panneau est rattaché à sa note de build dans le cerveau. */
	readonly task?: Task;
	readonly projectPath?: string;
}

/** Au-delà, la liste se replie : trente lignes d'un coup ne se lisent pas. */
const VISIBLE_CANDIDATES = 6;

/**
 * La boucle d'apprentissage hermes-agent, vue depuis le Kanban — et ce qu'on y
 * décide.
 *
 * hermes tourne là où WorkPilot ne regarde pas — Telegram, une tâche cron, un
 * terminal — et y écrit des skills tirés de sa propre expérience. La carte
 * affichait jusqu'ici ce qu'il avait déposé sous forme de chemins de fichiers,
 * sans rien pour en faire : trente-quatre lignes `skills/_proposed/…` et la
 * question « qu'est-ce que je dois faire de tout ça ? ».
 *
 * Elle est désormais une **boîte de réception** :
 *
 * - le parcours d'un skill est dessiné en quatre étapes — hermes apprend, le
 *   dépôt trie seul, vous tranchez, le cerveau partagé retient — avec le
 *   chiffre de chacune, pour qu'on voie où l'on en est d'un coup d'œil ;
 * - une phrase dit **ce qu'il y a à faire**, et seulement ça : trancher N
 *   skills, régler une condition, ou rien ;
 * - chaque candidat porte son objet, sa catégorie, un aperçu de la procédure,
 *   et deux boutons : **Garder** (adopté dans `skills/hermes-learned/` et versé
 *   au cerveau, rattaché à cette tâche) ou **Refuser** (jamais reproposé). Une
 *   sélection permet de trancher par lot ;
 * - la boucle est **automatique** : elle tourne à la fin de chaque build et à
 *   l'ouverture du panneau (au plus un passage par quart d'heure). Le bouton
 *   Actualiser n'est plus qu'un raccourci.
 *
 * Ce qu'elle ne fait toujours pas : **activer**. Garder n'est pas charger — le
 * pack n'est pas listé dans `.workpilot/skills.toml`, et la note du cerveau est
 * une connaissance, pas une instruction. Ni **accorder la confiance** : la
 * commande `hermes skills trust` est affichée, la personne la tape.
 *
 * Elle ne s'affiche pas quand hermes n'est pas installé : une carte permanente
 * qui dit « fonctionnalité non utilisée » est une carte que personne ne lit.
 */
export function HermesLearningCard({ task, projectPath }: HermesLearningCardProps) {
	const { t } = useTranslation(["hermes"]);
	const [selected, setSelected] = useState<readonly string[]>([]);
	const [showAll, setShowAll] = useState(false);
	const [showDetails, setShowDetails] = useState(false);
	const selectAllId = useId();

	const status = useHermesStore((s) => s.status);
	const lastCycle = useHermesStore((s) => s.lastCycle);
	const lastReview = useHermesStore((s) => s.lastReview);
	const running = useHermesStore((s) => s.running);
	const deciding = useHermesStore((s) => s.deciding);
	const error = useHermesStore((s) => s.error);
	const load = useHermesStore((s) => s.load);
	const runCycle = useHermesStore((s) => s.runCycle);
	const autoCycle = useHermesStore((s) => s.autoCycle);
	const review = useHermesStore((s) => s.review);
	const installSoul = useHermesStore((s) => s.installSoul);

	useEffect(() => {
		void load().then(() => autoCycle("kanban"));
	}, [load, autoCycle]);

	const candidates: readonly HermesCandidate[] = useMemo(() => {
		if (!status) return [];
		if (status.candidates) return status.candidates;
		// Un backend plus ancien n'envoie que les noms de fichiers.
		return status.pending.map((file) => ({
			file,
			name: file.replace(/^hermes--/, "").replace(/\.md$/, ""),
			description: "",
			category: "",
			pendingInHermes: false,
			surface: "build",
			tools: [],
			excerpt: "",
			lines: 0,
		}));
	}, [status]);

	// Une sélection qui survit à la décision viserait des fichiers disparus.
	useEffect(() => {
		setSelected((prev) => prev.filter((f) => candidates.some((c) => c.file === f)));
	}, [candidates]);

	if (!status?.readiness.installed) return null;

	const { readiness, soul } = status;
	const unmet = readiness.checks.filter((c) => !c.ok);
	const blocking = unmet.filter((c) => c.required);
	const soulMissing = soul.offered && !soul.installed;
	const adopted = status.adopted ?? [];
	const adoptedPack = status.adoptedPack || "hermes-learned";
	const brain = status.brain;
	const dropped = Object.entries(lastCycle?.ingest?.dropped ?? {}).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	const droppedTotal =
		(lastCycle?.ingest?.droppedTotal ?? 0) +
		(lastCycle?.ingest?.pruned ?? 0) +
		(status.stale ?? 0);

	const taskContext = { projectDir: projectPath, specId: task?.specId };
	const decide = (files: readonly string[], decision: "adopt" | "decline") =>
		void review(files, decision, taskContext);

	const visible = showAll ? candidates : candidates.slice(0, VISIBLE_CANDIDATES);
	const allSelected = candidates.length > 0 && selected.length === candidates.length;
	const someSelected = selected.length > 0 && !allSelected;

	const tone: "action" | "setup" | "calm" =
		candidates.length > 0 ? "action" : blocking.length > 0 ? "setup" : "calm";

	return (
		<section
			aria-labelledby="hermes-card-title"
			className="overflow-hidden rounded-xl border border-border bg-card/60 shadow-sm"
		>
			{/* En-tête */}
			<div className="flex items-start justify-between gap-3 p-4 pb-3">
				<div className="flex min-w-0 items-start gap-3">
					<span className="rounded-lg bg-violet-500/10 p-2 text-violet-500">
						<BrainCircuit className="h-4 w-4" aria-hidden />
					</span>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<h3 id="hermes-card-title" className="text-sm font-semibold">
								{t("hermes:title")}
							</h3>
							<Badge
								variant={readiness.state === "ready" ? "success" : "warning"}
								className="text-[10px]"
							>
								{t(`hermes:state.${readiness.state}`)}
							</Badge>
							<Badge variant="muted" className="gap-1 text-[10px]">
								<RefreshCw className="h-2.5 w-2.5" aria-hidden />
								{t("hermes:auto.badge")}
							</Badge>
						</div>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{t("hermes:subtitle")}
						</p>
					</div>
				</div>
				<Button
					size="sm"
					variant="ghost"
					className="shrink-0 gap-1.5"
					disabled={running}
					onClick={() => void runCycle("kanban")}
					title={t("hermes:auto.tooltip")}
				>
					{running ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
					) : (
						<RefreshCw className="h-3.5 w-3.5" aria-hidden />
					)}
					{running ? t("hermes:cycle.running") : t("hermes:cycle.run")}
				</Button>
			</div>

			{/* Le parcours d'un skill, en quatre étapes */}
			<ol className="mx-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
				<PipelineStep
					icon={<BrainCircuit className="h-3.5 w-3.5" aria-hidden />}
					label={t("hermes:pipeline.learn")}
					value={lastCycle?.ingest?.found ?? "—"}
					hint={t("hermes:pipeline.learnHint")}
				/>
				<PipelineStep
					icon={<Filter className="h-3.5 w-3.5" aria-hidden />}
					label={t("hermes:pipeline.triage")}
					value={droppedTotal}
					hint={t("hermes:pipeline.triageHint")}
				/>
				<PipelineStep
					icon={<Inbox className="h-3.5 w-3.5" aria-hidden />}
					label={t("hermes:pipeline.decide")}
					value={candidates.length}
					hint={t("hermes:pipeline.decideHint")}
					highlight={candidates.length > 0}
				/>
				<PipelineStep
					icon={<Brain className="h-3.5 w-3.5" aria-hidden />}
					label={t("hermes:pipeline.brain")}
					value={brain?.active ? brain.notes : "—"}
					hint={
						brain?.active
							? t("hermes:pipeline.brainHint")
							: t("hermes:pipeline.brainOff")
					}
					last
				/>
			</ol>

			{/* Ce qu'il y a à faire, et seulement ça */}
			<div
				role="status"
				className={cn(
					"mx-4 mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
					tone === "action" && "border-warning/40 bg-warning/10",
					tone === "setup" && "border-destructive/40 bg-destructive/10",
					tone === "calm" && "border-success/30 bg-success/10",
				)}
			>
				{tone === "calm" ? (
					<CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
				) : (
					<CircleAlert
						className={cn(
							"mt-0.5 h-3.5 w-3.5 shrink-0",
							tone === "action" ? "text-warning" : "text-destructive",
						)}
						aria-hidden
					/>
				)}
				<div className="min-w-0">
					<p className="font-medium text-foreground">
						{tone === "action"
							? t("hermes:next.decide", { count: candidates.length })
							: tone === "setup"
								? t("hermes:next.setup")
								: t("hermes:next.nothing")}
					</p>
					<p className="mt-0.5 text-muted-foreground">
						{tone === "action"
							? t("hermes:next.decideHint")
							: tone === "setup"
								? t("hermes:next.setupHint")
								: t("hermes:next.nothingHint")}
					</p>
				</div>
			</div>

			{lastReview && (lastReview.adopted.length > 0 || lastReview.declined.length > 0) && (
				<p className="mx-4 mt-2 text-xs text-muted-foreground" aria-live="polite">
					{lastReview.decision === "adopt"
						? lastReview.brainNotes.length > 0
							? t("hermes:review.adoptedToBrain", { count: lastReview.adopted.length })
							: t("hermes:review.adopted", {
									count: lastReview.adopted.length,
									pack: adoptedPack,
								})
						: t("hermes:review.declined", { count: lastReview.declined.length })}
				</p>
			)}
			{error && (
				<p className="mx-4 mt-2 text-xs text-destructive" role="alert">
					{error}
				</p>
			)}

			{/* Conditions bloquantes : la remédiation d'abord */}
			{blocking.length > 0 && (
				<ul className="mx-4 mt-3 space-y-1.5">
					{blocking.map((check) => (
						<CheckRow key={check.name} check={check} />
					))}
				</ul>
			)}

			{/* La boîte de réception */}
			{candidates.length > 0 && (
				<div className="mt-3 border-t border-border/60">
					<div className="flex flex-wrap items-center justify-between gap-2 bg-muted/30 px-4 py-2">
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<Checkbox
								id={selectAllId}
								checked={allSelected ? true : someSelected ? "indeterminate" : false}
								onCheckedChange={(value) =>
									setSelected(value ? candidates.map((c) => c.file) : [])
								}
							/>
							<label htmlFor={selectAllId} className="cursor-pointer">
								{selected.length > 0
									? t("hermes:review.selected", { count: selected.length })
									: t("hermes:review.selectAll")}
							</label>
						</div>
						<div className="flex items-center gap-1.5">
							<Button
								size="sm"
								variant="outline"
								className="h-7 gap-1 border-success/40 text-success hover:bg-success/10"
								disabled={selected.length === 0}
								onClick={() => decide(selected, "adopt")}
							>
								<Check className="h-3 w-3" aria-hidden />
								{t("hermes:review.keepSelected")}
							</Button>
							<Button
								size="sm"
								variant="outline"
								className="h-7 gap-1 border-destructive/40 text-destructive hover:bg-destructive/10"
								disabled={selected.length === 0}
								onClick={() => decide(selected, "decline")}
							>
								<X className="h-3 w-3" aria-hidden />
								{t("hermes:review.declineSelected")}
							</Button>
						</div>
					</div>
					<ul className="divide-y divide-border/60">
						{visible.map((candidate) => (
							<CandidateRow
								key={candidate.file}
								candidate={candidate}
								selected={selected.includes(candidate.file)}
								busy={deciding.includes(candidate.file)}
								onSelect={(on) =>
									setSelected((prev) =>
										on
											? [...prev, candidate.file]
											: prev.filter((f) => f !== candidate.file),
									)
								}
								onDecide={(decision) => decide([candidate.file], decision)}
								brainActive={Boolean(brain?.active)}
							/>
						))}
					</ul>
					{candidates.length > VISIBLE_CANDIDATES && (
						<button
							type="button"
							onClick={() => setShowAll((v) => !v)}
							className="w-full border-t border-border/60 px-4 py-2 text-center text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
						>
							{showAll
								? t("hermes:review.showLess")
								: t("hermes:review.showMore", {
										count: candidates.length - VISIBLE_CANDIDATES,
									})}
						</button>
					)}
				</div>
			)}

			{/* Comment ça marche — replié */}
			<div className="mt-3 border-t border-border/60">
				<button
					type="button"
					onClick={() => setShowDetails((v) => !v)}
					aria-expanded={showDetails}
					className="flex w-full items-center gap-1.5 px-4 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					{showDetails ? (
						<ChevronDown className="h-3 w-3" aria-hidden />
					) : (
						<ChevronRight className="h-3 w-3" aria-hidden />
					)}
					{t("hermes:details.toggle")}
					<span className="ml-auto flex items-center gap-2">
						<span>
							{t("hermes:details.checks", {
								ok: readiness.checks.length - unmet.length,
								total: readiness.checks.length,
							})}
						</span>
						{adopted.length > 0 && (
							<span>· {t("hermes:details.kept", { count: adopted.length })}</span>
						)}
					</span>
				</button>

				{showDetails && (
					<div className="space-y-4 px-4 pb-4 text-xs">
						<BrainLinkPanel brain={brain} />

						<section>
							<h4 className="font-medium">{t("hermes:checks.title")}</h4>
							<ul className="mt-1.5 space-y-1.5">
								{readiness.checks.map((check) => (
									<CheckRow key={check.name} check={check} />
								))}
							</ul>
						</section>

						{soulMissing && (
							<section>
								<h4 className="font-medium">{t("hermes:soul.title")}</h4>
								<p className="mt-1 text-muted-foreground">
									{t("hermes:soul.description")}
								</p>
								<Button
									size="sm"
									variant="outline"
									className="mt-2"
									disabled={running}
									onClick={() => void installSoul(soul.state === "diverged")}
								>
									<Sparkles className="mr-1 h-3 w-3" aria-hidden />
									{soul.state === "diverged"
										? t("hermes:soul.replace")
										: t("hermes:soul.install")}
								</Button>
							</section>
						)}

						{adopted.length > 0 && (
							<section>
								<h4 className="font-medium">{t("hermes:adopted.title")}</h4>
								<p className="mt-1 text-muted-foreground">
									{t("hermes:adopted.description", { pack: adoptedPack })}
								</p>
								<div className="mt-1.5 flex flex-wrap gap-1">
									{adopted.map((name) => (
										<Badge key={name} variant="muted" className="font-mono text-[10px]">
											{name}
										</Badge>
									))}
								</div>
							</section>
						)}

						{dropped.length > 0 && (
							<section>
								<h4 className="font-medium">{t("hermes:triage.title")}</h4>
								<p className="mt-1 text-muted-foreground">
									{t("hermes:triage.description")}
								</p>
								<ul className="mt-1 space-y-0.5 text-muted-foreground">
									{dropped.map(([reason, count]) => (
										<li key={reason}>
											{count} × {t(`hermes:triage.reason.${reason}`, reason)}
										</li>
									))}
								</ul>
							</section>
						)}

						{(status.declined ?? 0) > 0 && (
							<p className="text-muted-foreground">
								{t("hermes:details.declined", { count: status.declined })}
							</p>
						)}
					</div>
				)}
			</div>
		</section>
	);
}

function PipelineStep({
	icon,
	label,
	value,
	hint,
	highlight = false,
	last = false,
}: {
	readonly icon: ReactNode;
	readonly label: string;
	readonly value: number | string;
	readonly hint: string;
	readonly highlight?: boolean;
	readonly last?: boolean;
}) {
	return (
		<li
			className={cn(
				"relative rounded-lg border px-2.5 py-2",
				highlight
					? "border-warning/50 bg-warning/10"
					: "border-border/70 bg-background/40",
			)}
			title={hint}
		>
			<div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
				{icon}
				<span className="truncate">{label}</span>
			</div>
			<div
				className={cn(
					"mt-0.5 text-lg font-semibold tabular-nums leading-tight",
					highlight && "text-warning",
				)}
			>
				{value}
			</div>
			{!last && (
				<ArrowRight
					className="absolute -right-2 top-1/2 hidden h-3 w-3 -translate-y-1/2 text-muted-foreground/60 sm:block"
					aria-hidden
				/>
			)}
		</li>
	);
}

function CandidateRow({
	candidate,
	selected,
	busy,
	onSelect,
	onDecide,
	brainActive,
}: {
	readonly candidate: HermesCandidate;
	readonly selected: boolean;
	readonly busy: boolean;
	readonly onSelect: (on: boolean) => void;
	readonly onDecide: (decision: "adopt" | "decline") => void;
	readonly brainActive: boolean;
}) {
	const { t } = useTranslation(["hermes"]);
	const [open, setOpen] = useState(false);
	const title = candidate.name.replace(/[-_]+/g, " ");

	return (
		<li className={cn("px-4 py-2.5 transition-colors", selected && "bg-primary/5")}>
			<div className="flex items-start gap-3">
				<Checkbox
					className="mt-0.5"
					checked={selected}
					disabled={busy}
					onCheckedChange={(value) => onSelect(Boolean(value))}
					aria-label={t("hermes:review.select", { name: candidate.name })}
				/>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="text-sm font-medium capitalize">{title}</span>
						{candidate.category && (
							<Badge variant="muted" className="text-[10px]">
								{candidate.category}
							</Badge>
						)}
						{candidate.pendingInHermes && (
							<Badge variant="info" className="text-[10px]">
								{t("hermes:review.pendingInHermes")}
							</Badge>
						)}
					</div>
					{candidate.description && (
						<p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
							{candidate.description}
						</p>
					)}
					{candidate.excerpt && (
						<button
							type="button"
							onClick={() => setOpen((v) => !v)}
							aria-expanded={open}
							className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
						>
							{open ? (
								<ChevronDown className="h-3 w-3" aria-hidden />
							) : (
								<ChevronRight className="h-3 w-3" aria-hidden />
							)}
							{t("hermes:review.preview", { count: candidate.lines })}
						</button>
					)}
					{open && (
						<div className="mt-1.5 space-y-1.5">
							<pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
								{candidate.excerpt}
							</pre>
							{candidate.tools.length > 0 && (
								<p className="text-[11px] text-muted-foreground">
									{t("hermes:review.tools")}{" "}
									{candidate.tools.map((tool) => (
										<code key={tool} className="mr-1 rounded bg-muted px-1 py-0.5">
											{tool}
										</code>
									))}
								</p>
							)}
						</div>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{busy ? (
						<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
					) : (
						<>
							<Button
								size="sm"
								variant="ghost"
								className="h-7 gap-1 px-2 text-success hover:bg-success/10 hover:text-success"
								onClick={() => onDecide("adopt")}
								title={
									brainActive
										? t("hermes:review.keepTooltipBrain")
										: t("hermes:review.keepTooltip")
								}
							>
								<Check className="h-3.5 w-3.5" aria-hidden />
								{t("hermes:review.keep")}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="h-7 gap-1 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
								onClick={() => onDecide("decline")}
								title={t("hermes:review.declineTooltip")}
							>
								<X className="h-3.5 w-3.5" aria-hidden />
								{t("hermes:review.decline")}
							</Button>
						</>
					)}
				</div>
			</div>
		</li>
	);
}

function CheckRow({
	check,
}: {
	readonly check: { name: string; ok: boolean; detail: string; remedy: string };
}) {
	const { t } = useTranslation(["hermes"]);
	return (
		<li className="flex items-start gap-2 text-xs text-muted-foreground">
			{check.ok ? (
				<CircleCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-hidden />
			) : (
				<CircleAlert className="mt-0.5 h-3 w-3 shrink-0 text-warning" aria-hidden />
			)}
			<span className="min-w-0">
				<span className="font-medium text-foreground">
					{t(`hermes:checks.${check.name}`, check.name)}
				</span>
				<span className="ml-1">{check.detail}</span>
				{!check.ok && check.remedy && (
					<code className="mt-1 block break-all rounded bg-muted px-1.5 py-0.5 text-[10px]">
						{check.remedy}
					</code>
				)}
			</span>
		</li>
	);
}

function BrainLinkPanel({
	brain,
}: {
	readonly brain?: {
		active: boolean;
		notes: number;
		hermesConnected: boolean;
	};
}) {
	const { t } = useTranslation(["hermes"]);
	const openBrainSettings = () =>
		globalThis.dispatchEvent(
			new CustomEvent("open-app-settings", { detail: "brain" }),
		);
	return (
		<section className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
			<h4 className="flex items-center gap-1.5 font-medium">
				<Brain className="h-3.5 w-3.5 text-violet-500" aria-hidden />
				{t("hermes:brain.title")}
			</h4>
			<p className="mt-1 text-muted-foreground">{t("hermes:brain.description")}</p>
			<ul className="mt-2 space-y-1">
				<li className="flex items-center gap-2">
					{brain?.active ? (
						<CircleCheck className="h-3 w-3 text-success" aria-hidden />
					) : (
						<CircleAlert className="h-3 w-3 text-warning" aria-hidden />
					)}
					{brain?.active
						? t("hermes:brain.feeding", { count: brain.notes })
						: t("hermes:brain.off")}
				</li>
				{brain?.active && (
					<li className="flex items-center gap-2">
						{brain.hermesConnected ? (
							<CircleCheck className="h-3 w-3 text-success" aria-hidden />
						) : (
							<CircleAlert className="h-3 w-3 text-warning" aria-hidden />
						)}
						{brain.hermesConnected
							? t("hermes:brain.readsBack")
							: t("hermes:brain.notReadingBack")}
					</li>
				)}
			</ul>
			{(!brain?.active || !brain.hermesConnected) && (
				<Button
					size="sm"
					variant="outline"
					className="mt-2 h-7"
					onClick={openBrainSettings}
				>
					{t("hermes:brain.openSettings")}
				</Button>
			)}
		</section>
	);
}
