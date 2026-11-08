/**
 * Traduction inter-langages, in the UI charter (docs/architecture/ui-charter.md):
 * the history on the left, the source and the result side by side, the
 * languages, options and the translate action in the composer.
 */
import { ArrowLeftRight, Check, Copy, History, Languages, Square, TriangleAlert } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type TranslationHistoryEntry,
	useCrossLangTranslationStore,
} from "../../stores/cross-language-translation-store";
import { useProjectStore } from "../../stores/project-store";
import {
	CharterButton,
	Chip,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	ScanLine,
	StepCard,
	type Tone,
} from "../charter";
import { Checkbox } from "../ui/checkbox";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";

const HISTORY_STATUS_TONE: Record<TranslationHistoryEntry["status"], Tone> = {
	pending: "amber",
	complete: "green",
	failed: "red",
	cancelled: "muted",
};

function CopyButton({ text, label }: Readonly<{ text: string; label: string }>) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<CharterButton
			variant="ghost"
			size="sm"
			disabled={!text}
			onClick={() => {
				navigator.clipboard
					?.writeText(text)
					.then(() => setCopied(true))
					.catch(() => {
						/* clipboard refused: nothing to undo */
					});
			}}
			aria-label={label}
			title={label}
		>
			{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
		</CharterButton>
	);
}

function CodePane({ code }: Readonly<{ code: string }>) {
	return (
		<pre className="wp-code h-full overflow-auto !whitespace-pre">
			{code}
		</pre>
	);
}

export function CrossLanguageTranslationDashboard(): React.ReactElement {
	const { t, i18n } = useTranslation(["crossLanguageTranslation", "navigation"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const projectPath = activeProject?.path;

	const {
		languages,
		sourceLang,
		targetLang,
		inputCode,
		outputCode,
		testCode,
		resultLang,
		streamBuffer,
		status,
		history,
		preserveComments,
		generateTests,
		error,
		loadLanguages,
		setSourceLang,
		setTargetLang,
		setInputCode,
		setPreserveComments,
		setGenerateTests,
		swapLanguages,
		translate,
		cancelTranslation,
		loadHistory,
		clearHistory,
		clearError,
	} = useCrossLangTranslationStore();

	useEffect(() => {
		loadLanguages();
	}, [loadLanguages]);

	useEffect(() => {
		if (projectPath) loadHistory(projectPath);
	}, [projectPath, loadHistory]);

	const isTranslating = status === "translating";
	const sameLanguage = sourceLang === targetLang;
	const canTranslate = !!projectPath && !!inputCode.trim() && !sameLanguage;
	const sourceLines = inputCode.trim() ? inputCode.replace(/\n+$/, "").split("\n").length : 0;
	const [resultTab, setResultTab] = useState<"code" | "tests">("code");
	const showTests = !!outputCode && !!testCode && resultTab === "tests";
	// A new result opens on its translation.
	useEffect(() => {
		if (outputCode) setResultTab("code");
	}, [outputCode]);

	function languageLabel(id: string): string {
		return languages.find((l) => l.id === id)?.label ?? id;
	}

	function formatDate(iso: string): string {
		const date = new Date(iso);
		return Number.isNaN(date.getTime())
			? iso
			: date.toLocaleString(i18n.language, {
					dateStyle: "short",
					timeStyle: "short",
				});
	}

	function languageSelect(
		id: string,
		value: string,
		onChange: (lang: string) => void,
	): React.ReactElement {
		return (
			<Select value={value} onValueChange={onChange} disabled={isTranslating}>
				<SelectTrigger id={id} className="h-7 w-auto min-w-[8rem] border-0 bg-transparent px-1 text-xs font-medium shadow-none">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{languages.map((lang) => (
						<SelectItem key={lang.id} value={lang.id}>
							{lang.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	}

	function renderResult(): React.ReactElement {
		if (outputCode) return <CodePane code={showTests ? testCode : outputCode} />;
		if (isTranslating && streamBuffer) return <CodePane code={streamBuffer} />;
		if (isTranslating) return <ScanLine label={t("crossLanguageTranslation:editor.translating")} />;
		return (
			<EmptyStage icon={Languages} title={t("crossLanguageTranslation:kickers.result")} tone="green">
				{t("crossLanguageTranslation:editor.resultEmpty")}
			</EmptyStage>
		);
	}

	return (
		<ModuleStage data-testid="cross-language-translation-view">
			<ModuleHeader
				kicker={t("navigation:groups.development")}
				title={t("crossLanguageTranslation:title")}
				description={t("crossLanguageTranslation:subtitle")}
				icon={Languages}
			/>
			<Columns template="minmax(220px, 20%) minmax(0, 1fr) minmax(0, 1fr)">
				<Column
					kicker={t("crossLanguageTranslation:kickers.history")}
					title={t("crossLanguageTranslation:history.heading")}
					tone="muted"
					actions={
						history.length > 0 ? (
							<CharterButton size="sm" variant="ghost" onClick={() => projectPath && clearHistory(projectPath)}>
								{t("crossLanguageTranslation:history.clear")}
							</CharterButton>
						) : undefined
					}
				>
					{history.length === 0 ? (
						<EmptyStage icon={History} title={t("crossLanguageTranslation:history.heading")} tone="muted">
							{t("crossLanguageTranslation:history.empty")}
						</EmptyStage>
					) : (
						<ul className="flex flex-col gap-2">
							{history.map((entry) => (
								<li key={entry.id}>
									<StepCard
										tone={HISTORY_STATUS_TONE[entry.status] ?? "muted"}
										kicker={t(`crossLanguageTranslation:historyStatus.${entry.status}`, entry.status)}
										title={`${languageLabel(entry.source_lang)} → ${languageLabel(entry.target_lang)}`}
										meta={`${formatDate(entry.started_at)}${
											entry.lines
												? ` · ${t("crossLanguageTranslation:history.lines", { count: entry.lines })}`
												: ""
										}`}
									/>
								</li>
							))}
						</ul>
					)}
				</Column>

				<Column
					kicker={t("crossLanguageTranslation:kickers.source")}
					title={t("crossLanguageTranslation:editor.source", { language: languageLabel(sourceLang) })}
					meta={sourceLines > 0 ? t("crossLanguageTranslation:history.lines", { count: sourceLines }) : undefined}
					tone="blue"
				>
					<label htmlFor="translation-input" className="sr-only">
						{t("crossLanguageTranslation:editor.source", { language: languageLabel(sourceLang) })}
					</label>
					<Textarea
						id="translation-input"
						value={inputCode}
						onChange={(e) => setInputCode(e.target.value)}
						disabled={isTranslating}
						spellCheck={false}
						placeholder={t("crossLanguageTranslation:editor.placeholder")}
						className="wp-code min-h-[16rem] flex-1 resize-none !whitespace-pre"
					/>
				</Column>

				<Column
					kicker={t("crossLanguageTranslation:kickers.result")}
					title={t("crossLanguageTranslation:editor.result", {
						language: languageLabel(outputCode ? resultLang : targetLang),
					})}
					tone="green"
					actions={
						<>
							{outputCode && testCode && (
								<>
									<Chip tone="green" pressed={resultTab === "code"} onClick={() => setResultTab("code")}>
										{t("crossLanguageTranslation:editor.tabs.code")}
									</Chip>
									<Chip tone="violet" pressed={resultTab === "tests"} onClick={() => setResultTab("tests")}>
										{t("crossLanguageTranslation:editor.tabs.tests")}
									</Chip>
								</>
							)}
							<CopyButton
								text={showTests ? testCode : outputCode}
								label={t("crossLanguageTranslation:actions.copy")}
							/>
						</>
					}
				>
					<div className="flex min-h-0 flex-1 flex-col">{renderResult()}</div>
				</Column>
			</Columns>

			{error && (
				<Notice tone="red" icon={TriangleAlert} role="alert" className="relative z-[2] mx-5 mb-2">
					<div className="flex items-start justify-between gap-3">
						<span className="min-w-0 break-words">{error}</span>
						<CharterButton size="sm" variant="ghost" onClick={clearError}>
							{t("crossLanguageTranslation:actions.dismiss")}
						</CharterButton>
					</div>
				</Notice>
			)}
			{sameLanguage && (
				<Notice tone="amber" className="relative z-[2] mx-5 mb-2">
					{t("crossLanguageTranslation:languages.same")}
				</Notice>
			)}
			<Composer
				prompt={
					<span className="flex min-w-0 flex-wrap items-center gap-2">
						<span className="wp-field">
							<label htmlFor="translation-source">{t("crossLanguageTranslation:languages.source")}</label>
							{languageSelect("translation-source", sourceLang, setSourceLang)}
						</span>
						<CharterButton
							size="sm"
							variant="ghost"
							icon={ArrowLeftRight}
							onClick={swapLanguages}
							disabled={isTranslating}
							aria-label={t("crossLanguageTranslation:languages.swap")}
							title={t("crossLanguageTranslation:languages.swap")}
						/>
						<span className="wp-field">
							<label htmlFor="translation-target">{t("crossLanguageTranslation:languages.target")}</label>
							{languageSelect("translation-target", targetLang, setTargetLang)}
						</span>
					</span>
				}
				options={
					<>
						<span className="wp-field">
							<Checkbox
								id="translation-preserve-comments"
								checked={preserveComments}
								onCheckedChange={(v) => setPreserveComments(v === true)}
								disabled={isTranslating}
							/>
							<label htmlFor="translation-preserve-comments" className="cursor-pointer">
								{t("crossLanguageTranslation:options.preserveComments")}
							</label>
						</span>
						<span className="wp-field">
							<Checkbox
								id="translation-generate-tests"
								checked={generateTests}
								onCheckedChange={(v) => setGenerateTests(v === true)}
								disabled={isTranslating}
							/>
							<label htmlFor="translation-generate-tests" className="cursor-pointer">
								{t("crossLanguageTranslation:options.generateTests")}
							</label>
						</span>
					</>
				}
				actions={
					isTranslating ? (
						<CharterButton
							variant="danger"
							icon={Square}
							onClick={() => projectPath && cancelTranslation(projectPath)}
						>
							{t("crossLanguageTranslation:actions.cancel")}
						</CharterButton>
					) : (
						<CharterButton
							variant="primary"
							icon={Languages}
							onClick={() => projectPath && translate(projectPath)}
							disabled={!canTranslate}
						>
							{t("crossLanguageTranslation:actions.translate")}
						</CharterButton>
					)
				}
			/>
		</ModuleStage>
	);
}

export default CrossLanguageTranslationDashboard;
