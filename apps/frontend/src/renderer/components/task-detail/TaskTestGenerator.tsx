import {
	CheckCircle2,
	FlaskConical,
	Loader2,
	XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task, WorktreeDiff } from "../../../shared/types";
import type { TestGenerationError } from "../../../shared/types/test-generation";
import { normalizeTestGenerationError } from "../../../shared/types/test-generation";
import {
	classifyTestStrategy,
	isGeneratableStrategy,
	type TestStrategy,
} from "../../../shared/utils/test-strategy";
import { cn } from "../../lib/utils";
import { useTestDestinationPrompt } from "../../hooks/use-test-destination-prompt";
import { useToast } from "../../hooks/use-toast";
import { TestDestinationDialog } from "../test-generation/TestDestinationDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

type FileGenerationState = "idle" | "generating" | "done" | "error";

interface FilePlan {
	path: string;
	strategy: TestStrategy;
	selected: boolean;
	state: FileGenerationState;
	testPath?: string;
	error?: string;
}

interface TaskTestGeneratorProps {
	readonly task: Task;
	readonly worktreeDiff: WorktreeDiff | null;
	readonly worktreePath?: string;
	/** Called after test files were written so the parent can refresh the diff. */
	readonly onTestsWritten?: () => void;
}

interface GenerationOutput {
	test_file_path: string;
	test_file_content: string;
}

const STRATEGY_BADGE_CLASSES: Record<Exclude<TestStrategy, "skip">, string> = {
	unit: "bg-info/10 text-info",
	api: "bg-success/10 text-success",
	"e2e-web": "bg-warning/10 text-[var(--warning)]",
	"desktop-ui": "bg-purple-500/10 text-purple-400",
};

/**
 * Make the suggested test path relative to the worktree, normalized to "/".
 *
 * Returns null for a path outside the worktree. That is not hypothetical since
 * the destination can be chosen: joining `/home/me/elsewhere/X.cs` onto the
 * worktree passes the main process's traversal check and quietly creates
 * `<worktree>/home/me/elsewhere/X.cs`, a junk tree in the diff. The caller
 * reports it instead — the generator has already written the real file where
 * the user asked.
 */
export function toWorktreeRelativePath(
	suggestedPath: string,
	worktreePath: string,
): string | null {
	const normalizedSuggested = suggestedPath.replaceAll("\\", "/");
	const normalizedWorktree = worktreePath.replaceAll("\\", "/").replace(/\/$/, "");
	if (
		normalizedSuggested.toLowerCase().startsWith(
			`${normalizedWorktree.toLowerCase()}/`,
		)
	) {
		return normalizedSuggested.slice(normalizedWorktree.length + 1);
	}
	// A relative path is already worktree-relative; an absolute one is not ours.
	return normalizedSuggested.startsWith("/") ? null : normalizedSuggested;
}

/**
 * Generate tests for the files touched by the task, with a per-file strategy
 * (unit / API / web E2E / desktop UI) inferred from the file type and path.
 * Generated test files are written INTO the worktree so they are reviewed and
 * shipped with the same PR as the change they cover.
 */
export function TaskTestGenerator({
	task,
	worktreeDiff,
	worktreePath,
	onTestsWritten,
}: TaskTestGeneratorProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const [plans, setPlans] = useState<FilePlan[]>([]);
	const [isGenerating, setIsGenerating] = useState(false);
	const isMountedRef = useRef(true);
	const destinationPrompt = useTestDestinationPrompt();

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	const changedPaths = useMemo(
		() =>
			(worktreeDiff?.files ?? [])
				.filter((file) => file.status !== "deleted")
				.map((file) => file.path),
		[worktreeDiff?.files],
	);

	// Rebuild plans when the diff changes (keep nothing from previous runs:
	// the diff is the source of truth for what is testable)
	useEffect(() => {
		setPlans(
			changedPaths.map((path) => {
				const strategy = classifyTestStrategy(path, changedPaths);
				return {
					path,
					strategy,
					selected: isGeneratableStrategy(strategy),
					state: "idle" as const,
				};
			}),
		);
	}, [changedPaths]);

	const generatablePlans = plans.filter((plan) =>
		isGeneratableStrategy(plan.strategy),
	);
	const selectedPlans = generatablePlans.filter((plan) => plan.selected);

	if (!worktreePath || generatablePlans.length === 0) {
		return null;
	}

	const updatePlan = (path: string, updates: Partial<FilePlan>) => {
		if (!isMountedRef.current) return;
		setPlans((previous) =>
			previous.map((plan) =>
				plan.path === path ? { ...plan, ...updates } : plan,
			),
		);
	};

	/**
	 * One-shot wrapper around the global test-generation events. The main
	 * service runs a single generation at a time, so calls are sequential.
	 */
	const generateOne = (
		plan: FilePlan,
		testDir?: string,
	): Promise<GenerationOutput> => {
		return new Promise<GenerationOutput>((resolve, reject) => {
			const api = globalThis.electronAPI;
			const cleanup = () => {
				api.removeTestGenerationCompleteListener(onComplete);
				api.removeTestGenerationErrorListener(onError);
			};
			const onComplete = (data: unknown) => {
				cleanup();
				const result = (data as { result?: GenerationOutput }).result;
				if (result?.test_file_content && result.test_file_path) {
					resolve(result);
				} else {
					reject(new Error(t("tasks:testGen.emptyResult")));
				}
			};
			// The main process now sends a structured failure; normalising here
			// keeps the per-file error chip readable instead of "[object Object]".
			const onError = (error: TestGenerationError | string) => {
				cleanup();
				reject(
					new Error(
						normalizeTestGenerationError(error, t("tasks:testGen.emptyResult"))
							.message,
					),
				);
			};
			api.onTestGenerationComplete(onComplete);
			api.onTestGenerationError(onError);

			const absolutePath = `${worktreePath.replaceAll("\\", "/")}/${plan.path.replaceAll("\\", "/")}`;
			if (plan.strategy === "e2e-web") {
				// E2E: the user story drives the scenario; the file localizes it
				const userStory = [task.title, task.description?.slice(0, 1500)]
					.filter(Boolean)
					.join("\n\n");
				api.generateE2ETests(userStory, absolutePath, worktreePath, testDir);
			} else {
				api.generateUnitTests(
					absolutePath,
					undefined,
					undefined,
					worktreePath,
					testDir,
				);
			}
		});
	};

	const handleGenerate = async () => {
		if (selectedPlans.length === 0 || isGenerating) return;
		setIsGenerating(true);
		let written = 0;
		// Asked at most once for the whole batch: the answer is a property of
		// the project, not of each file, and twenty modals for twenty changed
		// files is not a question, it is a wall.
		let chosenDir: string | undefined;
		try {
			for (const plan of selectedPlans) {
				const absolutePath = `${worktreePath.replaceAll("\\", "/")}/${plan.path.replaceAll("\\", "/")}`;
				const choice = await destinationPrompt.prompt(
					absolutePath,
					worktreePath,
					{ remembered: chosenDir },
				);
				if (choice.cancelled) break;
				chosenDir = choice.directory ?? chosenDir;

				updatePlan(plan.path, { state: "generating", error: undefined });
				try {
					const result = await generateOne(plan, choice.directory);
					const relativeTestPath = toWorktreeRelativePath(
						result.test_file_path,
						worktreePath,
					);
					if (!relativeTestPath) {
						throw new Error(
							t("tasks:testGen.outsideWorktree", {
								path: result.test_file_path,
							}),
						);
					}
					const writeResult = await globalThis.electronAPI.worktreeWriteFile(
						worktreePath,
						relativeTestPath,
						result.test_file_content,
					);
					if (!writeResult.success) {
						throw new Error(writeResult.error || "Could not write test file");
					}
					written += 1;
					updatePlan(plan.path, { state: "done", testPath: relativeTestPath });
				} catch (error) {
					updatePlan(plan.path, {
						state: "error",
						error: error instanceof Error ? error.message : String(error),
					});
				}
				if (!isMountedRef.current) return;
			}
		} finally {
			if (isMountedRef.current) {
				setIsGenerating(false);
			}
		}
		if (written > 0) {
			toast({
				title: t("tasks:testGen.doneTitle"),
				description: t("tasks:testGen.doneDescription", { count: written }),
			});
			onTestsWritten?.();
		}
	};

	return (
		<div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-3">
			<TestDestinationDialog
				destination={destinationPrompt.pending}
				onConfirm={destinationPrompt.confirm}
				onCancel={destinationPrompt.cancel}
				note={t("tasks:testGen.destinationAppliesToBatch")}
			/>
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2 min-w-0">
					<FlaskConical className="h-4 w-4 shrink-0 text-primary" />
					<div className="min-w-0">
						<h4 className="text-sm font-medium">{t("tasks:testGen.title")}</h4>
						<p className="text-xs text-muted-foreground truncate">
							{t("tasks:testGen.description")}
						</p>
					</div>
				</div>
				<Button
					size="sm"
					onClick={() => void handleGenerate()}
					disabled={isGenerating || selectedPlans.length === 0}
				>
					{isGenerating ? (
						<Loader2 className="h-4 w-4 mr-2 animate-spin" />
					) : (
						<FlaskConical className="h-4 w-4 mr-2" />
					)}
					{t("tasks:testGen.generate", { count: selectedPlans.length })}
				</Button>
			</div>

			<div className="space-y-1">
				{generatablePlans.map((plan) => (
					<div
						key={plan.path}
						className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-secondary/40 transition-colors"
					>
						<div className="flex items-center gap-2 min-w-0 flex-1">
							<Checkbox
								checked={plan.selected}
								disabled={isGenerating}
								onCheckedChange={(checked) =>
									updatePlan(plan.path, { selected: checked === true })
								}
							/>
							<span className="text-xs font-mono truncate" title={plan.path}>
								{plan.path}
							</span>
						</div>
						<div className="flex items-center gap-2 shrink-0">
							{plan.state === "generating" && (
								<Loader2 className="h-3.5 w-3.5 animate-spin text-info" />
							)}
							{plan.state === "done" && (
								<span
									className="flex items-center gap-1 text-xs text-success"
									title={plan.testPath}
								>
									<CheckCircle2 className="h-3.5 w-3.5" />
									{t("tasks:testGen.written")}
								</span>
							)}
							{plan.state === "error" && (
								<span
									className="flex items-center gap-1 text-xs text-destructive"
									title={plan.error}
								>
									<XCircle className="h-3.5 w-3.5" />
									{t("tasks:testGen.failed")}
								</span>
							)}
							<Badge
								variant="secondary"
								className={cn(
									"text-[10px]",
									STRATEGY_BADGE_CLASSES[
										plan.strategy as Exclude<TestStrategy, "skip">
									],
								)}
							>
								{t(`tasks:testGen.strategy.${plan.strategy}`)}
							</Badge>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
