import {
	AlertTriangle,
	Check,
	Copy,
	GitBranch,
	RotateCcw,
	Terminal,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Notice, ScanLine } from "../charter";
import "../charter/charter.css";
import {
	executeGitCommand,
	useNaturalLanguageGitStore,
} from "@/stores/natural-language-git-store";
import { useProjectStore } from "../../stores/project-store";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

/**
 * NaturalLanguageGitDialog — Natural language Git interface.
 *
 * Shows a dialog where users can enter natural language commands,
 * see the generated Git commands, and execute them with confirmation.
 *
 * Usage:
 *   const { openDialog, closeDialog, isOpen } = useNaturalLanguageGitStore();
 *   <NaturalLanguageGitDialog />
 */
export function NaturalLanguageGitDialog() {
	const { t } = useTranslation(["naturalLanguageGit", "common", "navigation"]);
	const [copied, setCopied] = useState(false);
	const streamOutputRef = useRef<HTMLPreElement>(null);

	const {
		isOpen,
		closeDialog,
		phase,
		status,
		streamingOutput,
		result,
		error,
		naturalLanguageCommand,
		setNaturalLanguageCommand,
		reset,
	} = useNaturalLanguageGitStore();

	const selectedProjectId = useProjectStore((s) => s.selectedProjectId);

	// Auto-scroll streaming output
	useEffect(() => {
		if (streamOutputRef.current) {
			streamOutputRef.current.scrollTop = streamOutputRef.current.scrollHeight;
		}
	}, []);

	// Reset copied state when dialog opens
	useEffect(() => {
		if (isOpen) {
			setCopied(false);
		}
	}, [isOpen]);

	const handleExecute = useCallback(() => {
		if (!selectedProjectId) return;
		if (!naturalLanguageCommand.trim()) return;

		executeGitCommand(selectedProjectId);
	}, [selectedProjectId, naturalLanguageCommand]);

	const handleCopy = useCallback(async (text: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard not available
		}
	}, []);

	const handleTryAgain = useCallback(() => {
		reset();
		useNaturalLanguageGitStore.setState({
			isOpen: true,
			naturalLanguageCommand,
		});
	}, [reset, naturalLanguageCommand]);

	const handleClose = useCallback(() => {
		closeDialog();
	}, [closeDialog]);

	const isProcessing = phase === "processing";
	const isComplete = phase === "complete";
	const isError = phase === "error";
	const canExecute =
		naturalLanguageCommand.trim().length > 0 &&
		selectedProjectId &&
		!isProcessing;

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
			<DialogContent className="wp-scope sm:max-w-[700px] max-h-[85vh] flex flex-col">
				<DialogHeader>
					<span className="wp-kicker">
						{t("navigation:groups.gitIntegrations")}
					</span>
					<DialogTitle className="wp-title flex items-center gap-2">
						<GitBranch className="h-5 w-5 text-primary" />
						{t("naturalLanguageGit:title")}
					</DialogTitle>
					<DialogDescription>
						{t("naturalLanguageGit:description")}
					</DialogDescription>
				</DialogHeader>

				<div className="flex-1 overflow-y-auto space-y-4 py-2">
					{/* Natural Language Input */}
					<div className="space-y-2">
						<Label htmlFor="nl-git-command">
							{t("naturalLanguageGit:command.label")}
						</Label>
						<Textarea
							id="nl-git-command"
							value={naturalLanguageCommand}
							onChange={(e) => setNaturalLanguageCommand(e.target.value)}
							placeholder={t("naturalLanguageGit:command.placeholder")}
							className="min-h-[100px]"
							disabled={isProcessing}
						/>
						<div className="text-xs text-muted-foreground">
							{t("naturalLanguageGit:command.examples")}
						</div>
					</div>

					{/* No Project Warning */}
					{!selectedProjectId && (
						<Notice tone="amber" icon={AlertTriangle}>
							{t("naturalLanguageGit:errors.noProject")}
						</Notice>
					)}

					{/* Status / Streaming Output during processing */}
					{isProcessing && (
						<div className="space-y-3">
							<ScanLine
								label={status || t("naturalLanguageGit:status.processing")}
							/>
							{streamingOutput && (
								<div className="space-y-1">
									<Label className="text-xs text-muted-foreground">
										{t("naturalLanguageGit:result.streamingOutput")}
									</Label>
									<pre
										ref={streamOutputRef}
										className="wp-code max-h-[200px] overflow-y-auto whitespace-pre-wrap wrap-break-word p-3 text-xs"
									>
										{streamingOutput}
									</pre>
								</div>
							)}
						</div>
					)}

					{/* Error state */}
					{isError && (
						<Notice tone="red" icon={AlertTriangle} role="alert">
							<span className="font-medium">
								{t("naturalLanguageGit:status.error")}
							</span>
							<span className="mt-1 block text-xs">
								{error || t("naturalLanguageGit:errors.generic")}
							</span>
						</Notice>
					)}

					{/* Result */}
					{isComplete && result && (
						<ResultView
							result={result}
							copied={copied}
							onCopy={handleCopy}
							t={t}
						/>
					)}
				</div>

				{/* Footer Buttons */}
				<DialogFooter className="gap-2 sm:gap-0">
					{/* Idle / Input state */}
					{phase === "idle" && (
						<>
							<Button variant="outline" onClick={handleClose}>
								{t("naturalLanguageGit:actions.close")}
							</Button>
							<Button
								onClick={handleExecute}
								disabled={!canExecute}
								className="gap-2"
							>
								<Terminal className="h-4 w-4" />
								{t("naturalLanguageGit:actions.execute")}
							</Button>
						</>
					)}

					{/* Processing state */}
					{isProcessing && (
						<Button variant="outline" onClick={handleClose}>
							{t("naturalLanguageGit:actions.close")}
						</Button>
					)}

					{/* Error state */}
					{isError && (
						<>
							<Button variant="outline" onClick={handleClose}>
								{t("naturalLanguageGit:actions.close")}
							</Button>
							<Button onClick={handleTryAgain} className="gap-2">
								<RotateCcw className="h-4 w-4" />
								{t("naturalLanguageGit:actions.tryAgain")}
							</Button>
						</>
					)}

					{/* Complete state */}
					{isComplete && result && (
						<>
							<Button variant="outline" onClick={handleClose}>
								{t("naturalLanguageGit:actions.close")}
							</Button>
							<Button onClick={handleTryAgain} className="gap-2">
								<RotateCcw className="h-4 w-4" />
								{t("naturalLanguageGit:actions.newCommand")}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Renders the result: generated command, explanation, and execution output.
 */
function ResultView({
	result,
	copied,
	onCopy,
	t,
}: {
	readonly result: {
		generatedCommand: string;
		explanation: string;
		executionOutput: string;
		success: boolean;
	};
	readonly copied: boolean;
	readonly onCopy: (text: string) => void;
	readonly t: (key: string) => string;
}) {
	return (
		<div className="space-y-4">
			{/* Generated Command */}
			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label className="text-sm font-medium">
						{t("naturalLanguageGit:result.generatedCommand")}
					</Label>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onCopy(result.generatedCommand)}
						className="h-7 gap-1.5 text-xs"
					>
						{copied ? (
							<>
								<Check className="h-3 w-3" />
								{t("naturalLanguageGit:actions.copied")}
							</>
						) : (
							<>
								<Copy className="h-3 w-3" />
								{t("naturalLanguageGit:actions.copy")}
							</>
						)}
					</Button>
				</div>
				<div
					className={`rounded-lg p-3 font-mono text-sm ${result.success ? "bg-primary/5 border border-primary/20" : "bg-destructive/5 border border-destructive/20"}`}
				>
					<code>{result.generatedCommand}</code>
				</div>
			</div>

			{/* Explanation */}
			{result.explanation && (
				<div className="space-y-2">
					<Label className="text-sm font-medium">
						{t("naturalLanguageGit:result.explanation")}
					</Label>
					<div className="bg-muted/50 rounded-lg p-3">
						<p className="text-sm text-muted-foreground">
							{result.explanation}
						</p>
					</div>
				</div>
			)}

			{/* Execution Output */}
			{result.executionOutput && (
				<div className="space-y-2">
					<Label className="text-sm font-medium">
						{t("naturalLanguageGit:result.executionOutput")}
					</Label>
					<div
						className={`rounded-lg p-3 text-xs font-mono max-h-[200px] overflow-y-auto whitespace-pre-wrap ${result.success ? "bg-muted/50" : "bg-destructive/10"}`}
					>
						{result.executionOutput}
					</div>
				</div>
			)}

			{/* Execution Status */}
			<div
				className={`rounded-lg p-3 text-sm ${result.success ? "bg-success/10 text-success border border-success/30" : "bg-destructive/10 text-destructive border border-destructive/30"}`}
			>
				<div className="flex items-center gap-2">
					{result.success ? (
						<Check className="h-4 w-4" />
					) : (
						<X className="h-4 w-4" />
					)}
					<span className="font-medium">
						{result.success
							? t("naturalLanguageGit:result.executionSuccess")
							: t("naturalLanguageGit:result.executionError")}
					</span>
				</div>
			</div>
		</div>
	);
}

export default NaturalLanguageGitDialog;
