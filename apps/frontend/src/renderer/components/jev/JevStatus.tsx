import {
	CircleAlert,
	CircleCheck,
	CircleSlash,
	KeyRound,
	Loader2,
	ShieldCheck,
	WifiOff,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { JevMode, JevObservation } from "../../../shared/types/jev";
import { parseJevSettings } from "../../../shared/utils/jev-settings";
import { useAirgapStatus } from "../../hooks/useAirgapStatus";
import { cn } from "../../lib/utils";
import { useJevStore } from "../../stores/jev-store";
import { useProjectStore } from "../../stores/project-store";
import { saveSettings, useSettingsStore } from "../../stores/settings-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export type JevReason =
	| "ready"
	| "unknown"
	| "disabled"
	| "workflow_bypass"
	| "offline"
	| "missing_key";

/** The state JEV will be in on the next run of `workflow`. Pure, for tests. */
export function jevReason(args: {
	offline: boolean;
	mode: JevMode;
	enabledGlobally: boolean;
	status: { configured: boolean } | null;
	policyLoaded: boolean;
	hasProject: boolean;
}): JevReason {
	if (args.offline) return "offline";
	if (args.mode === "bypass") return "workflow_bypass";
	if (args.mode !== "enabled" && !args.enabledGlobally) return "disabled";
	if (args.status === null) return "unknown";
	if (!args.status.configured) return "missing_key";
	if (args.hasProject && !args.policyLoaded) return "unknown";
	return "ready";
}

const MODES: readonly JevMode[] = ["inherit", "enabled", "bypass"];

/**
 * JEV (TypeSafe), là où il agit.
 *
 * JEV est un second avis externe et facultatif : il classe une tâche et estime
 * la couverture et le risque d'un diff, avant le planning et la QA d'un build ou
 * d'une revue de PR. Le bloc affichait jusqu'ici une ligne d'état brute
 * (« JEV (TypeSafe): Prêt pour la prochaine exécution (non vérifié) ») et, le
 * cas échéant, des paires clé/valeur — rien sur ce que c'est, rien pour agir.
 *
 * Il dit maintenant :
 *
 * - **ce que c'est**, en une phrase ;
 * - **dans quel état il sera à la prochaine exécution**, avec une pastille ;
 * - **ce qu'il a répondu la dernière fois**, lisible : la classe de tâche, et
 *   couverture / risque sur leur échelle 0–2 plutôt qu'en chiffre nu ;
 * - **ce qu'on peut y faire ici même** : l'activer ou le contourner pour ce
 *   workflow (le réglage par workflow des Réglages, sans y aller), et, quand
 *   il manque, ouvrir la page où se pose la clé API.
 *
 * Deux choses restent hors de portée du bouton, volontairement : la clé API
 * (un secret se saisit dans les Réglages, stockage sécurisé) et le mode
 * hors-ligne strict, qui gagne toujours — un bouton qui l'ignorerait mentirait.
 */
export function JevStatus({
	workflow,
	offline = false,
	observation,
	projectId,
}: {
	workflow: string;
	projectId?: string;
	offline?: boolean;
	observation?: JevObservation | null;
}) {
	const { t } = useTranslation("settings");
	const path = useProjectStore(
		(s) => s.projects.find((p) => p.id === projectId)?.path,
	);
	const policy = useAirgapStatus(path);
	const config = useSettingsStore((s) => s.settings.jev);
	const { status, refresh } = useJevStore();
	const [saving, setSaving] = useState<JevMode | null>(null);
	const [saveError, setSaveError] = useState(false);

	useEffect(() => {
		void refresh();
		const onFocus = () => void refresh();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);

	const mode: JevMode = config?.workflows?.[workflow] ?? "inherit";
	const isOffline = offline || policy.airgapStrict;
	const reason = jevReason({
		offline: isOffline,
		mode,
		enabledGlobally: Boolean(config?.enabled),
		status,
		policyLoaded: policy.loaded,
		hasProject: Boolean(projectId),
	});
	const latest = observation?.evaluations.at(-1);

	async function setMode(next: JevMode) {
		if (next === mode || saving) return;
		setSaving(next);
		setSaveError(false);
		try {
			const jev = parseJevSettings({
				...(config ?? { enabled: false }),
				workflows: { ...(config?.workflows ?? {}), [workflow]: next },
			});
			const ok = await saveSettings({ jev });
			if (!ok) setSaveError(true);
		} catch {
			setSaveError(true);
		} finally {
			setSaving(null);
		}
	}

	const openSettings = () =>
		globalThis.dispatchEvent(new CustomEvent("open-app-settings", { detail: "jev" }));

	const pill = PILL[reason];
	const workflowName = t(`jev.workflowNames.${workflow}`, { defaultValue: workflow });

	return (
		<section
			aria-label={t("jev.title")}
			className="overflow-hidden rounded-xl border border-border bg-card/60 shadow-sm"
		>
			<div className="flex items-start justify-between gap-3 p-4 pb-3">
				<div className="flex min-w-0 items-start gap-3">
					<span className="rounded-lg bg-sky-500/10 p-2 text-sky-500">
						<ShieldCheck className="h-4 w-4" aria-hidden />
					</span>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="text-sm font-semibold">{t("jev.card.title")}</h3>
							<Badge variant={pill.variant} className="gap-1 text-[10px]">
								<pill.icon className="h-2.5 w-2.5" aria-hidden />
								{t(`jev.card.state.${reason}`)}
							</Badge>
						</div>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{t("jev.card.subtitle")}
						</p>
					</div>
				</div>
			</div>

			{/* Ce qu'il a répondu la dernière fois */}
			{latest?.status === "evaluated" && latest.answers && (
				<div className="px-4">
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
						{Object.entries(latest.answers).map(([name, answer]) => (
							<AnswerTile
								key={name}
								name={name}
								value={answer.value}
								confidence={answer.confidence}
							/>
						))}
					</div>
					<p className="mt-1.5 text-[11px] text-muted-foreground">
						{t("jev.card.historyNote", { revision: latest.revision.slice(0, 12) })}
					</p>
				</div>
			)}
			{latest && latest.status !== "evaluated" && (
				<p className="mx-4 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
					{t("jev.card.lastBypassed", {
						reason: t(`jev.reasons.${latest.reason}`, {
							defaultValue: t("jev.reasons.unavailable"),
						}),
					})}
				</p>
			)}
			{!latest && reason === "ready" && (
				<p className="mx-4 text-xs text-muted-foreground">{t("jev.card.noRunYet")}</p>
			)}

			{/* Ce qu'on peut y faire ici même */}
			<div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 bg-muted/20 px-4 py-2.5">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<span className="text-xs text-muted-foreground">
						{t("jev.card.forWorkflow", { workflow: workflowName })}
					</span>
					<fieldset
						className="inline-flex rounded-lg border border-border bg-background p-0.5"
						disabled={isOffline}
					>
						<legend className="sr-only">
							{t("jev.card.forWorkflow", { workflow: workflowName })}
						</legend>
						{MODES.map((m) => (
							<button
								key={m}
								type="button"
								aria-pressed={mode === m}
								onClick={() => void setMode(m)}
								className={cn(
									"inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors",
									mode === m
										? "bg-primary text-primary-foreground shadow-sm"
										: "text-muted-foreground hover:bg-muted hover:text-foreground",
									isOffline && "cursor-not-allowed opacity-60",
								)}
							>
								{saving === m && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
								{t(`jev.card.modes.${m}`)}
							</button>
						))}
					</fieldset>
				</div>
				{reason === "missing_key" && (
					<Button size="sm" className="h-7 gap-1" onClick={openSettings}>
						<KeyRound className="h-3 w-3" aria-hidden />
						{t("jev.card.addKey")}
					</Button>
				)}
				{reason !== "missing_key" && (
					<Button size="sm" variant="ghost" className="h-7" onClick={openSettings}>
						{t("jev.card.settings")}
					</Button>
				)}
			</div>
			{isOffline && (
				<p className="flex items-center gap-1.5 px-4 pb-2.5 text-[11px] text-muted-foreground">
					<WifiOff className="h-3 w-3" aria-hidden />
					{t("jev.card.offlineHint")}
				</p>
			)}
			{saveError && (
				<p className="px-4 pb-2.5 text-[11px] text-destructive" role="alert">
					{t("jev.error")}
				</p>
			)}
		</section>
	);
}

const PILL: Record<
	JevReason,
	{
		variant: "success" | "warning" | "muted" | "info";
		icon: typeof CircleCheck;
	}
> = {
	ready: { variant: "success", icon: CircleCheck },
	unknown: { variant: "muted", icon: CircleAlert },
	disabled: { variant: "muted", icon: CircleSlash },
	workflow_bypass: { variant: "muted", icon: CircleSlash },
	offline: { variant: "info", icon: WifiOff },
	missing_key: { variant: "warning", icon: KeyRound },
};

/** Couverture et risque sont notés 0–2 par JEV : une jauge se lit, un chiffre non. */
const SCALED = new Set(["coverage", "risk"]);

function AnswerTile({
	name,
	value,
	confidence,
}: {
	readonly name: string;
	readonly value: string | number;
	readonly confidence?: number;
}) {
	const { t } = useTranslation("settings");
	const numeric = typeof value === "number" ? value : Number(value);
	const scaled = SCALED.has(name) && Number.isFinite(numeric);
	const level = scaled ? Math.max(0, Math.min(2, Math.round(numeric))) : 0;
	// Plus de couverture est mieux, plus de risque est pire.
	const good = name === "coverage" ? level : 2 - level;
	const color = good >= 2 ? "bg-success" : good === 1 ? "bg-warning" : "bg-destructive";

	return (
		<div className="rounded-lg border border-border/70 bg-background/40 px-3 py-2">
			<div className="text-[11px] text-muted-foreground">
				{t(`jev.answers.${name}`, { defaultValue: name })}
			</div>
			{scaled ? (
				<>
					<div className="mt-1 flex items-center gap-1" aria-hidden>
						{[0, 1, 2].map((i) => (
							<span
								key={i}
								className={cn(
									"h-1.5 flex-1 rounded-full",
									i <= level ? color : "bg-muted",
								)}
							/>
						))}
					</div>
					<div className="mt-1 text-sm font-medium">
						{t(`jev.card.scale.${name}.${level}`)}
					</div>
				</>
			) : (
				<div className="mt-0.5 truncate text-sm font-medium">{String(value)}</div>
			)}
			{confidence !== undefined && (
				<div className="text-[10px] text-muted-foreground">
					{t("jev.confidence", { value: Math.round(confidence * 100) })}
				</div>
			)}
		</div>
	);
}
