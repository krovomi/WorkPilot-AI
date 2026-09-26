import { Bug, EyeOff, FileSearch, KeyRound, ShieldAlert } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import type {
	DocintelDiagnosis,
	DocintelDocument,
} from "../../lib/agent-tools-api";
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
 * Une capture qui montre un secret (chaîne de connexion, clé de compte de
 * stockage, jeton) est « masquée » — les agents reçoivent une copie repeinte —
 * ou « retenue » quand elle ne peut pas l'être ; une capture dont le texte
 * s'adresse à l'agent est retenue aussi. La carte le dit avec le *type* de
 * secret, jamais sa valeur : le backend ne la lui envoie pas.
 *
 * Une trace de pile ou un log de CI en échec — dans une pièce jointe ou collé
 * dans la description — est rattaché aux fichiers du dépôt : la carte dit
 * combien de cadres appartiennent au projet et par lequel commencer, et quels
 * codes d'erreur le build a produits.
 *
 * Elle ne s'affiche que quand elle a quelque chose à dire : ni pièce jointe, ni
 * ADR, ni trace, pas de carte.
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
	const secrets = documents.filter((doc) => doc.secrets.length > 0);
	const fromDescription = data.descriptionDiagnosis ?? null;
	const diagnosed =
		documents.filter((doc) => doc.diagnosis).length + (fromDescription ? 1 : 0);

	if (
		documents.length === 0 &&
		binding.length === 0 &&
		proposed.length === 0 &&
		!fromDescription
	) {
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
						{secrets.length > 0 && (
							<Badge variant="destructive" className="text-[10px]">
								{t("tasks:docintel.badge.secrets", { count: secrets.length })}
							</Badge>
						)}
						{diagnosed > 0 && (
							<Badge variant="outline" className="text-[10px]">
								{t("tasks:docintel.badge.diagnosed", { count: diagnosed })}
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
					{fromDescription && (
						<section>
							<h4 className="text-xs font-medium">
								{t("tasks:docintel.diagnosis.fromDescription")}
							</h4>
							<DiagnosisLines diagnosis={fromDescription} />
						</section>
					)}

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

function reasonLabel(
	t: (key: string, options?: Record<string, unknown>) => string,
	reason: string,
): string {
	return t(`tasks:docintel.reason.${reason || "unknown"}`, {
		defaultValue: reason,
	});
}

function DocumentRow({ doc }: { readonly doc: DocintelDocument }) {
	const { t } = useTranslation(["tasks"]);
	const name = doc.path.split("/").pop() ?? doc.path;
	const kinds = doc.secrets.join(", ");

	let detail: string;
	if (doc.status === "withheld") {
		detail =
			doc.reason === "injection"
				? t("tasks:docintel.detail.withheldInjection")
				: t("tasks:docintel.detail.withheld", {
						kinds: kinds || reasonLabel(t, doc.reason),
					});
	} else if (doc.status === "redacted") {
		detail = t("tasks:docintel.detail.redacted", { kinds });
	} else if (doc.threat !== "safe") {
		detail = t("tasks:docintel.detail.flagged");
	} else if (doc.status === "diagram") {
		detail = t("tasks:docintel.detail.diagram", {
			engine: doc.engine,
			nodes: doc.nodeCount,
			edges: doc.edgeCount,
		});
	} else if (doc.status === "text") {
		if (doc.described) {
			detail = t("tasks:docintel.detail.described", { engine: doc.engine });
		} else if (doc.engine && doc.engine !== "text") {
			detail = t("tasks:docintel.detail.ocr", { engine: doc.engine });
		} else {
			detail = t("tasks:docintel.detail.text");
		}
	} else if (doc.status === "image") {
		detail = t("tasks:docintel.detail.image", {
			reason: reasonLabel(t, doc.reason),
		});
	} else if (doc.status === "document") {
		detail = t("tasks:docintel.detail.document");
	} else {
		detail = t("tasks:docintel.detail.skipped", {
			reason: reasonLabel(t, doc.reason),
		});
	}
	if (
		doc.secrets.length > 0 &&
		doc.status !== "redacted" &&
		doc.status !== "withheld"
	) {
		detail += ` — ${t("tasks:docintel.detail.secretsInText", { kinds })}`;
	}

	let marker: ReactNode;
	if (doc.status === "withheld") {
		marker = (
			<EyeOff className="mt-0.5 h-3 w-3 shrink-0 text-destructive" aria-hidden />
		);
	} else if (doc.status === "redacted") {
		marker = (
			<KeyRound className="mt-0.5 h-3 w-3 shrink-0 text-destructive" aria-hidden />
		);
	} else if (doc.threat !== "safe") {
		marker = (
			<ShieldAlert className="mt-0.5 h-3 w-3 shrink-0 text-destructive" aria-hidden />
		);
	} else {
		marker = (
			<Badge variant="outline" className="shrink-0 text-[10px]">
				{t(`tasks:docintel.status.${doc.status}`)}
			</Badge>
		);
	}

	return (
		<li className="flex items-start gap-2 text-xs text-muted-foreground">
			{marker}
			<span className="min-w-0">
				<span className="break-all font-medium text-foreground">{name}</span>
				<span className="ml-1">— {detail}</span>
				{doc.diagnosis && <DiagnosisLines diagnosis={doc.diagnosis} />}
			</span>
		</li>
	);
}

/** Où la trace ou le build a cassé, dans ce dépôt — ce que l'agent ouvrira d'abord. */
function DiagnosisLines({
	diagnosis,
}: {
	readonly diagnosis: DocintelDiagnosis;
}) {
	const { t } = useTranslation(["tasks"]);
	const lines: string[] = [];
	const trace = diagnosis.trace;
	if (trace) {
		const exception = trace.exception || t("tasks:docintel.diagnosis.trace");
		lines.push(
			trace.top
				? t("tasks:docintel.diagnosis.located", {
						exception,
						count: trace.projectFrames,
						top: trace.top,
					})
				: t("tasks:docintel.diagnosis.notLocated", {
						exception,
						framework: trace.frameworkFrames,
					}),
		);
	}
	const ci = diagnosis.ci;
	if (ci && ci.errors > 0) {
		lines.push(
			t("tasks:docintel.diagnosis.buildErrors", {
				count: ci.errors,
				codes: ci.codes.join(", "),
			}),
		);
	}
	if (ci && ci.failingTests > 0) {
		lines.push(
			t("tasks:docintel.diagnosis.failingTests", { count: ci.failingTests }),
		);
	}
	if (lines.length === 0) return null;
	return (
		<span className="mt-0.5 block">
			{lines.map((line) => (
				<span key={line} className="flex items-start gap-1">
					<Bug className="mt-0.5 h-3 w-3 shrink-0 text-primary" aria-hidden />
					<span className="break-all">{line}</span>
				</span>
			))}
		</span>
	);
}
