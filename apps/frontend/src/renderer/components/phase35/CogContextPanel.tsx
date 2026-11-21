/**
 * #3.2 Cognitive Context Optimizer panel.
 *
 * A task's wording + the project's files + a token budget → which files (or
 * which slices of them) fit, with their relevance. Files are the project's
 * own: picked in the project, typed relative to it, or proposed by the
 * backend when the list is empty. A path outside the project is refused by
 * the backend and listed with its reason, never read.
 *
 * The same packing feeds the coder's inlined file context when
 * WORKPILOT_COGNITIVE_CONTEXT_ENABLED is on.
 */

import { Check, Copy, FileText, FolderOpen, Plus, Scissors, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useCogContextStore } from "../../stores/phase35-stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { PanelShell } from "./_panel-shell";
import { relativeToProject } from "./_relative-to-project";
import { TokenCostEstimate } from "./_token-cost-estimate";

const PROMPT_MAX_LEN = 4000;
const PATH_MAX_LEN = 1024;
const BUDGET_MIN = 100;
// The backend accepts at most 200 000 tokens.
const BUDGET_MAX = 200_000;
const REFUSAL_REASONS = ["outside", "missing", "binary", "too_large"] as const;

const basename = (p: string): string => {
	const cleaned = p.replace(/[\\/]+$/, "");
	const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
	return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
};

interface CogContextPanelProps {
	readonly projectPath?: string;
}

export function CogContextPanel({ projectPath = "" }: CogContextPanelProps) {
	const { t } = useTranslation("phase35");
	const { phase, error, context, optimize } = useCogContextStore(
		useShallow((s) => ({
			phase: s.phase,
			error: s.error,
			context: s.context,
			optimize: s.optimize,
		})),
	);
	const [prompt, setPrompt] = useState("");
	const [files, setFiles] = useState<string[]>([]);
	const [manualPath, setManualPath] = useState("");
	const [manualError, setManualError] = useState<string | null>(null);
	const [budget, setBudget] = useState(8000);
	const [copied, setCopied] = useState(false);
	const [copyFailed, setCopyFailed] = useState(false);
	const [pickFailed, setPickFailed] = useState(false);

	const isRunning = phase === "running";

	const promptError = useMemo(
		() => (prompt.trim().length === 0 ? t("cogContext.validation.promptRequired") : null),
		[prompt, t],
	);
	// The field keeps a whole number (0 when it does not parse): only the bounds can be wrong.
	const budgetError = useMemo(() => {
		if (budget < BUDGET_MIN) return t("cogContext.validation.budgetTooSmall");
		if (budget > BUDGET_MAX) return t("cogContext.validation.budgetTooLarge");
		return null;
	}, [budget, t]);

	const hasError = !projectPath || Boolean(promptError) || Boolean(budgetError);

	const addPaths = (paths: string[]) =>
		setFiles((prev) => {
			const merged = [...prev];
			for (const p of paths) {
				const shown = relativeToProject(p, projectPath);
				if (!merged.includes(shown)) merged.push(shown);
			}
			return merged;
		});

	const handlePickFiles = async () => {
		setPickFailed(false);
		try {
			// A cancelled dialog answers an empty list; only a failure throws.
			addPaths(
				await globalThis.electronAPI.selectFiles({
					multi: true,
					title: t("cogContext.addFiles"),
					defaultPath: projectPath,
				}),
			);
		} catch {
			setPickFailed(true);
		}
	};

	const handleAddManual = () => {
		const trimmed = manualPath.trim();
		if (trimmed.length === 0) {
			setManualError(t("common.required"));
			return;
		}
		if (files.includes(relativeToProject(trimmed, projectPath))) {
			setManualError(t("cogContext.validation.duplicatePath"));
			return;
		}
		addPaths([trimmed]);
		setManualPath("");
		setManualError(null);
	};

	const handleRemove = (path: string) => setFiles((prev) => prev.filter((p) => p !== path));

	const handleRun = () => {
		setCopied(false);
		setCopyFailed(false);
		optimize(projectPath, prompt.trim(), files, budget);
	};

	const handleCopy = async (slices: NonNullable<typeof context>["slices"]) => {
		const text = slices
			.map((s) => `### ${s.file_path}\n\`\`\`\n${s.content}\n\`\`\``)
			.join("\n\n");
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setCopyFailed(false);
		} catch {
			// The system refused the clipboard: say so rather than leave the click unanswered.
			setCopied(false);
			setCopyFailed(true);
		}
	};

	if (!projectPath) {
		return (
			<PanelShell title={t("cogContext.title")} subtitle={t("cogContext.subtitle")}>
				<p className="text-sm text-muted-foreground">{t("common.projectPathRequired")}</p>
			</PanelShell>
		);
	}

	const fillRatio = context?.token_budget
		? Math.round((context.tokens_used / context.token_budget) * 100)
		: 0;
	const refused = context?.refused ?? [];
	const keywords = (context?.summary?.keywords_detected as string[] | undefined) ?? [];

	return (
		<PanelShell
			title={t("cogContext.title")}
			subtitle={t("cogContext.subtitle")}
			error={error}
			actions={
				<Button size="sm" onClick={handleRun} disabled={isRunning || hasError}>
					{isRunning ? t("common.running") : t("cogContext.optimize")}
				</Button>
			}
		>
			<div className="space-y-3 text-sm">
				<div>
					<label htmlFor="prompt-textarea" className="block font-medium mb-1">
						{t("cogContext.prompt")}
					</label>
					<Textarea
						id="prompt-textarea"
						value={prompt}
						onChange={(e) => setPrompt(e.target.value.slice(0, PROMPT_MAX_LEN))}
						rows={2}
						maxLength={PROMPT_MAX_LEN}
						aria-invalid={Boolean(promptError) || undefined}
						aria-describedby={promptError ? "cog-prompt-error" : undefined}
						className="w-full p-2 text-sm min-h-0"
					/>
					{promptError && (
						<p id="cog-prompt-error" className="mt-1 text-xs text-destructive">
							{promptError}
						</p>
					)}
				</div>

				<div className="grid grid-cols-3 gap-3">
					<div className="col-span-2 space-y-2">
						<div className="flex items-center justify-between">
							<div className="font-medium">
								{t("cogContext.candidateFiles")}{" "}
								<span className="text-xs text-muted-foreground">
									({t("cogContext.fileCount", { count: files.length })})
								</span>
							</div>
							<div className="flex items-center gap-1">
								<Button type="button" size="sm" variant="outline" onClick={handlePickFiles}>
									<FolderOpen className="h-3.5 w-3.5 mr-1" />
									{t("cogContext.addFiles")}
								</Button>
								{files.length > 0 && (
									<Button type="button" size="sm" variant="ghost" onClick={() => setFiles([])}>
										{t("cogContext.clearFiles")}
									</Button>
								)}
							</div>
						</div>

						{pickFailed && (
							<p role="alert" className="text-xs text-destructive">
								{t("common.pickerFailed")}
							</p>
						)}
						<div className="rounded border bg-background">
							{files.length === 0 ? (
								<p className="px-3 py-4 text-xs text-muted-foreground text-center">
									{t("cogContext.noFiles")}
								</p>
							) : (
								<ul className="divide-y max-h-48 overflow-auto">
									{files.map((p) => (
										<li key={p} className="flex items-center gap-2 px-2 py-1.5 text-xs">
											<FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
											<div className="flex min-w-0 flex-1 flex-col">
												<span className="truncate font-medium">{basename(p)}</span>
												<span className="truncate font-mono text-3xs text-muted-foreground" title={p}>
													{p}
												</span>
											</div>
											<button
												type="button"
												onClick={() => handleRemove(p)}
												aria-label={t("cogContext.removeFile")}
												className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
											>
												<X className="h-3.5 w-3.5" />
											</button>
										</li>
									))}
								</ul>
							)}
						</div>

						<div className="flex items-start gap-2">
							<div className="flex-1">
								<Input
									spellCheck={false}
									value={manualPath}
									onChange={(e) => {
										setManualPath(e.target.value.slice(0, PATH_MAX_LEN));
										if (manualError) setManualError(null);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											handleAddManual();
										}
									}}
									maxLength={PATH_MAX_LEN}
									aria-label={t("cogContext.addManually")}
									aria-invalid={Boolean(manualError) || undefined}
									aria-describedby={manualError ? "cog-manual-error" : undefined}
									className="w-full p-2 font-mono text-xs h-auto"
									placeholder={t("cogContext.manualPathPlaceholder")}
								/>
								{manualError && (
									<p id="cog-manual-error" className="mt-1 text-xs text-destructive">
										{manualError}
									</p>
								)}
							</div>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={handleAddManual}
								disabled={manualPath.trim().length === 0}
							>
								<Plus className="h-3.5 w-3.5 mr-1" />
								{t("cogContext.add")}
							</Button>
						</div>
					</div>

					<div>
						<label htmlFor="budget-input" className="block font-medium mb-1">
							{t("cogContext.tokenBudget")}
						</label>
						<Input
							id="budget-input"
							type="number"
							min={BUDGET_MIN}
							max={BUDGET_MAX}
							step={100}
							value={budget}
							onChange={(e) => {
								const parsed = Number.parseInt(e.target.value, 10);
								setBudget(Number.isFinite(parsed) ? parsed : 0);
							}}
							aria-invalid={Boolean(budgetError) || undefined}
							aria-describedby={budgetError ? "cog-budget-error" : undefined}
							className="w-full p-2 text-sm h-auto"
						/>
						{budgetError && (
							<p id="cog-budget-error" className="mt-1 text-xs text-destructive">
								{budgetError}
							</p>
						)}
						{!budgetError && (
							<TokenCostEstimate totalTokens={budget} outputRatio={0.25} />
						)}
					</div>
				</div>

				{context && (
					<div className="space-y-2">
						{context.discovered && (
							<p className="text-xs text-muted-foreground">
								{t("cogContext.discovered", {
									count: Number(context.summary?.candidates ?? 0),
								})}
							</p>
						)}
						<div className="flex flex-wrap items-center gap-2">
							<Badge variant="outline">
								{t("cogContext.included")} : {context.slices.length}
							</Badge>
							<Badge variant="outline">
								{t("cogContext.skipped")} : {context.files_skipped.length}
							</Badge>
							<Badge variant="outline">
								{t("cogContext.fillRatio")} : {fillRatio} %
							</Badge>
							{context.slices.length > 0 && (
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() => void handleCopy(context.slices)}
								>
									{copied ? (
										<Check className="h-3.5 w-3.5 mr-1" />
									) : (
										<Copy className="h-3.5 w-3.5 mr-1" />
									)}
									{copied ? t("cogContext.copied") : t("cogContext.copy")}
								</Button>
							)}
						</div>
						{copyFailed && (
							<p role="alert" className="text-xs text-destructive">
								{t("cogContext.copyFailed")}
							</p>
						)}
						{keywords.length > 0 && (
							<p className="text-xs text-muted-foreground">
								{t("cogContext.keywords", { list: keywords.join(", ") })}
							</p>
						)}
						{refused.length > 0 && (
							<div className="rounded border border-destructive/40 p-2 text-xs">
								<p className="font-medium">{t("cogContext.refusedTitle")}</p>
								<ul className="mt-1 space-y-0.5">
									{refused.map((r) => (
										<li key={r.path} className="font-mono">
											{r.path}{" "}
											<span className="font-sans text-muted-foreground">
												(
												{REFUSAL_REASONS.includes(r.reason as (typeof REFUSAL_REASONS)[number])
													? t(`cogContext.refused.${r.reason}` as never)
													: r.reason}
												)
											</span>
										</li>
									))}
								</ul>
							</div>
						)}
						{context.slices.length === 0 ? (
							<p className="text-xs text-muted-foreground">{t("cogContext.noneIncluded")}</p>
						) : (
							<ul className="divide-y rounded border">
								{context.slices.map((s) => (
									<li key={s.file_path} className="p-2">
										<details>
											<summary className="flex cursor-pointer items-center gap-2 text-xs">
												<span className="min-w-0 flex-1 truncate font-mono" title={s.file_path}>
													{s.file_path}
												</span>
												{s.truncated && (
													<Badge variant="outline" className="gap-1">
														<Scissors className="h-3 w-3" aria-hidden="true" />
														{t("cogContext.truncated")}
													</Badge>
												)}
												<span className="text-muted-foreground">
													{t("cogContext.scoreTokens", {
														score: s.relevance.score.toFixed(2),
														included: s.included_tokens,
														full: s.full_size_tokens,
													})}
												</span>
											</summary>
											<pre className="mt-2 max-h-64 overflow-auto rounded bg-muted/40 p-2 font-mono text-3xs">
												{s.content}
											</pre>
										</details>
									</li>
								))}
							</ul>
						)}
						{context.files_skipped.length > 0 && (
							<p className="text-xs text-muted-foreground">
								{t("cogContext.skippedList", { list: context.files_skipped.join(", ") })}
							</p>
						)}
					</div>
				)}
			</div>
		</PanelShell>
	);
}
