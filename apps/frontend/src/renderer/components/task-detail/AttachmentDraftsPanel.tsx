import { Check, ClipboardCopy, FileText, PenTool, Table2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { useToast } from "../../hooks/use-toast";
import type {
	RuleTableDraft,
	SpecTraceabilityQuery,
	WhiteboardResult,
} from "../../lib/agent-tools-api";
import { useDocintelDraftsStore } from "../../stores/docintel-drafts-store";
import { useDocintelStore } from "../../stores/docintel-store";
import { persistUpdateTask } from "../../stores/task-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
	activeTables,
	mergeCriteria,
	offersExtraction,
	pendingCriteria,
	pendingRequirements,
	sourceLabel,
} from "./attachment-drafts";

export interface AttachmentDraftsPanelProps {
	readonly task: Task;
	readonly projectPath: string;
}

/**
 * Ce que les pièces jointes proposent, et ce que la personne en garde.
 *
 * Un cahier des charges joint — souvent un PDF scanné — énonce déjà les
 * exigences. `docintel` les lit (couche texte, sinon OCR page par page) et
 * **propose** : des exigences `FR-###`, des critères d'acceptation, les
 * tableaux de règles métier avec le test paramétré de chacun. Rien n'entre
 * dans `spec.md` ni dans l'éditeur de critères sans qu'on l'ait coché ici :
 * une heuristique qui écrirait seule dans la spec ferait de chaque faux positif
 * une exigence que la QA opposerait au build.
 *
 * Une photo de tableau blanc devient un `.drawio` éditable par le modèle de
 * vision local, et seulement par lui — sans modèle, le panneau le dit.
 *
 * Le panneau ne dit rien quand il n'a rien à proposer.
 */
export function AttachmentDraftsPanel({
	task,
	projectPath,
}: AttachmentDraftsPanelProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const query: SpecTraceabilityQuery = useMemo(
		() => ({
			specDir: task.specsPath,
			projectDir: projectPath,
			specId: task.specId,
		}),
		[task.specsPath, projectPath, task.specId],
	);

	const entry = useDocintelDraftsStore((s) => s.byTask[task.id]);
	const load = useDocintelDraftsStore((s) => s.load);
	const extract = useDocintelDraftsStore((s) => s.extract);
	const decide = useDocintelDraftsStore((s) => s.decide);
	const convert = useDocintelDraftsStore((s) => s.convert);
	const clear = useDocintelDraftsStore((s) => s.clear);
	const reloadCard = useDocintelStore((s) => s.load);

	const [selected, setSelected] = useState<Record<string, boolean>>({});
	const [edits, setEdits] = useState<Record<string, string>>({});

	useEffect(() => {
		void load(task.id, query);
		return () => clear(task.id);
	}, [task.id, query, load, clear]);

	const payload = entry?.data ?? null;
	const busy = entry?.busy ?? null;
	const requirements = pendingRequirements(payload);
	const criteria = pendingCriteria(payload);
	const tables = activeTables(payload);
	const images = payload?.vision.images ?? [];
	const offer = offersExtraction(payload);

	if (
		!payload ||
		(!offer &&
			requirements.length === 0 &&
			criteria.length === 0 &&
			tables.length === 0 &&
			images.length === 0)
	) {
		return null;
	}

	const pageLabel = (page: number) => t("tasks:docintel.drafts.page", { page });
	const refreshCard = () =>
		reloadCard({
			taskId: task.id,
			specDir: task.specsPath,
			projectDir: projectPath,
			specId: task.specId,
		});

	const toggle = (key: string, value: boolean) =>
		setSelected((current) => ({ ...current, [key]: value }));
	const textOf = (key: string, fallback: string) => edits[key] ?? fallback;
	const chosen = <T extends { key: string; text: string }>(items: T[]) =>
		Object.fromEntries(
			items.filter((i) => selected[i.key]).map((i) => [i.key, textOf(i.key, i.text)]),
		);

	const handleExtract = async () => {
		await extract(task.id, query);
		refreshCard();
	};

	const handleDecision = async (accept: boolean) => {
		const reqs = chosen(requirements);
		const crits = chosen(criteria);
		const result = await decide(
			task.id,
			query,
			accept
				? { acceptRequirements: reqs, acceptCriteria: crits }
				: {
						rejectRequirements: Object.keys(reqs),
						rejectCriteria: Object.keys(crits),
					},
		);
		setSelected({});
		if (!result || !accept) return;

		// Les critères rejoignent l'éditeur en puces par son propre chemin
		// d'enregistrement (task_metadata.json et requirements.json) ; la
		// description ne reçoit les exigences que tant qu'il n'y a pas de spec.
		let persisted = true;
		if (result.criteria.length > 0) {
			persisted = await persistUpdateTask(task.id, {
				metadata: {
					acceptanceCriteria: mergeCriteria(
						task.metadata?.acceptanceCriteria ?? [],
						result.criteria,
					),
				},
			});
		}
		if (persisted && result.description_section) {
			persisted = await persistUpdateTask(task.id, {
				description: `${task.description ?? ""}${result.description_section}`,
			});
		}
		toast({
			title: persisted
				? t("tasks:docintel.drafts.acceptedTitle")
				: t("tasks:docintel.drafts.saveErrorTitle"),
			description: t(
				result.spec_updated
					? "tasks:docintel.drafts.acceptedInSpec"
					: "tasks:docintel.drafts.acceptedInDescription",
				{
					requirements: result.requirements.length,
					criteria: result.criteria.length,
				},
			),
			variant: persisted ? "default" : "destructive",
		});
	};

	const handleConvert = async (path: string) => {
		const result = await convert(task.id, query, path);
		if (result?.status === "converted") refreshCard();
	};

	const selectedCount =
		requirements.filter((r) => selected[r.key]).length +
		criteria.filter((c) => selected[c.key]).length;
	const allKeys = [...requirements, ...criteria].map((item) => item.key);

	return (
		<div className="space-y-3 border-t border-border p-3" data-testid="attachment-drafts">
			{offer && (
				<section className="flex flex-wrap items-center justify-between gap-2">
					<p className="text-xs text-muted-foreground">
						{t("tasks:docintel.drafts.offer")}
					</p>
					<Button
						size="sm"
						variant="outline"
						onClick={() => void handleExtract()}
						disabled={busy !== null}
					>
						<FileText className="mr-1 h-3 w-3" aria-hidden />
						{busy === "extracting"
							? t("tasks:docintel.drafts.extracting")
							: t("tasks:docintel.drafts.extract")}
					</Button>
				</section>
			)}

			{(requirements.length > 0 || criteria.length > 0) && (
				<section>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h4 className="text-xs font-medium">
							{t("tasks:docintel.drafts.title", {
								count: requirements.length + criteria.length,
							})}
						</h4>
						<Button
							size="sm"
							variant="ghost"
							onClick={() =>
								setSelected(
									Object.fromEntries(
										allKeys.map((key) => [key, selectedCount < allKeys.length]),
									),
								)
							}
						>
							{selectedCount < allKeys.length
								? t("tasks:docintel.drafts.selectAll")
								: t("tasks:docintel.drafts.selectNone")}
						</Button>
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{t("tasks:docintel.drafts.body")}
					</p>

					{requirements.length > 0 && (
						<ul className="mt-2 space-y-1" aria-label={t("tasks:docintel.drafts.requirements")}>
							{requirements.map((draft) => (
								<li key={draft.key} className="flex items-start gap-2">
									<Checkbox
										className="mt-1.5"
										checked={Boolean(selected[draft.key])}
										onCheckedChange={(value) => toggle(draft.key, value === true)}
										aria-label={t("tasks:docintel.drafts.select", { id: draft.id })}
									/>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-1">
											<Badge variant="outline" className="text-[10px]">
												{draft.id}
											</Badge>
											<span className="text-[10px] text-muted-foreground">
												{sourceLabel(draft, pageLabel)}
											</span>
										</div>
										<Input
											className="mt-1 h-7 text-xs"
											value={textOf(draft.key, draft.text)}
											onChange={(event) =>
												setEdits((current) => ({
													...current,
													[draft.key]: event.target.value,
												}))
											}
											aria-label={t("tasks:docintel.drafts.edit", { id: draft.id })}
										/>
									</div>
								</li>
							))}
						</ul>
					)}

					{criteria.length > 0 && (
						<>
							<h5 className="mt-3 text-[11px] font-medium text-muted-foreground">
								{t("tasks:docintel.drafts.criteria")}
							</h5>
							<ul className="mt-1 space-y-1">
								{criteria.map((draft) => (
									<li key={draft.key} className="flex items-start gap-2">
										<Checkbox
											className="mt-1.5"
											checked={Boolean(selected[draft.key])}
											onCheckedChange={(value) => toggle(draft.key, value === true)}
											aria-label={t("tasks:docintel.drafts.selectCriterion")}
										/>
										<div className="min-w-0 flex-1">
											<span className="text-[10px] text-muted-foreground">
												{sourceLabel(draft, pageLabel)}
											</span>
											<Input
												className="mt-1 h-7 text-xs"
												value={textOf(draft.key, draft.text)}
												onChange={(event) =>
													setEdits((current) => ({
														...current,
														[draft.key]: event.target.value,
													}))
												}
												aria-label={t("tasks:docintel.drafts.editCriterion")}
											/>
										</div>
									</li>
								))}
							</ul>
						</>
					)}

					<div className="mt-2 flex flex-wrap gap-2">
						<Button
							size="sm"
							onClick={() => void handleDecision(true)}
							disabled={selectedCount === 0 || busy !== null}
						>
							<Check className="mr-1 h-3 w-3" aria-hidden />
							{t("tasks:docintel.drafts.accept", { count: selectedCount })}
						</Button>
						<Button
							size="sm"
							variant="outline"
							onClick={() => void handleDecision(false)}
							disabled={selectedCount === 0 || busy !== null}
						>
							<X className="mr-1 h-3 w-3" aria-hidden />
							{t("tasks:docintel.drafts.reject", { count: selectedCount })}
						</Button>
					</div>
				</section>
			)}

			{tables.length > 0 && (
				<section>
					<h4 className="text-xs font-medium">
						{t("tasks:docintel.rules.title", { count: tables.length })}
					</h4>
					<p className="mt-1 text-xs text-muted-foreground">
						{t("tasks:docintel.rules.body")}
					</p>
					<ul className="mt-2 space-y-3">
						{tables.map((table) => (
							<RuleTableRow
								key={table.key}
								table={table}
								pageLabel={pageLabel}
								onDismiss={() =>
									void decide(task.id, query, { rejectTables: [table.key] })
								}
							/>
						))}
					</ul>
				</section>
			)}

			{images.length > 0 && (
				<WhiteboardSection
					images={images}
					available={payload.vision.available}
					reason={payload.vision.reason}
					busy={busy === "converting"}
					results={entry?.whiteboards ?? {}}
					onConvert={(path) => void handleConvert(path)}
				/>
			)}

			{entry?.error && (
				<p className="text-xs text-destructive" role="alert">
					{t("tasks:docintel.drafts.error", { error: entry.error })}
				</p>
			)}
		</div>
	);
}

function RuleTableRow({
	table,
	pageLabel,
	onDismiss,
}: {
	readonly table: RuleTableDraft;
	readonly pageLabel: (page: number) => string;
	readonly onDismiss: () => void;
}) {
	const { t } = useTranslation(["tasks"]);
	const [language, setLanguage] = useState(table.tests[0]?.language ?? "");
	const [copied, setCopied] = useState(false);
	const test = table.tests.find((d) => d.language === language) ?? table.tests[0];

	const copy = async () => {
		if (!test) return;
		try {
			await navigator.clipboard.writeText(test.code);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	};

	return (
		<li className="rounded border border-border p-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="flex items-center gap-1 text-xs font-medium">
					<Table2 className="h-3 w-3 text-primary" aria-hidden />
					{table.table.caption || t("tasks:docintel.rules.untitled")}
					<span className="font-normal text-muted-foreground">
						— {sourceLabel({ source: table.source, page: table.table.page }, pageLabel)}
					</span>
				</span>
				<Button size="sm" variant="ghost" onClick={onDismiss}>
					{t("tasks:docintel.rules.dismiss")}
				</Button>
			</div>
			<div className="mt-1 overflow-x-auto">
				<table className="text-[11px]">
					<thead>
						<tr>
							{table.table.headers.map((header, index) => (
								<th
									// biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity but their position
									key={index}
									className="border border-border px-1 text-left font-medium"
								>
									{header}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{table.table.rows.slice(0, 8).map((row, rowIndex) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a row is identified by its position in the document
							<tr key={rowIndex}>
								{row.map((cell, cellIndex) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: same as the headers
									<td key={cellIndex} className="border border-border px-1">
										{cell}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
				{table.table.rows.length > 8 && (
					<p className="text-[10px] text-muted-foreground">
						{t("tasks:docintel.rules.moreRows", {
							count: table.table.rows.length - 8,
						})}
					</p>
				)}
			</div>
			{test ? (
				<div className="mt-2">
					<div className="flex flex-wrap items-center gap-1">
						{table.tests.map((draft) => (
							<Button
								key={draft.language}
								size="sm"
								variant={draft.language === test.language ? "secondary" : "ghost"}
								className="h-6 px-2 text-[10px]"
								onClick={() => {
									setLanguage(draft.language);
									setCopied(false);
								}}
							>
								{t("tasks:docintel.rules.framework", {
									language: draft.language,
									framework: draft.framework,
								})}
							</Button>
						))}
						<Button
							size="sm"
							variant="ghost"
							className="ml-auto h-6 px-2 text-[10px]"
							onClick={() => void copy()}
						>
							<ClipboardCopy className="mr-1 h-3 w-3" aria-hidden />
							{copied ? t("tasks:docintel.rules.copied") : t("tasks:docintel.rules.copy")}
						</Button>
					</div>
					<pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-[10px]">
						{test.code}
					</pre>
				</div>
			) : (
				<p className="mt-1 text-[10px] text-muted-foreground">
					{t("tasks:docintel.rules.noLanguage")}
				</p>
			)}
		</li>
	);
}

function WhiteboardSection({
	images,
	available,
	reason,
	busy,
	results,
	onConvert,
}: {
	readonly images: string[];
	readonly available: boolean;
	readonly reason: string;
	readonly busy: boolean;
	readonly results: Record<string, WhiteboardResult>;
	readonly onConvert: (path: string) => void;
}) {
	const { t } = useTranslation(["tasks"]);
	if (!available) {
		// Dit, sans rien deviner : pas de modèle de vision, pas de schéma.
		return (
			<p className="flex items-start gap-1 text-[11px] text-muted-foreground">
				<PenTool className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
				{t("tasks:docintel.whiteboard.unavailable", {
					reason: t(`tasks:docintel.reason.${reason || "unknown"}`, {
						defaultValue: reason,
					}),
				})}
			</p>
		);
	}
	return (
		<section>
			<h4 className="flex items-center gap-1 text-xs font-medium">
				<PenTool className="h-3 w-3 text-primary" aria-hidden />
				{t("tasks:docintel.whiteboard.title")}
			</h4>
			<p className="mt-1 text-xs text-muted-foreground">
				{t("tasks:docintel.whiteboard.body")}
			</p>
			<ul className="mt-1 space-y-1">
				{images.map((path) => {
					const result = results[path];
					return (
						<li key={path} className="flex flex-wrap items-center gap-2 text-xs">
							<span className="break-all">{path.split("/").pop()}</span>
							<Button
								size="sm"
								variant="outline"
								className="h-6 px-2 text-[10px]"
								disabled={busy}
								onClick={() => onConvert(path)}
							>
								{t("tasks:docintel.whiteboard.convert")}
							</Button>
							{result && <WhiteboardOutcome result={result} />}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

function WhiteboardOutcome({ result }: { readonly result: WhiteboardResult }) {
	const { t } = useTranslation(["tasks"]);
	if (result.status !== "converted") {
		return (
			<span className="text-destructive">
				{t(`tasks:docintel.whiteboard.status.${result.status}`, {
					defaultValue: result.status,
				})}
			</span>
		);
	}
	const conformance = result.conformance;
	return (
		<span className="text-muted-foreground">
			{t("tasks:docintel.whiteboard.converted", {
				path: result.path.split("/").pop(),
				nodes: result.nodes,
				edges: result.edges,
			})}
			{conformance &&
				conformance.status === "checked" &&
				` — ${t("tasks:docintel.whiteboard.conformance", {
					count: conformance.findings,
				})}`}
		</span>
	);
}
