import type React from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useCrossLangTranslationStore } from "../../stores/cross-language-translation-store";
import { useProjectStore } from "../../stores/project-store";

const HISTORY_STATUS_COLORS: Record<string, string> = {
	pending: "text-yellow-400",
	complete: "text-green-400",
	failed: "text-red-400",
};

export function CrossLanguageTranslationDashboard(): React.ReactElement {
	const { t } = useTranslation(["crossLanguageTranslation"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const projectPath = activeProject?.path;

	const {
		languages,
		sourceLang,
		targetLang,
		inputCode,
		outputCode,
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
	const displayedOutput = outputCode || streamBuffer;

	function languageLabel(id: string): string {
		return languages.find((l) => l.id === id)?.label ?? id;
	}

	return (
		<div className="flex flex-col h-full bg-[var(--bg-primary)] text-[var(--text-primary)]">
			{/* Header */}
			<div className="px-6 py-4 border-b border-[var(--border-color)]">
				<div className="flex items-center justify-between">
					<div>
						<h1 className="text-xl font-semibold">
							{t("crossLanguageTranslation:title")}
						</h1>
						<p className="text-sm text-[var(--text-secondary)] mt-0.5">
							{t("crossLanguageTranslation:subtitle")}
						</p>
					</div>
					{isTranslating ? (
						<button
							type="button"
							onClick={() => projectPath && cancelTranslation(projectPath)}
							className="px-4 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors text-sm font-medium"
						>
							{t("crossLanguageTranslation:actions.cancel")}
						</button>
					) : (
						<button
							type="button"
							onClick={() => projectPath && translate(projectPath)}
							disabled={!projectPath || !inputCode.trim()}
							className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity text-sm font-medium"
						>
							{t("crossLanguageTranslation:actions.translate")}
						</button>
					)}
				</div>
			</div>

			<div className="flex flex-1 overflow-hidden">
				{/* Left: languages, options, history */}
				<div className="w-64 border-r border-[var(--border-color)] p-4 flex flex-col gap-5 overflow-auto">
					<div>
						<h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">
							{t("crossLanguageTranslation:languages.heading")}
						</h3>
						<label
							htmlFor="translation-source"
							className="block text-xs text-[var(--text-secondary)] mb-1"
						>
							{t("crossLanguageTranslation:languages.source")}
						</label>
						<select
							id="translation-source"
							value={sourceLang}
							onChange={(e) => setSourceLang(e.target.value)}
							disabled={isTranslating}
							className="w-full px-2 py-1.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] text-sm mb-3"
						>
							{languages.map((lang) => (
								<option key={lang.id} value={lang.id}>
									{lang.label}
								</option>
							))}
						</select>
						<label
							htmlFor="translation-target"
							className="block text-xs text-[var(--text-secondary)] mb-1"
						>
							{t("crossLanguageTranslation:languages.target")}
						</label>
						<select
							id="translation-target"
							value={targetLang}
							onChange={(e) => setTargetLang(e.target.value)}
							disabled={isTranslating}
							className="w-full px-2 py-1.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] text-sm"
						>
							{languages.map((lang) => (
								<option key={lang.id} value={lang.id}>
									{lang.label}
								</option>
							))}
						</select>
					</div>

					<div>
						<h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">
							{t("crossLanguageTranslation:options.heading")}
						</h3>
						<label className="flex items-center gap-2 cursor-pointer mb-2">
							<input
								type="checkbox"
								checked={preserveComments}
								onChange={(e) => setPreserveComments(e.target.checked)}
								disabled={isTranslating}
								className="rounded accent-[var(--accent)]"
							/>
							<span className="text-sm">
								{t("crossLanguageTranslation:options.preserveComments")}
							</span>
						</label>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={generateTests}
								onChange={(e) => setGenerateTests(e.target.checked)}
								disabled={isTranslating}
								className="rounded accent-[var(--accent)]"
							/>
							<span className="text-sm">
								{t("crossLanguageTranslation:options.generateTests")}
							</span>
						</label>
					</div>

					<div className="flex-1">
						<div className="flex items-center justify-between mb-2">
							<h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
								{t("crossLanguageTranslation:history.heading")}
							</h3>
							{history.length > 0 && (
								<button
									type="button"
									onClick={() => projectPath && clearHistory(projectPath)}
									className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline"
								>
									{t("crossLanguageTranslation:history.clear")}
								</button>
							)}
						</div>
						{history.length === 0 ? (
							<p className="text-xs text-[var(--text-secondary)]">
								{t("crossLanguageTranslation:history.empty")}
							</p>
						) : (
							<div className="flex flex-col gap-1.5">
								{history.map((entry) => (
									<div
										key={entry.id}
										className="bg-[var(--bg-secondary)] rounded-lg p-2"
									>
										<div className="text-xs font-medium">
											{languageLabel(entry.source_lang)} →{" "}
											{languageLabel(entry.target_lang)}
										</div>
										<div className="text-xs text-[var(--text-secondary)] font-mono truncate">
											{entry.file_path}
										</div>
										<div
											className={`text-xs ${HISTORY_STATUS_COLORS[entry.status] ?? ""}`}
										>
											{t(
												`crossLanguageTranslation:historyStatus.${entry.status}`,
												entry.status,
											)}
										</div>
									</div>
								))}
							</div>
						)}
					</div>
				</div>

				{/* Right: source and result */}
				<div className="flex-1 flex flex-col overflow-hidden">
					{error && (
						<div className="m-4 mb-0 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-start justify-between gap-3">
							<span>{error}</span>
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
							<label
								htmlFor="translation-input"
								className="text-sm font-semibold mb-2"
							>
								{t("crossLanguageTranslation:editor.source", {
									language: languageLabel(sourceLang),
								})}
							</label>
							<textarea
								id="translation-input"
								value={inputCode}
								onChange={(e) => setInputCode(e.target.value)}
								disabled={isTranslating}
								spellCheck={false}
								placeholder={t("crossLanguageTranslation:editor.placeholder")}
								className="flex-1 w-full resize-none rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] p-3 text-xs font-mono"
							/>
						</div>

						<div className="flex flex-col overflow-hidden">
							<h2 className="text-sm font-semibold mb-2">
								{t("crossLanguageTranslation:editor.result", {
									language: languageLabel(targetLang),
								})}
							</h2>
							<div className="flex-1 overflow-auto rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] p-3">
								{displayedOutput ? (
									<pre className="text-xs font-mono whitespace-pre-wrap">
										{displayedOutput}
									</pre>
								) : (
									<p className="text-xs text-[var(--text-secondary)]">
										{isTranslating
											? t("crossLanguageTranslation:editor.translating")
											: t("crossLanguageTranslation:editor.resultEmpty")}
									</p>
								)}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

export default CrossLanguageTranslationDashboard;
