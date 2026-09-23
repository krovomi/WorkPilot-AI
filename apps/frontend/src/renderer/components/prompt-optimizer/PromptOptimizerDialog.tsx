import {
	AlertTriangle,
	ArrowRight,
	Check,
	CheckCircle2,
	ChevronDown,
	Circle,
	Code2,
	Copy,
	Cpu,
	Loader2,
	PencilLine,
	Plus,
	RotateCcw,
	Search,
	ShieldCheck,
	Sparkles,
	Square,
	WandSparkles,
} from "lucide-react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { PromptOptimizerStatus } from "../../../shared/types/prompt-optimizer";
import { resolvePageLlm } from "../../../shared/utils/page-llm";
import { cn } from "../../lib/utils";
import { useProjectStore } from "../../stores/project-store";
import type { AgentType } from "../../stores/prompt-optimizer-store";
import {
	cancelOptimization,
	extractStreamingPrompt,
	refineFromResult,
	startOptimization,
	usePromptOptimizerStore,
} from "../../stores/prompt-optimizer-store";
import { useSettingsStore } from "../../stores/settings-store";
import { Button } from "../ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "../ui/collapsible";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Textarea } from "../ui/textarea";

const AGENT_TYPES: ReadonlyArray<{
	value: AgentType;
	icon: typeof Sparkles;
}> = [
	{ value: "general", icon: Sparkles },
	{ value: "analysis", icon: Search },
	{ value: "coding", icon: Code2 },
	{ value: "verification", icon: ShieldCheck },
];

const STEPS: readonly PromptOptimizerStatus[] = [
	"context",
	"generating",
	"parsing",
];

/** Error codes that have their own sentence; anything else reads as generic. */
const KNOWN_ERROR_CODES = new Set([
	"auth",
	"rate_limit",
	"quota",
	"network",
	"timeout",
	"provider_unavailable",
	"provider_error",
	"empty_response",
	"runner_missing",
	"python_missing",
	"project_not_found",
	"spawn_failed",
	"process_failed",
]);

const isMac = () =>
	typeof navigator !== "undefined" && navigator.platform.includes("Mac");

/**
 * PromptOptimizerDialog — AI-powered prompt enhancement dialog.
 *
 * Rendered once (in the sidebar). Whoever opens it names where the result
 * goes: the task form passes a target to `openDialog`, so "Use this prompt"
 * writes back into the description it was opened from. The prop remains for
 * a caller that renders its own instance.
 */
interface PromptOptimizerDialogProps {
	/** Called when the user clicks "Use This Prompt" with the optimized text */
	readonly onUsePrompt?: (optimizedPrompt: string) => void;
}

export function PromptOptimizerDialog({
	onUsePrompt,
}: PromptOptimizerDialogProps) {
	const { t } = useTranslation(["promptOptimizer", "common"]);

	const {
		isOpen,
		closeDialog,
		phase,
		status,
		streamingOutput,
		result,
		error,
		errorCode,
		initialPrompt,
		submittedPrompt,
		agentType,
		setAgentType,
		applyTarget,
	} = usePromptOptimizerStore();

	const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
	const settings = useSettingsStore((s) => s.settings);
	const engine = useMemo(
		() => resolvePageLlm(settings, "prompt-optimizer"),
		[settings],
	);

	const [editablePrompt, setEditablePrompt] = useState("");
	const [editedResult, setEditedResult] = useState("");

	// Mirror the store's prompt whenever it changes from outside (opening,
	// "refine again", "new prompt").
	useEffect(() => {
		if (isOpen) setEditablePrompt(initialPrompt);
	}, [isOpen, initialPrompt]);

	useEffect(() => {
		setEditedResult(result?.optimized ?? "");
	}, [result]);

	const isIdle = phase === "idle";
	const isOptimizing = phase === "optimizing";
	const isComplete = phase === "complete" && result !== null;
	const isError = phase === "error";

	const canOptimize =
		editablePrompt.trim().length > 0 && !!selectedProjectId && !isOptimizing;
	const applyPrompt = onUsePrompt ?? applyTarget;

	const handleOptimize = useCallback(() => {
		if (!selectedProjectId || !editablePrompt.trim()) return;
		usePromptOptimizerStore.setState({ initialPrompt: editablePrompt });
		startOptimization(selectedProjectId);
	}, [selectedProjectId, editablePrompt]);

	const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			if (canOptimize) handleOptimize();
		}
	};

	const handleUsePrompt = useCallback(() => {
		if (!applyPrompt || !editedResult.trim()) return;
		applyPrompt(editedResult);
		usePromptOptimizerStore.getState().reset();
	}, [applyPrompt, editedResult]);

	const handleEditPrompt = useCallback(() => {
		usePromptOptimizerStore.setState({
			phase: "idle",
			error: null,
			errorCode: null,
			streamingOutput: "",
			result: null,
		});
	}, []);

	const handleNewPrompt = useCallback(() => {
		usePromptOptimizerStore.setState({
			phase: "idle",
			result: null,
			streamingOutput: "",
			initialPrompt: "",
			submittedPrompt: "",
		});
	}, []);

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && closeDialog()}>
			<DialogContent className="sm:max-w-[760px] max-h-[88vh] flex flex-col gap-0 p-0 overflow-hidden">
				<DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
					<DialogTitle className="flex items-center gap-2">
						<span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
							<WandSparkles className="h-4 w-4 text-primary" />
						</span>
						{t("promptOptimizer:title")}
					</DialogTitle>
					<DialogDescription>
						{t("promptOptimizer:description")}
					</DialogDescription>
					<EngineChip
						provider={engine.provider}
						model={engine.model}
						label={t("promptOptimizer:engine.label")}
						fallback={t("promptOptimizer:engine.default")}
					/>
				</DialogHeader>

				<div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
					{!selectedProjectId && (
						<div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
							<AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
							{t("promptOptimizer:errors.noProject")}
						</div>
					)}

					{isIdle && (
						<>
							<div className="space-y-2">
								<div className="flex items-center justify-between">
									<Label htmlFor="optimizer-prompt">
										{t("promptOptimizer:prompt.label")}
									</Label>
									<span className="text-xs text-muted-foreground tabular-nums">
										{t("promptOptimizer:prompt.characters", {
											count: editablePrompt.length,
										})}
									</span>
								</div>
								<Textarea
									id="optimizer-prompt"
									value={editablePrompt}
									onChange={(e) => setEditablePrompt(e.target.value)}
									onKeyDown={handlePromptKeyDown}
									placeholder={t("promptOptimizer:prompt.placeholder")}
									className="min-h-[140px] resize-y"
									autoFocus
								/>
								<p className="text-xs text-muted-foreground">
									{t("promptOptimizer:prompt.shortcut", {
										modifier: isMac() ? "⌘" : "Ctrl",
									})}
								</p>
							</div>

							<AgentTypePicker
								value={agentType}
								onChange={setAgentType}
								t={t}
							/>
						</>
					)}

					{isOptimizing && (
						<OptimizingView
							status={status}
							preview={extractStreamingPrompt(streamingOutput)}
							submittedPrompt={submittedPrompt}
							t={t}
						/>
					)}

					{isError && (
						<ErrorView code={errorCode} detail={error} t={t} />
					)}

					{isComplete && result && (
						<ResultView
							original={submittedPrompt}
							edited={editedResult}
							onEdit={setEditedResult}
							changes={result.changes}
							reasoning={result.reasoning}
							t={t}
						/>
					)}
				</div>

				<DialogFooter className="px-6 py-4 border-t border-border bg-muted/30 gap-2 sm:gap-2">
					{isIdle && (
						<>
							<Button variant="ghost" onClick={closeDialog}>
								{t("promptOptimizer:actions.close")}
							</Button>
							<Button
								onClick={handleOptimize}
								disabled={!canOptimize}
								className="gap-2"
							>
								<Sparkles className="h-4 w-4" />
								{t("promptOptimizer:actions.optimize")}
							</Button>
						</>
					)}

					{isOptimizing && (
						<>
							<Button
								variant="ghost"
								onClick={cancelOptimization}
								className="gap-2"
							>
								<Square className="h-3.5 w-3.5" />
								{t("promptOptimizer:actions.cancel")}
							</Button>
							<Button variant="outline" onClick={closeDialog}>
								{t("promptOptimizer:actions.runInBackground")}
							</Button>
						</>
					)}

					{isError && (
						<>
							<Button variant="ghost" onClick={closeDialog}>
								{t("promptOptimizer:actions.close")}
							</Button>
							<Button
								variant="outline"
								onClick={handleEditPrompt}
								className="gap-2"
							>
								<PencilLine className="h-4 w-4" />
								{t("promptOptimizer:actions.editPrompt")}
							</Button>
							<Button
								onClick={handleOptimize}
								disabled={!canOptimize}
								className="gap-2"
							>
								<RotateCcw className="h-4 w-4" />
								{t("promptOptimizer:actions.tryAgain")}
							</Button>
						</>
					)}

					{isComplete && (
						<>
							<Button
								variant="ghost"
								onClick={handleNewPrompt}
								className="gap-2 sm:mr-auto"
							>
								<Plus className="h-4 w-4" />
								{t("promptOptimizer:actions.newPrompt")}
							</Button>
							<Button
								variant="outline"
								onClick={refineFromResult}
								className="gap-2"
							>
								<WandSparkles className="h-4 w-4" />
								{t("promptOptimizer:actions.refine")}
							</Button>
							<CopyButton text={editedResult} t={t} />
							{applyPrompt && (
								<Button
									onClick={handleUsePrompt}
									disabled={!editedResult.trim()}
									className="gap-2"
								>
									<Check className="h-4 w-4" />
									{t("promptOptimizer:actions.usePrompt")}
								</Button>
							)}
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

type T = (key: string, options?: Record<string, unknown>) => string;

function EngineChip({
	provider,
	model,
	label,
	fallback,
}: {
	readonly provider: string;
	readonly model: string;
	readonly label: string;
	readonly fallback: string;
}) {
	const text = [provider || fallback, model].filter(Boolean).join(" · ");
	return (
		<div className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
			<Cpu className="h-3.5 w-3.5" />
			<span>{label}</span>
			<span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
				{text}
			</span>
		</div>
	);
}

function AgentTypePicker({
	value,
	onChange,
	t,
}: {
	readonly value: AgentType;
	readonly onChange: (value: AgentType) => void;
	readonly t: T;
}) {
	return (
		<fieldset className="space-y-2">
			<legend className="mb-2 text-sm font-medium leading-none">
				{t("promptOptimizer:agentType.label")}
			</legend>
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				{AGENT_TYPES.map(({ value: type, icon: Icon }) => {
					const selected = type === value;
					return (
						<button
							key={type}
							type="button"
							aria-pressed={selected}
							onClick={() => onChange(type)}
							className={cn(
								"flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								selected
									? "border-primary bg-primary/5"
									: "border-border hover:border-primary/40 hover:bg-muted/50",
							)}
						>
							<span className="flex items-center gap-1.5 text-sm font-medium">
								<Icon
									className={cn(
										"h-4 w-4",
										selected ? "text-primary" : "text-muted-foreground",
									)}
								/>
								{t(`promptOptimizer:agentType.options.${type}`)}
							</span>
							<span className="text-xs leading-snug text-muted-foreground">
								{t(`promptOptimizer:agentType.descriptions.${type}`)}
							</span>
						</button>
					);
				})}
			</div>
		</fieldset>
	);
}

function OptimizingView({
	status,
	preview,
	submittedPrompt,
	t,
}: {
	readonly status: PromptOptimizerStatus | "";
	readonly preview: string;
	readonly submittedPrompt: string;
	readonly t: T;
}) {
	const previewRef = useRef<HTMLDivElement>(null);
	const current = Math.max(0, STEPS.indexOf(status || "context"));

	// Follow the text as it is written.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on each new chunk
	useEffect(() => {
		const el = previewRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [preview]);

	return (
		<div className="space-y-5">
			<ol className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
				{STEPS.map((step, index) => {
					const done = index < current;
					const active = index === current;
					return (
						<li key={step} className="flex items-center gap-2 text-sm">
							{done ? (
								<CheckCircle2 className="h-4 w-4 text-primary" />
							) : active ? (
								<Loader2 className="h-4 w-4 animate-spin text-primary" />
							) : (
								<Circle className="h-4 w-4 text-muted-foreground/50" />
							)}
							<span
								className={cn(
									active
										? "font-medium text-foreground"
										: done
											? "text-foreground/80"
											: "text-muted-foreground",
								)}
							>
								{t(`promptOptimizer:status.${step}`)}
							</span>
							{index < STEPS.length - 1 && (
								<ArrowRight className="hidden h-3.5 w-3.5 text-muted-foreground/50 sm:block" />
							)}
						</li>
					);
				})}
			</ol>

			<div className="space-y-2">
				<Label className="text-xs uppercase tracking-wide text-muted-foreground">
					{t("promptOptimizer:result.livePreview")}
				</Label>
				<div
					ref={previewRef}
					aria-live="off"
					className="min-h-[140px] max-h-[300px] overflow-y-auto rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm whitespace-pre-wrap wrap-break-word"
				>
					{preview ? (
						<>
							{preview}
							<span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-primary/60" />
						</>
					) : (
						<span className="text-muted-foreground italic">
							{t("promptOptimizer:result.waitingPreview")}
						</span>
					)}
				</div>
			</div>

			<Collapsible>
				<CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
					<ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
					{t("promptOptimizer:result.originalPrompt")}
				</CollapsibleTrigger>
				<CollapsibleContent>
					<p className="mt-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground whitespace-pre-wrap">
						{submittedPrompt}
					</p>
				</CollapsibleContent>
			</Collapsible>

			<p className="text-xs text-muted-foreground">
				{t("promptOptimizer:status.backgroundHint")}
			</p>
		</div>
	);
}

function ErrorView({
	code,
	detail,
	t,
}: {
	readonly code: string | null;
	readonly detail: string | null;
	readonly t: T;
}) {
	const key = code && KNOWN_ERROR_CODES.has(code) ? code : "generic";
	return (
		<div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
			<div className="flex items-start gap-2">
				<AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
				<div className="space-y-1">
					<p className="text-sm font-medium text-destructive">
						{t("promptOptimizer:status.error")}
					</p>
					<p className="text-sm text-foreground/80">
						{t(`promptOptimizer:errors.codes.${key}`)}
					</p>
				</div>
			</div>
			{detail && (
				<Collapsible>
					<CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
						<ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
						{t("promptOptimizer:errors.details")}
					</CollapsibleTrigger>
					<CollapsibleContent>
						<pre className="mt-2 max-h-[160px] overflow-auto rounded-md bg-background/60 p-2 text-xs font-mono whitespace-pre-wrap wrap-break-word">
							{detail}
						</pre>
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}

function ResultView({
	original,
	edited,
	onEdit,
	changes,
	reasoning,
	t,
}: {
	readonly original: string;
	readonly edited: string;
	readonly onEdit: (value: string) => void;
	readonly changes: string[];
	readonly reasoning: string;
	readonly t: T;
}) {
	return (
		<div className="space-y-5">
			<Tabs defaultValue="optimized">
				<TabsList>
					<TabsTrigger value="optimized">
						{t("promptOptimizer:result.tabs.optimized")}
					</TabsTrigger>
					<TabsTrigger value="compare">
						{t("promptOptimizer:result.tabs.compare")}
					</TabsTrigger>
				</TabsList>

				<TabsContent value="optimized" className="mt-3 space-y-1.5">
					<Textarea
						aria-label={t("promptOptimizer:result.title")}
						value={edited}
						onChange={(e) => onEdit(e.target.value)}
						className="min-h-[220px] resize-y border-primary/30 bg-primary/5 text-sm"
					/>
					<p className="text-xs text-muted-foreground">
						{t("promptOptimizer:result.editHint")}
					</p>
				</TabsContent>

				<TabsContent value="compare" className="mt-3">
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label className="text-xs uppercase tracking-wide text-muted-foreground">
								{t("promptOptimizer:result.before")}
							</Label>
							<div className="max-h-[320px] min-h-[120px] overflow-y-auto rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground whitespace-pre-wrap wrap-break-word">
								{original}
							</div>
						</div>
						<div className="space-y-1.5">
							<Label className="text-xs uppercase tracking-wide text-primary">
								{t("promptOptimizer:result.after")}
							</Label>
							<div className="max-h-[320px] min-h-[120px] overflow-y-auto rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm whitespace-pre-wrap wrap-break-word">
								{edited}
							</div>
						</div>
					</div>
				</TabsContent>
			</Tabs>

			<div className="space-y-2">
				<Label className="text-sm font-medium">
					{t("promptOptimizer:result.changes")}
				</Label>
				{changes.length > 0 ? (
					<ul className="space-y-1.5">
						{changes.map((change, index) => (
							<li
								// biome-ignore lint/suspicious/noArrayIndexKey: two identical lines are two changes
								key={`${index}-${change}`}
								className="flex items-start gap-2 text-sm text-muted-foreground"
							>
								<Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
								<span>{change}</span>
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm italic text-muted-foreground">
						{t("promptOptimizer:result.noChanges")}
					</p>
				)}
			</div>

			{reasoning && (
				<div className="space-y-2">
					<Label className="text-sm font-medium">
						{t("promptOptimizer:result.reasoning")}
					</Label>
					<p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
						{reasoning}
					</p>
				</div>
			)}
		</div>
	);
}

function CopyButton({ text, t }: { readonly text: string; readonly t: T }) {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [copied]);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
		} catch {
			// Clipboard not available
		}
	};

	return (
		<Button
			variant="outline"
			onClick={copy}
			disabled={!text.trim()}
			className="gap-2"
		>
			{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
			{copied
				? t("promptOptimizer:actions.copied")
				: t("promptOptimizer:actions.copy")}
		</Button>
	);
}

export default PromptOptimizerDialog;
