import { Palette } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import {
	fetchUiUxTask,
	setUiUxOverride,
	type UiUxOverride,
	type UiUxTaskPayload,
} from "../../lib/agent-tools-api";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export interface UiUxDesignCardProps {
	readonly task: Task;
	/** Absolute project path; the server derives the spec directory from it. */
	readonly projectPath?: string;
}

/** The roles a person recognises at a glance; the rest are in MASTER.md. */
const SWATCH_ROLES = [
	"primary",
	"secondary",
	"accent/cta",
	"background",
	"foreground",
	"muted",
	"border",
	"destructive",
];

/**
 * Le design system d'une tâche qui touche l'interface (ui-ux-pro-max).
 *
 * La carte dit trois choses : si la tâche est jugée « UI » et pourquoi (les
 * fichiers du plan, la description, ou une décision de la personne), quel
 * design system le coder va recevoir — celui du projet ou un nouveau, écrit
 * dans le worktree —, et quel guide de stack s'y ajoute.
 *
 * **Elle ne s'affiche que sur une tâche UI**, ou quand une personne l'a
 * écartée et doit pouvoir revenir sur ce choix. Une tâche backend n'a ni
 * section de prompt, ni outil, ni carte : c'est tout l'intérêt de décider la
 * pertinence une seule fois, côté serveur.
 *
 * Il n'y a pas de bouton « générer maintenant » : le design system est écrit
 * dans un worktree qu'une personne relit, et le panneau n'en a pas.
 */
export function UiUxDesignCard({ task, projectPath }: UiUxDesignCardProps) {
	const { t } = useTranslation(["tasks"]);
	const [data, setData] = useState<UiUxTaskPayload | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!projectPath) return;
		const controller = new AbortController();
		void fetchUiUxTask(
			{ specDir: task.specsPath, projectDir: projectPath, specId: task.specId },
			controller.signal,
		).then((res) => {
			if (res.ok) setData(res.data);
		});
		return () => controller.abort();
	}, [task.specsPath, task.specId, projectPath]);

	const override = useCallback(
		async (mode: UiUxOverride) => {
			setBusy(true);
			setError(null);
			const res = await setUiUxOverride(
				{ specDir: task.specsPath, projectDir: projectPath, specId: task.specId },
				mode,
			);
			setBusy(false);
			if (res.ok) setData(res.data);
			else setError(res.error);
		},
		[task.specsPath, task.specId, projectPath],
	);

	if (!projectPath || !data) return null;

	const relevance = data.record?.relevance ?? data.forecast;
	if (!relevance) return null;
	const mode = relevance.override ?? "auto";
	// Nothing to say on a task that is not about the interface — unless a
	// person set it aside and needs the way back.
	if (relevance.verdict !== "ui" && mode === "auto") return null;

	const record = data.record;
	const state = !data.installed
		? "notInstalled"
		: mode === "skip"
			? "skipped"
			: record
				? record.status === "ready" || record.status === "withheld"
					? record.status
					: record.status === "skipped"
						? "skipped"
						: "failed"
				: "planned";

	const swatches = (data.design?.colors ?? []).filter((c) =>
		SWATCH_ROLES.includes(c.role.toLowerCase()),
	);

	return (
		<div className="rounded-lg border border-violet-500/40 bg-violet-500/5 p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<Palette className="h-4 w-4 shrink-0 text-violet-500" aria-hidden />
						<span className="text-sm font-medium">{t("tasks:uiux.title")}</span>
						<Badge variant="outline" className="text-[10px]">
							{t(`tasks:uiux.state.${state}`)}
						</Badge>
						{record?.guide && (
							<Badge variant="outline" className="text-[10px]">
								{t("tasks:uiux.guide", { guide: record.guide })}
							</Badge>
						)}
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{t(`tasks:uiux.reason.${relevance.reason}`, {
							defaultValue: t("tasks:uiux.reason.unknown"),
							detail: relevance.detail,
						})}
					</p>
				</div>
				{mode === "auto" ? (
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={() => void override("skip")}
					>
						{t("tasks:uiux.actions.skip")}
					</Button>
				) : (
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={() => void override("auto")}
					>
						{t("tasks:uiux.actions.auto")}
					</Button>
				)}
			</div>

			{!data.installed && data.reason && (
				<p className="mt-2 text-xs text-muted-foreground">{data.reason}</p>
			)}

			{record?.masterPath && mode !== "skip" && (
				<p className="mt-2 text-xs text-muted-foreground">
					{t(
						record.source === "project"
							? "tasks:uiux.master.project"
							: "tasks:uiux.master.generated",
						{ path: record.masterPath },
					)}
				</p>
			)}

			{record?.status === "withheld" && (
				<p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
					{t("tasks:uiux.withheld")}
				</p>
			)}

			{mode !== "skip" && swatches.length > 0 && (
				<div className="mt-3 flex flex-wrap gap-2">
					{swatches.map((c) => (
						<div key={c.role} className="flex items-center gap-1.5">
							<span
								className="h-4 w-4 rounded border border-border"
								style={{ backgroundColor: c.hex }}
								aria-hidden
							/>
							<span className="text-[11px] text-muted-foreground">
								{c.role} <code>{c.hex}</code>
							</span>
						</div>
					))}
				</div>
			)}

			{mode !== "skip" && (data.design?.heading || data.design?.style) && (
				<p className="mt-2 text-xs text-muted-foreground">
					{[
						data.design?.style &&
							t("tasks:uiux.style", { style: data.design.style }),
						data.design?.heading &&
							t("tasks:uiux.fonts", {
								heading: data.design.heading,
								body: data.design.body ?? data.design.heading,
							}),
					]
						.filter(Boolean)
						.join(" · ")}
				</p>
			)}

			{error && <p className="mt-2 text-xs text-destructive">{error}</p>}
		</div>
	);
}
