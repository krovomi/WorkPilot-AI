import { Database, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import {
	checkSchemaGuard,
	fetchSchemaGuard,
	type SchemaFinding,
	type SchemaGuardRecord,
} from "../../lib/agent-tools-api";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export interface SchemaGuardCardProps {
	readonly task: Task;
	/** Absolute project path; the backend derives the spec directory from it. */
	readonly projectPath?: string;
}

type Variant = "success" | "destructive" | "warning" | "outline";

const STATUS_VARIANTS: Record<SchemaGuardRecord["status"], Variant> = {
	pass: "success",
	warn: "warning",
	fail: "destructive",
	unchecked: "outline",
};

/**
 * Le garde-fou des migrations, en une carte.
 *
 * Pendant un déploiement, l'ancien code tourne encore sur le nouveau schéma.
 * La carte dit ce que les migrations de la tâche lui font : perte de données,
 * renommage, colonne NOT NULL sans défaut (erreurs), verrou, changement de type,
 * pas de retour arrière (avertissements), avec la façon zéro-downtime de le
 * faire pour l'outil du projet, et le plan expand → migrate → switch → contract
 * quand une erreur l'exige. Lu dans les fichiers et git, sans modèle ni base.
 *
 * Sans migration dans la tâche, la carte ne s'affiche pas.
 */
export function SchemaGuardCard({ task, projectPath }: SchemaGuardCardProps) {
	const { t } = useTranslation(["tasks"]);
	const [record, setRecord] = useState<SchemaGuardRecord | null>(null);
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const query = useCallback(
		() => ({ projectDir: projectPath, specId: task.specId }),
		[projectPath, task.specId],
	);

	useEffect(() => {
		if (!projectPath || !task.specId) return;
		const controller = new AbortController();
		void fetchSchemaGuard(query(), controller.signal).then((res) => {
			if (res.ok) setRecord(res.data.record);
		});
		return () => controller.abort();
	}, [projectPath, task.specId, query]);

	if (!projectPath || !record || record.migrations.length === 0) return null;

	const recheck = async () => {
		setChecking(true);
		setError(null);
		const res = await checkSchemaGuard(query());
		setChecking(false);
		if (res.ok) setRecord(res.data.record);
		else setError(res.error);
	};

	const findings: SchemaFinding[] = [...record.findings].sort(
		(a, b) => Number(a.severity === "warning") - Number(b.severity === "warning"),
	);

	return (
		<div className="rounded-lg border border-border bg-muted/20 p-3" data-testid="schema-guard-card">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<Database className="h-4 w-4 shrink-0 text-primary" aria-hidden />
						<span className="text-sm font-medium">{t("tasks:schemaGuard.title")}</span>
						<Badge variant={STATUS_VARIANTS[record.status]} className="text-3xs">
							{t(`tasks:schemaGuard.status.${record.status}`)}
						</Badge>
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{t("tasks:schemaGuard.summary", {
							count: record.migrations.length,
							engine: t(`tasks:schemaGuard.engine.${record.engine}`),
						})}
					</p>
				</div>
				<Button size="sm" variant="outline" disabled={checking} onClick={() => void recheck()}>
					{checking && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />}
					{checking ? t("tasks:schemaGuard.checking") : t("tasks:schemaGuard.check")}
				</Button>
			</div>
			{error && (
				<p className="mt-2 text-xs text-destructive" role="alert">
					{error}
				</p>
			)}
			{findings.length > 0 && (
				<ul className="mt-3 grid gap-2">
					{findings.map((f) => (
						<li
							key={`${f.path}:${f.line}:${f.kind}`}
							className="text-xs"
							data-testid="schema-guard-finding"
						>
							<div className="flex flex-wrap items-baseline gap-2">
								<Badge
									variant={f.severity === "error" ? "destructive" : "warning"}
									className="text-3xs"
								>
									{t(`tasks:schemaGuard.kind.${f.kind}`)}
								</Badge>
								<span className="break-all font-mono">{`${f.path}:${f.line}`}</span>
							</div>
							{f.statement && (
								<pre className="mt-1 max-h-24 overflow-auto rounded bg-muted p-2 font-mono text-3xs">
									{f.statement}
								</pre>
							)}
							<p className="mt-0.5 break-words text-muted-foreground">
								{t(`tasks:schemaGuard.advice.${f.kind}`)}
							</p>
						</li>
					))}
				</ul>
			)}
			{record.plan.length > 0 && (
				<div className="mt-3">
					<p className="text-xs font-medium">{t("tasks:schemaGuard.planTitle")}</p>
					<ol className="mt-1 grid list-decimal gap-1 pl-4 text-xs">
						{(["expand", "migrate", "switch", "contract"] as const).map((step) => (
							<li key={step}>{t(`tasks:schemaGuard.plan.${step}`)}</li>
						))}
					</ol>
				</div>
			)}
		</div>
	);
}
