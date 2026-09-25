import { FileSearch, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import type { DocintelDocument } from "../../lib/agent-tools-api";
import { useDocintelStore } from "../../stores/docintel-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export interface DocumentInsightsCardProps {
	readonly task: Task;
	/** Absolute project path; the server derives the spec directory from it. */
	readonly projectPath?: string;
}

/**
 * Ce que les agents liront des pièces jointes de la tâche et des ADR du projet.
 *
 * Les captures, maquettes et schémas joints à une tâche étaient copiés sur le
 * disque et lus par personne. Ils sont maintenant lus avant la planification
 * (`docintel`) : un draw.io ou un Excalidraw comme des boîtes et des flèches,
 * une capture par l'OCR local quand la machine a Tesseract, et sinon remise
 * telle quelle aux agents. La carte dit, *avant* le build, ce que chacun
 * deviendra — c'est le moment où l'on peut encore joindre le `.drawio`
 * plutôt que sa capture d'écran.
 *
 * Elle ne s'affiche que quand elle a quelque chose à dire : ni pièce jointe ni
 * ADR, pas de carte.
 */
export function DocumentInsightsCard({
	task,
	projectPath,
}: DocumentInsightsCardProps) {
	const { t } = useTranslation(["tasks"]);
	const [expanded, setExpanded] = useState(false);

	const load = useDocintelStore((s) => s.load);
	const clear = useDocintelStore((s) => s.clear);
	const data = useDocintelStore((s) => s.byTask[task.id]?.data ?? null);

	useEffect(() => {
		if (!projectPath) return;
		void load({
			taskId: task.id,
			specDir: task.specsPath,
			projectDir: projectPath,
			specId: task.specId,
		});
		return () => clear(task.id);
	}, [task.id, task.specId, task.specsPath, projectPath, load, clear]);

	if (!projectPath || data === null) return null;

	const documents = data.documents;
	const binding = data.adrs.filter((adr) => adr.binding);
	const proposed = data.adrs.filter((adr) => adr.status === "proposed");
	const flagged = documents.filter((doc) => doc.threat !== "safe");

	if (documents.length === 0 && binding.length === 0 && proposed.length === 0) {
		return null;
	}

	return (
		<div className="rounded-lg border border-border bg-muted/20">
			<div className="flex items-start justify-between gap-3 p-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<FileSearch className="h-4 w-4 shrink-0 text-primary" aria-hidden />
						<span className="text-sm font-medium">{t("tasks:docintel.title")}</span>
						{documents.length > 0 && (
							<Badge variant="outline" className="text-[10px]">
								{t("tasks:docintel.badge.attachments", {
									count: documents.length,
								})}
							</Badge>
						)}
						{binding.length > 0 && (
							<Badge variant="outline" className="text-[10px]">
								{t("tasks:docintel.badge.adrs", { count: binding.length })}
							</Badge>
						)}
						{flagged.length > 0 && (
							<Badge variant="destructive" className="text-[10px]">
								{t("tasks:docintel.badge.flagged", { count: flagged.length })}
							</Badge>
						)}
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{t("tasks:docintel.subtitle")}
					</p>
				</div>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
				>
					{expanded ? t("tasks:docintel.collapse") : t("tasks:docintel.expand")}
				</Button>
			</div>

			{expanded && (
				<div className="space-y-3 border-t border-border p-3">
					{documents.length > 0 && (
						<section>
							<h4 className="text-xs font-medium">
								{t("tasks:docintel.attachments.title")}
							</h4>
							<ul className="mt-1 space-y-1">
								{documents.map((doc) => (
									<DocumentRow key={doc.path} doc={doc} />
								))}
							</ul>
						</section>
					)}

					{(binding.length > 0 || proposed.length > 0) && (
						<section>
							<h4 className="text-xs font-medium">
								{t("tasks:docintel.adrs.title")}
							</h4>
							<p className="mt-1 text-xs text-muted-foreground">
								{t("tasks:docintel.adrs.body")}
							</p>
							<ul className="mt-1 space-y-1">
								{[...binding, ...proposed].map((adr) => (
									<li key={adr.path} className="text-xs text-muted-foreground">
										<span className="font-medium text-foreground">{adr.id}</span>{" "}
										{adr.title}
										{!adr.binding && (
											<Badge variant="outline" className="ml-2 text-[10px]">
												{t("tasks:docintel.adrs.proposed")}
											</Badge>
										)}
									</li>
								))}
							</ul>
						</section>
					)}
				</div>
			)}
		</div>
	);
}

function DocumentRow({ doc }: { readonly doc: DocintelDocument }) {
	const { t } = useTranslation(["tasks"]);
	const name = doc.path.split("/").pop() ?? doc.path;

	let detail: string;
	if (doc.threat !== "safe") {
		detail = t("tasks:docintel.detail.flagged");
	} else if (doc.status === "diagram") {
		detail = t("tasks:docintel.detail.diagram", {
			engine: doc.engine,
			nodes: doc.nodeCount,
			edges: doc.edgeCount,
		});
	} else if (doc.status === "text") {
		detail =
			doc.engine === "tesseract"
				? t("tasks:docintel.detail.ocr")
				: t("tasks:docintel.detail.text");
	} else if (doc.status === "image") {
		detail = t("tasks:docintel.detail.image", {
			reason: t(`tasks:docintel.reason.${doc.reason || "unknown"}`, {
				defaultValue: doc.reason,
			}),
		});
	} else if (doc.status === "document") {
		detail = t("tasks:docintel.detail.document");
	} else {
		detail = t("tasks:docintel.detail.skipped", {
			reason: t(`tasks:docintel.reason.${doc.reason || "unknown"}`, {
				defaultValue: doc.reason,
			}),
		});
	}

	return (
		<li className="flex items-start gap-2 text-xs text-muted-foreground">
			{doc.threat !== "safe" ? (
				<ShieldAlert className="mt-0.5 h-3 w-3 shrink-0 text-destructive" aria-hidden />
			) : (
				<Badge variant="outline" className="shrink-0 text-[10px]">
					{t(`tasks:docintel.status.${doc.status}`)}
				</Badge>
			)}
			<span className="min-w-0">
				<span className="break-all font-medium text-foreground">{name}</span>
				<span className="ml-1">— {detail}</span>
			</span>
		</li>
	);
}
