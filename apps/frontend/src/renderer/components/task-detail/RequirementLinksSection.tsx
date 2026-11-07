import { useTranslation } from "react-i18next";
import type { TraceabilityLinks } from "../../lib/agent-tools-api";
import { Badge } from "../ui/badge";

/** Les exigences dont un fichier n'a aucun test, et les exigences antérieures sur les mêmes fichiers. */
export function linkSignals(links: TraceabilityLinks | null): { untested: number; earlier: number } {
	return {
		untested: links?.requirements.filter((r) => r.untested.length > 0).length ?? 0,
		earlier: links?.earlier.length ?? 0,
	};
}

/**
 * Ce que chaque exigence est devenue : ses fichiers, ses tests, et les
 * exigences d'autres tâches qui ont touché les mêmes fichiers. Écrit par le
 * build (`requirement-links.json`) et gardé dans le registre du projet, donc
 * encore lisible après la fusion. Des chemins seulement, jamais du code.
 */
export function RequirementLinksSection({ links }: { readonly links: TraceabilityLinks }) {
	const { t } = useTranslation(["traceability"]);
	return (
		<>
			<section>
				<h4 className="text-xs font-medium">{t("traceability:links.title")}</h4>
				<p className="mt-1 text-xs text-muted-foreground">
					{t(`traceability:links.source.${links.source}`)}
				</p>
				<ul className="mt-1 space-y-1">
					{links.requirements.map((r) => (
						<li key={r.id} className="text-xs">
							<div className="flex flex-wrap items-center gap-2">
								<Badge variant="outline" className="text-3xs">
									{r.id}
								</Badge>
								<span>{r.title}</span>
								<span className="text-muted-foreground">
									{r.files.length > 0
										? t("traceability:links.files", { count: r.files.length })
										: t("traceability:links.none")}
								</span>
							</div>
							{r.tests.length > 0 && (
								<p className="ml-1 break-all font-mono text-3xs text-muted-foreground">
									{t("traceability:links.tests", { tests: r.tests.join(", ") })}
								</p>
							)}
							{r.untested.length > 0 && (
								<p className="ml-1 break-all font-mono text-3xs text-warning">
									{t("traceability:links.noTest", { files: r.untested.join(", ") })}
								</p>
							)}
						</li>
					))}
				</ul>
			</section>
			{links.earlier.length > 0 && (
				<section>
					<h4 className="text-xs font-medium">{t("traceability:links.earlier.title")}</h4>
					<p className="mt-1 text-xs text-muted-foreground">{t("traceability:links.earlier.body")}</p>
					<ul className="mt-1 space-y-1">
						{links.earlier.map((e) => (
							<li key={`${e.spec}:${e.id}`} className="text-xs">
								<span className="font-medium">{t("traceability:links.earlier.item", { spec: e.spec, id: e.id })}</span>
								{e.title && <span className="ml-1 text-muted-foreground">{e.title}</span>}
								<p className="ml-1 break-all font-mono text-3xs text-muted-foreground">{e.files.join(", ")}</p>
							</li>
						))}
					</ul>
				</section>
			)}
		</>
	);
}
