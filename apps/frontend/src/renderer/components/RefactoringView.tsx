/**
 * "Refactoring" tab of Dette et refactoring, in the UI charter
 * (docs/architecture/ui-charter.md): the code on the left, the smells found
 * in the middle, the proposed refactorings on the right, actions in the
 * composer.
 */
import {
	AlertTriangle,
	Bug,
	ClipboardPaste,
	Lightbulb,
	Trash2,
	Wand2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	CodeLanguage,
	CodeSmell,
	RefactoringProposal,
} from "../../shared/types/code-insights";
import {
	CharterButton,
	Chip,
	Chips,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleStage,
	Notice,
	ScanLine,
	StepCard,
	type Tone,
} from "./charter";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

interface RefactoringViewProps {
	readonly projectId: string;
}

const AUTO = "auto";

const SEVERITY_TONE: Record<string, Tone> = {
	critical: "red",
	high: "red",
	medium: "amber",
	low: "blue",
	info: "muted",
};

const RISK_TONE: Record<string, Tone> = { high: "red", medium: "amber", low: "green" };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// biome-ignore lint/correctness/noUnusedFunctionParameters: parameter kept for API compatibility
export function RefactoringView({ projectId }: Readonly<RefactoringViewProps>) {
	const { t } = useTranslation(["refactoring"]);
	const [source, setSource] = useState("");
	const [smells, setSmells] = useState<CodeSmell[]>([]);
	const [proposals, setProposals] = useState<RefactoringProposal[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadingProposals, setLoadingProposals] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [expandedSmells, setExpandedSmells] = useState<Set<string>>(new Set());
	const [detected, setDetected] = useState(false);
	// Every stack the backend reads; "auto" lets it guess from the pasted code.
	const [languages, setLanguages] = useState<CodeLanguage[]>([]);
	const [language, setLanguage] = useState(AUTO);
	const [readAs, setReadAs] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		window.electronAPI
			.runCodeInsights({ action: "languages" })
			.then((result) => {
				if (alive) setLanguages(result.languages);
			})
			.catch(() => {
				/* without the list the picker keeps "auto", which still works */
			});
		return () => {
			alive = false;
		};
	}, []);

	const labelOf = (id: string | null) =>
		languages.find((lang) => lang.id === id)?.label ?? id ?? "";
	const chosen = language === AUTO ? null : language;

	const toggleSmell = (key: string) => {
		setExpandedSmells((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const handleDetectSmells = useCallback(async () => {
		if (!source.trim()) return;
		setLoading(true);
		setError(null);
		setSmells([]);
		setProposals([]);
		setDetected(false);
		try {
			const result = await window.electronAPI.runCodeInsights({
				action: "smells",
				text: source,
				language: chosen ?? undefined,
			});
			setSmells(result.smells);
			setReadAs(result.language);
			setDetected(true);
		} catch (e) {
			setError(e instanceof Error && e.message ? e.message : t("refactoring:errors.detectionFailed"));
		} finally {
			setLoading(false);
		}
	}, [source, chosen, t]);

	const handleProposeRefactoring = useCallback(async () => {
		if (!source.trim()) return;
		setLoadingProposals(true);
		setError(null);
		try {
			const result = await window.electronAPI.runCodeInsights({
				action: "propose",
				text: source,
				language: chosen ?? undefined,
			});
			setProposals(result.proposals);
			setReadAs(result.language);
		} catch (e) {
			setError(e instanceof Error && e.message ? e.message : t("refactoring:errors.proposalFailed"));
		} finally {
			setLoadingProposals(false);
		}
	}, [source, chosen, t]);

	const handlePaste = useCallback(async () => {
		try {
			const text = await navigator.clipboard.readText();
			setSource(text);
		} catch {
			// clipboard access denied
		}
	}, []);

	const handleClear = () => {
		setSource("");
		setSmells([]);
		setProposals([]);
		setError(null);
		setDetected(false);
		setReadAs(null);
	};

	const severityCounts = smells.reduce<Record<string, number>>((acc, smell) => {
		const sev = smell.severity?.toLowerCase() || "info";
		acc[sev] = (acc[sev] || 0) + 1;
		return acc;
	}, {});
	const shownLanguage = chosen ?? readAs;
	const sourceLabel = shownLanguage
		? t("refactoring:input.labelWithLanguage", { language: labelOf(shownLanguage) })
		: t("refactoring:input.label");
	const busy = loading || loadingProposals;

	return (
		<ModuleStage data-testid="refactoring-view">
			<Columns template="minmax(320px, 38%) minmax(280px, 1fr) minmax(280px, 1fr)">
				<Column
					kicker={t("refactoring:kickers.source")}
					title={sourceLabel}
					tone="blue"
					actions={
						<>
							<CharterButton size="sm" variant="ghost" icon={ClipboardPaste} onClick={handlePaste}>
								{t("refactoring:actions.paste")}
							</CharterButton>
							{source && (
								<CharterButton size="sm" variant="ghost" icon={Trash2} onClick={handleClear}>
									{t("refactoring:actions.clear")}
								</CharterButton>
							)}
						</>
					}
				>
					{language === AUTO && readAs && (
						<div className="mb-2">
							<Chips>
								<Chip tone="blue">{t("refactoring:input.readAs", { language: labelOf(readAs) })}</Chip>
							</Chips>
						</div>
					)}
					<Textarea
						value={source}
						onChange={(e) => setSource(e.target.value)}
						aria-label={sourceLabel}
						placeholder={
							chosen
								? t("refactoring:input.placeholderWithLanguage", { language: labelOf(chosen) })
								: t("refactoring:input.placeholder")
						}
						className="wp-code min-h-[16rem] flex-1 resize-none"
						spellCheck={false}
					/>
				</Column>

				<Column
					kicker={t("refactoring:kickers.smells")}
					title={t("refactoring:smells.title", { count: smells.length })}
					tone="red"
				>
					{loading && <ScanLine label={t("refactoring:actions.detecting")} />}
					{!loading && detected && smells.length === 0 && (
						<Notice tone="green" icon={Bug}>
							{t("refactoring:clean")}
						</Notice>
					)}
					{!loading && !detected && smells.length === 0 && (
						<EmptyStage icon={Bug} title={t("refactoring:empty.smellsTitle")} tone="red">
							{t("refactoring:empty.smellsHint")}
						</EmptyStage>
					)}
					{smells.length > 0 && (
						<div className="flex flex-col gap-3">
							<Chips>
								{Object.entries(severityCounts).map(([sev, count]) => (
									<Chip key={sev} tone={SEVERITY_TONE[sev] ?? "muted"}>
										{t(`refactoring:severity.${sev}`, sev)} · {count}
									</Chip>
								))}
							</Chips>
							{smells.map((smell) => {
								const sev = smell.severity?.toLowerCase() || "info";
								const smellKey = `${smell.smell_type}-${smell.symbol || "no-symbol"}-${smell.line || "no-line"}`;
								const expanded = expandedSmells.has(smellKey);
								return (
									<StepCard
										key={smellKey}
										tone={SEVERITY_TONE[sev] ?? "muted"}
										kicker={smell.smell_type?.replaceAll("_", " ")}
										title={<span className="wp-mono text-[0.8rem]">{smell.symbol || "—"}</span>}
										meta={smell.line ? t("refactoring:smells.line", { line: smell.line }) : undefined}
										status={<span className="wp-meta">{t(`refactoring:severity.${sev}`, sev)}</span>}
										active={expanded}
										onClick={() => toggleSmell(smellKey)}
									>
										{expanded && (
											<span className="mt-1 flex flex-col gap-1 text-xs">
												<span>{smell.message}</span>
												{smell.metric_value !== undefined && smell.threshold !== undefined && (
													<span className="wp-meta">
														{t("refactoring:smells.measured")} {smell.metric_value} ·{" "}
														{t("refactoring:smells.threshold")} {smell.threshold}
													</span>
												)}
											</span>
										)}
									</StepCard>
								);
							})}
						</div>
					)}
				</Column>

				<Column
					kicker={t("refactoring:kickers.proposals")}
					title={t("refactoring:proposals.title", { count: proposals.length })}
					tone="green"
				>
					{loadingProposals && <ScanLine label={t("refactoring:actions.generating")} />}
					{!loadingProposals && proposals.length === 0 && (
						<EmptyStage icon={Lightbulb} title={t("refactoring:empty.proposalsTitle")} tone="green">
							{t("refactoring:empty.proposalsHint")}
						</EmptyStage>
					)}
					{proposals.length > 0 && (
						<div className="flex flex-col gap-3">
							{proposals.map((p) => {
								const risk = p.risk_level?.toLowerCase() || "low";
								const proposalKey = `${p.pattern}-${p.symbol || "no-symbol"}-${p.risk_level || "low"}`;
								return (
									<StepCard
										key={proposalKey}
										tone={RISK_TONE[risk] ?? "green"}
										kicker={p.pattern?.replaceAll("_", " ")}
										title={p.description}
										meta={p.symbol}
										status={
											<Chip tone={RISK_TONE[risk] ?? "green"}>
												{t("refactoring:proposals.risk")} {t(`refactoring:riskLevel.${risk}`, risk)}
											</Chip>
										}
									>
										{p.impact && (
											<span className="wp-meta mt-1 whitespace-normal">
												{t("refactoring:proposals.impact")} · {p.impact}
											</span>
										)}
									</StepCard>
								);
							})}
						</div>
					)}
				</Column>
			</Columns>

			{error && (
				<Notice tone="red" icon={AlertTriangle} role="alert" className="relative z-[2] mx-5 mb-2">
					{error}
				</Notice>
			)}
			<Composer
				prompt={
					<span className="flex min-w-0 flex-wrap items-center gap-3">
						<span className="wp-field">
							<label htmlFor="refactoring-language">{t("refactoring:input.language")}</label>
							<Select value={language} onValueChange={setLanguage} disabled={busy}>
								<SelectTrigger
									id="refactoring-language"
									className="h-7 w-auto min-w-[8rem] border-0 bg-transparent px-1 text-xs font-medium shadow-none"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={AUTO}>{t("refactoring:input.auto")}</SelectItem>
									{languages.map((lang) => (
										<SelectItem key={lang.id} value={lang.id}>
											{lang.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</span>
						<span className="wp-muted flex min-w-0 items-center gap-2 text-xs">
							<Wand2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
							<span className="truncate">{t("refactoring:description")}</span>
						</span>
					</span>
				}
				hint={sourceLabel}
				actions={
					<>
						<CharterButton
							icon={Lightbulb}
							busy={loadingProposals}
							onClick={handleProposeRefactoring}
							disabled={busy || !source.trim()}
						>
							{loadingProposals ? t("refactoring:actions.generating") : t("refactoring:actions.proposeRefactoring")}
						</CharterButton>
						<CharterButton
							variant="primary"
							icon={Bug}
							busy={loading}
							onClick={handleDetectSmells}
							disabled={busy || !source.trim()}
						>
							{loading ? t("refactoring:actions.detecting") : t("refactoring:actions.detectSmells")}
						</CharterButton>
					</>
				}
			/>
		</ModuleStage>
	);
}
