import { AlertTriangle, CheckCircle2, GitMerge, Pencil, Sparkles, Undo2, Wand2 } from "lucide-react";
import type React from "react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RewritePlan, RewriteStep } from "../../../shared/types/git-surgeon";
import { useGitRewriteStore } from "../../stores/git-rewrite-store";
import { CharterButton, Chip, Chips, Notice, Panel, ScanLine, Section, Stat, Stats, type Tone } from "../charter";
import { readabilityOf } from "./conventions";

export const KIND_TONES: Record<RewriteStep["kind"], Tone> = {
	keep: "muted",
	reword: "blue",
	squash: "violet",
	split: "amber",
};

const short = (sha: string) => sha.slice(0, 8);

/** The rewrite of the current branch: plan, before/after, edit, replay on a new branch (#360). */
export function GitRewritePanel({ projectPath }: { readonly projectPath: string }): React.ReactElement {
	const { t } = useTranslation("gitSurgeon");
	const baseId = useId();
	const aiId = useId();
	const phase = useGitRewriteStore((s) => s.phase);
	const plan = useGitRewriteStore((s) => s.plan);
	const steps = useGitRewriteStore((s) => s.steps);
	const result = useGitRewriteStore((s) => s.result);
	const error = useGitRewriteStore((s) => s.error);
	const base = useGitRewriteStore((s) => s.base);
	const ai = useGitRewriteStore((s) => s.ai);
	const { setBase, setAi, makePlan, apply, restore } = useGitRewriteStore.getState();
	const busy = phase === "planning" || phase === "applying";
	const changes = steps.filter((s) => s.kind !== "keep" || plan?.commits.find((c) => c.sha === s.sources[0])?.message !== s.message);

	return (
		<Section kicker={t("rewrite.kicker")} title={t("rewrite.title")} tone="violet">
			<p className="wp-meta mb-3">{t("rewrite.hint")}</p>
			<div className="flex flex-wrap items-center gap-2">
				<label htmlFor={baseId} className="wp-kicker">
					{t("rewrite.base")}
				</label>
				<input
					id={baseId}
					className="h-8 w-56 rounded-md border border-border bg-background px-2 font-mono text-xs"
					value={base}
					placeholder={t("rewrite.basePlaceholder")}
					onChange={(e) => setBase(e.target.value)}
					disabled={busy}
				/>
				<input id={aiId} type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} disabled={busy} />
				<label htmlFor={aiId} className="text-sm">
					{t("rewrite.ai")}
				</label>
				<CharterButton variant="primary" icon={Wand2} onClick={() => makePlan(projectPath)} disabled={busy}>
					{t("rewrite.prepare")}
				</CharterButton>
			</div>
			{phase === "planning" && <ScanLine label={t("rewrite.planning")} />}
			{phase === "applying" && <ScanLine label={t("rewrite.applying")} />}
			{error && (
				<Notice tone="red" icon={AlertTriangle} role="alert">
					{t("rewrite.failed", { error })}
				</Notice>
			)}
			{result && (
				<Notice tone="green" icon={CheckCircle2} role="status">
					{t("rewrite.done", {
						branch: result.branch,
						commits: result.commits,
						source: plan?.branch || short(result.source),
						before: result.before.percent,
						after: result.after.percent,
					})}
				</Notice>
			)}
			{plan && phase !== "planning" && (
				<PlanBody plan={plan} steps={steps}>
					<div className="flex flex-wrap items-center gap-2">
						<CharterButton
							variant="primary"
							icon={GitMerge}
							onClick={() => apply(projectPath)}
							disabled={busy || Boolean(plan.blocked) || changes.length === 0 || phase === "done"}
						>
							{t("rewrite.apply")}
						</CharterButton>
						<CharterButton variant="ghost" icon={Undo2} onClick={restore} disabled={busy}>
							{t("rewrite.restore")}
						</CharterButton>
						<span className="wp-meta">{t("rewrite.applyHint")}</span>
					</div>
				</PlanBody>
			)}
		</Section>
	);
}

function PlanBody({
	plan,
	steps,
	children,
}: {
	readonly plan: RewritePlan;
	readonly steps: RewriteStep[];
	readonly children: React.ReactNode;
}): React.ReactElement {
	const { t } = useTranslation("gitSurgeon");
	const after = readabilityOf(steps, plan);
	return (
		<div className="mt-3 space-y-3">
			<Stats>
				<Stat label={t("rewrite.commitsBefore")} value={plan.commits.length} />
				<Stat label={t("rewrite.commitsAfter")} value={steps.length} tone="violet" />
				<Stat label={t("rewrite.readabilityBefore")} value={`${plan.before.percent} %`} tone="amber" />
				<Stat label={t("rewrite.readabilityAfter")} value={after === null ? "—" : `${after} %`} tone="green" />
			</Stats>
			<p className="wp-meta">
				{t("rewrite.convention", {
					kind: t(`conventions.${plan.convention.kind}`),
					source: t(`conventionSources.${plan.convention.source}`, { defaultValue: plan.convention.source }),
				})}
				{" · "}
				{plan.messagesBy === "model" ? t("rewrite.byModel", { count: plan.modelMessages }) : t("rewrite.byRules")}
			</p>
			{plan.warnings.map((w) => (
				<Notice key={w.code} tone={w.code === "merges" ? "red" : "amber"} icon={AlertTriangle}>
					{t(`warnings.${w.code}`, {
						count: w.count,
						remotes: (w.remotes ?? []).join(", "),
						after: w.after ? short(w.after) : "",
					})}
				</Notice>
			))}
			{!plan.blocked && (
				<div className="grid gap-3 lg:grid-cols-2">
					<Panel>
						<p className="wp-kicker mb-2">{t("rewrite.before", { branch: plan.branch || short(plan.head) })}</p>
						<ol className="flex flex-col gap-1 text-xs">
							{plan.commits.map((c) => (
								<li key={c.sha} className="flex gap-2">
									<span className="wp-mono shrink-0 text-muted-foreground">{short(c.sha)}</span>
									<span className="truncate" title={c.files.join("\n")}>
										{c.subject}
									</span>
								</li>
							))}
						</ol>
					</Panel>
					<Panel>
						<p className="wp-kicker mb-2">{t("rewrite.after")}</p>
						<ol className="flex flex-col gap-2">
							{steps.map((step) => (
								<StepRow key={step.id} step={step} />
							))}
						</ol>
					</Panel>
				</div>
			)}
			{!plan.blocked && children}
		</div>
	);
}

function StepRow({ step }: { readonly step: RewriteStep }): React.ReactElement {
	const { t } = useTranslation("gitSurgeon");
	const [editing, setEditing] = useState(false);
	const editId = useId();
	const { setMessage, keepAsIs } = useGitRewriteStore.getState();
	const subject = step.message.split("\n", 1)[0];
	return (
		<li className="rounded-md border border-border/60 p-2">
			<div className="flex items-start justify-between gap-2">
				<span className="min-w-0 text-sm">
					<span className="block truncate font-medium" title={step.message}>
						{subject}
					</span>
					<span className="wp-meta">
						{step.sources.map(short).join(" + ")}
						{step.paths.length > 0 && ` · ${t("rewrite.files", { count: step.paths.length })}`}
						{step.reason && ` · ${t(`reasons.${step.reason}`)}`}
					</span>
				</span>
				<Chips>
					<Chip tone={KIND_TONES[step.kind]}>{t(`kinds.${step.kind}`)}</Chip>
				</Chips>
			</div>
			{editing && (
				<>
					<label htmlFor={editId} className="sr-only">
						{t("rewrite.message")}
					</label>
					<textarea
						id={editId}
						className="mt-2 h-24 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
						value={step.message}
						onChange={(e) => setMessage(step.id, e.target.value)}
					/>
				</>
			)}
			<div className="mt-1.5 flex gap-1.5">
				<CharterButton size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(!editing)}>
					{editing ? t("rewrite.closeEdit") : t("rewrite.edit")}
				</CharterButton>
				{step.kind !== "keep" && (
					<CharterButton size="sm" variant="ghost" icon={Sparkles} onClick={() => keepAsIs(step.id)}>
						{t("rewrite.keepAsIs")}
					</CharterButton>
				)}
			</div>
		</li>
	);
}
