import { ArrowDownUp, Check, Copy, Languages, Square } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type TranslationHistoryEntry,
	useCrossLangTranslationStore,
} from "../../stores/cross-language-translation-store";
import { useProjectStore } from "../../stores/project-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { Textarea } from "../ui/textarea";

const HISTORY_STATUS_VARIANTS: Record<
	TranslationHistoryEntry["status"],
	"warning" | "success" | "destructive" | "muted"
> = {
	pending: "warning",
	complete: "success",
	failed: "destructive",
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
		<Button
			type="button"
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
		</Button>
	);
}

function CodePane({ code }: Readonly<{ code: string }>) {
	return (
		<pre className="h-full overflow-auto rounded-lg border border-border bg-card p-3 text-xs font-mono text-foreground whitespace-pre">
			{code}
		</pre>
	);
}

export function CrossLanguageTranslationDashboard(): React.ReactElement {
	const { t, i18n } = useTranslation(["crossLanguageTranslation"]);
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
				<SelectTrigger id={id} className="h-9">
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
		return (
			<div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border bg-card/50 p-6 text-center">
				<p className="text-sm text-muted-foreground">
					{isTranslating
						? t("crossLanguageTranslation:editor.translating")
						: t("crossLanguageTranslation:editor.resultEmpty")}
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full bg-background text-foreground">
			{/* Header */}
			<div className="px-6 py-4 border-b border-border">
				<div className="flex items-center justify-between gap-4">
					<div className="min-w-0">
						<h1 className="text-xl font-semibold">
							{t("crossLanguageTranslation:title")}
						</h1>
						<p className="text-sm text-muted-foreground mt-0.5">
							{t("crossLanguageTranslation:subtitle")}
						</p>
					</div>
					{isTranslating ? (
						<Button
							type="button"
							variant="outline"
							onClick={() => projectPath && cancelTranslation(projectPath)}
							className="shrink-0 gap-2 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
						>
							<Square className="h-3.5 w-3.5" />
							{t("crossLanguageTranslation:actions.cancel")}
						</Button>
					) : (
						<Button
							type="button"
							onClick={() => projectPath && translate(projectPath)}
							disabled={!canTranslate}
							className="shrink-0 gap-2"
						>
							<Languages className="h-4 w-4" />
							{t("crossLanguageTranslation:actions.translate")}
						</Button>
					)}
				</div>
			</div>

			<div className="flex flex-1 overflow-hidden">
				{/* Left: languages, options, history */}
				<aside className="w-64 shrink-0 border-r border-border p-4 flex flex-col gap-6 overflow-auto">
					<section>
						<h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
							{t("crossLanguageTranslation:languages.heading")}
						</h3>
						<label
							htmlFor="translation-source"
							className="block text-xs text-muted-foreground mb-1"
						>
							{t("crossLanguageTranslation:languages.source")}
						</label>
						{languageSelect("translation-source", sourceLang, setSourceLang)}
						<div className="flex justify-center my-1.5">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={swapLanguages}
								disabled={isTranslating}
								aria-label={t("crossLanguageTranslation:languages.swap")}
								title={t("crossLanguageTranslation:languages.swap")}
							>
								<ArrowDownUp className="h-3.5 w-3.5" />
							</Button>
						</div>
						<label
							htmlFor="translation-target"
							className="block text-xs text-muted-foreground mb-1"
						>
							{t("crossLanguageTranslation:languages.target")}
						</label>
						{languageSelect("translation-target", targetLang, setTargetLang)}
						{sameLanguage && (
							<p className="mt-2 text-xs text-warning">
								{t("crossLanguageTranslation:languages.same")}
							</p>
						)}
					</section>

					<section>
						<h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
							{t("crossLanguageTranslation:options.heading")}
						</h3>
						<div className="flex flex-col gap-2.5">
							<div className="flex items-center gap-2">
								<Checkbox
									id="translation-preserve-comments"
									checked={preserveComments}
									onCheckedChange={(v) => setPreserveComments(v === true)}
									disabled={isTranslating}
								/>
								<label
									htmlFor="translation-preserve-comments"
									className="text-sm cursor-pointer"
								>
									{t("crossLanguageTranslation:options.preserveComments")}
								</label>
							</div>
							<div className="flex items-center gap-2">
								<Checkbox
									id="translation-generate-tests"
									checked={generateTests}
									onCheckedChange={(v) => setGenerateTests(v === true)}
									disabled={isTranslating}
								/>
								<label
									htmlFor="translation-generate-tests"
									className="text-sm cursor-pointer"
								>
									{t("crossLanguageTranslation:options.generateTests")}
								</label>
							</div>
						</div>
					</section>

					<section className="flex-1">
						<div className="flex items-center justify-between mb-2">
							<h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
								{t("crossLanguageTranslation:history.heading")}
							</h3>
							{history.length > 0 && (
								<Button
									type="button"
									variant="link"
									size="sm"
									className="h-auto px-0 text-xs text-muted-foreground hover:text-foreground"
									onClick={() => projectPath && clearHistory(projectPath)}
								>
									{t("crossLanguageTranslation:history.clear")}
								</Button>
							)}
						</div>
						{history.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								{t("crossLanguageTranslation:history.empty")}
							</p>
						) : (
							<ul className="flex flex-col gap-1.5">
								{history.map((entry) => (
									<li
										key={entry.id}
										className="rounded-lg border border-border bg-card p-2"
									>
										<div className="flex items-center justify-between gap-2">
											<span className="text-xs font-medium truncate">
												{languageLabel(entry.source_lang)} →{" "}
												{languageLabel(entry.target_lang)}
											</span>
											<Badge
												variant={HISTORY_STATUS_VARIANTS[entry.status] ?? "muted"}
												className="shrink-0 px-1.5 py-0 text-[11px] font-medium"
											>
												{t(
													`crossLanguageTranslation:historyStatus.${entry.status}`,
													entry.status,
												)}
											</Badge>
										</div>
										<div className="mt-0.5 text-[11px] text-muted-foreground">
											{formatDate(entry.started_at)}
											{entry.lines
												? ` · ${t("crossLanguageTranslation:history.lines", { count: entry.lines })}`
												: ""}
										</div>
									</li>
								))}
							</ul>
						)}
					</section>
				</aside>

				{/* Right: source and result */}
				<div className="flex-1 flex flex-col overflow-hidden">
					{error && (
						<div
							role="alert"
							className="m-4 mb-0 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm flex items-start justify-between gap-3"
						>
							<span className="break-words min-w-0">{error}</span>
							<button
								type="button"
								onClick={clearError}
								className="shrink-0 text-xs underline"
							>
								{t("crossLanguageTranslation:actions.dismiss")}
							</button>
						</div>
					)}

					<div className="flex-1 grid grid-cols-2 gap-4 p-4 overflow-hidden">
						<div className="flex flex-col overflow-hidden">
							<div className="flex h-8 items-center justify-between mb-1">
								<label htmlFor="translation-input" className="text-sm font-semibold">
									{t("crossLanguageTranslation:editor.source", {
										language: languageLabel(sourceLang),
									})}
								</label>
								{sourceLines > 0 && (
									<span className="text-xs text-muted-foreground">
										{t("crossLanguageTranslation:history.lines", {
											count: sourceLines,
										})}
									</span>
								)}
							</div>
							<Textarea
								id="translation-input"
								value={inputCode}
								onChange={(e) => setInputCode(e.target.value)}
								disabled={isTranslating}
								spellCheck={false}
								placeholder={t("crossLanguageTranslation:editor.placeholder")}
								className="flex-1 min-h-0 p-3 text-xs font-mono whitespace-pre"
							/>
						</div>

						<div className="flex flex-col overflow-hidden">
							<div className="flex h-8 items-center justify-between mb-1">
								<h2 className="text-sm font-semibold">
									{t("crossLanguageTranslation:editor.result", {
										language: languageLabel(outputCode ? resultLang : targetLang),
									})}
								</h2>
								<div className="flex items-center gap-2">
									{outputCode && testCode && (
										<Tabs
											value={resultTab}
											onValueChange={(v) => setResultTab(v === "tests" ? "tests" : "code")}
										>
											<TabsList className="h-8 p-0.5">
												<TabsTrigger value="code" className="h-7 px-2.5 text-xs">
													{t("crossLanguageTranslation:editor.tabs.code")}
												</TabsTrigger>
												<TabsTrigger value="tests" className="h-7 px-2.5 text-xs">
													{t("crossLanguageTranslation:editor.tabs.tests")}
												</TabsTrigger>
											</TabsList>
										</Tabs>
									)}
									<CopyButton
										text={showTests ? testCode : outputCode}
										label={t("crossLanguageTranslation:actions.copy")}
									/>
								</div>
							</div>
							<div className="flex flex-1 flex-col overflow-hidden">
								{renderResult()}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

export default CrossLanguageTranslationDashboard;
