import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	type VerifyDifference,
	type VerifyRecord,
	verifyScreenshotUrl,
} from "../../lib/agent-tools-api";
import { useVerifyStore } from "../../stores/verify-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/** Ce qui se lit comme un recul : à montrer en premier, en rouge. */
const WORSE = new Set<VerifyDifference["change"]>(["broken"]);

/** Les indices de captures qui appartiennent à la comparaison, pour ne pas les montrer deux fois. */
export function compareShotIndices(record: VerifyRecord): Set<number> {
	const shots = record.compare?.screenshots;
	return new Set(
		[shots?.base, shots?.task].filter((i): i is number => typeof i === "number"),
	);
}

/** Les écarts dans l'ordre où on les relit : ce qui a cassé, puis le reste par type. */
export function orderedDifferences(differences: VerifyDifference[]): VerifyDifference[] {
	const kinds = ["scenario", "endpoint", "network", "console"];
	return [...differences].sort(
		(a, b) =>
			Number(WORSE.has(b.change)) - Number(WORSE.has(a.change)) ||
			kinds.indexOf(a.kind) - kinds.indexOf(b.kind),
	);
}

/**
 * « Comparer avec la branche de base » : le même scénario et les mêmes appels,
 * rejoués sans modèle sur la branche d'origine puis sur la tâche, et ce qui
 * se comporte autrement. Un relecteur voit d'abord ce que le changement fait.
 * Le texte vient de l'application : une donnée, rendue comme du texte.
 */
export function VerifyCompare({
	taskId,
	record,
	query,
}: {
	readonly taskId: string;
	readonly record: VerifyRecord;
	readonly query: { projectDir: string; specId: string };
}) {
	const { t } = useTranslation(["tasks"]);
	const compare = useVerifyStore((s) => s.compare);
	const busy = useVerifyStore((s) => s.byTask[taskId]?.busy);
	const replayable = record.scenario.length > 0 || record.endpoints.length > 0;
	if (!replayable && !record.compare) return null;
	const result = record.compare;
	const differences = orderedDifferences(result?.differences ?? []);
	const shots = result?.screenshots;

	return (
		<section>
			<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
				<h4 className="font-medium">{t("tasks:verify.compare.title")}</h4>
				<Button
					size="sm"
					variant="outline"
					disabled={Boolean(busy) || !replayable}
					onClick={() => void compare(taskId, query)}
				>
					{busy === "comparing" && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
					{t(result ? "tasks:verify.compare.again" : "tasks:verify.compare.run")}
				</Button>
			</div>
			{!result && <p className="text-xs text-muted-foreground">{t("tasks:verify.compare.hint")}</p>}
			{result?.status === "skipped" && (
				<p className="text-xs text-muted-foreground">
					{t("tasks:verify.compare.skipped", { reason: result.reason ?? "" })}
				</p>
			)}
			{result?.status === "done" && (
				<div className="space-y-3">
					<p className="text-xs text-muted-foreground">
						{t("tasks:verify.compare.against", { base: (result.base ?? "").slice(0, 10) })}
					</p>
					{differences.length === 0 ? (
						<p className="text-sm">{t("tasks:verify.compare.same")}</p>
					) : (
						<ul className="space-y-1">
							{differences.map((d) => (
								<li key={`${d.kind}:${d.change}:${d.what}`} className="flex flex-wrap items-baseline gap-2">
									<Badge variant={WORSE.has(d.change) ? "destructive" : "outline"}>
										{t(`tasks:verify.compare.change.${d.change}`)}
									</Badge>
									<span className="text-xs text-muted-foreground">
										{t(`tasks:verify.compare.kind.${d.kind}`)}
									</span>
									<span className="break-all font-mono text-xs">{d.what}</span>
									{d.change === "changed" && (
										<span className="text-xs text-muted-foreground">
											{t("tasks:verify.compare.status", { base: d.base ?? "", task: d.task ?? "" })}
										</span>
									)}
								</li>
							))}
						</ul>
					)}
					{(typeof shots?.base === "number" || typeof shots?.task === "number") && (
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							{(["base", "task"] as const).map((side) =>
								typeof shots?.[side] === "number" ? (
									<figure key={side} className="overflow-hidden rounded border border-border">
										<img
											src={verifyScreenshotUrl(query, shots[side] as number)}
											alt={t(`tasks:verify.compare.side.${side}`)}
											className="block w-full bg-background object-contain"
											loading="lazy"
										/>
										<figcaption className="px-2 py-1 text-2xs text-muted-foreground">
											{t(`tasks:verify.compare.side.${side}`)}
										</figcaption>
									</figure>
								) : null,
							)}
						</div>
					)}
					<p className="text-2xs text-muted-foreground">{t("tasks:verify.compare.data")}</p>
				</div>
			)}
		</section>
	);
}
