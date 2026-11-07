import { ChevronDown, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	DESIGN_SOURCE_TYPES,
	DESIGN_STACK_INFO,
	DESIGN_TO_CODE_STACKS,
	DESIGN_TO_CODE_STYLES,
	type DesignSourceKind,
	type DesignStackGroup,
} from "../../../../shared/types/design-to-code";
import {
	runDesignToCodePipeline,
	useDesignToCodeStore,
	writeDesignFilesToProject,
} from "../../../stores/design-to-code-store";
import { useProjectStore } from "../../../stores/project-store";
import { createTask } from "../../../stores/task-store";
import { buildDesignTaskDescription } from "./design-task";

const GROUPS: DesignStackGroup[] = ["web", "mobile", "desktop"];

function StackPicker({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation("designToCode");
	const framework = useDesignToCodeStore((s) => s.framework);
	const style = useDesignToCodeStore((s) => s.style);
	const detection = useDesignToCodeStore((s) => s.detection);
	const setFramework = useDesignToCodeStore((s) => s.setFramework);
	const setStyle = useDesignToCodeStore((s) => s.setStyle);
	const webStyles = DESIGN_STACK_INFO[framework].webStyles;

	return (
		<div className="di-stackpop" role="dialog" aria-label={t("composer.target")}>
			{detection?.stack && (
				<button
					type="button"
					className="di-detected"
					onClick={() => {
						if (detection.stack) setFramework(detection.stack);
						setStyle(detection.style);
						onClose();
					}}
				>
					<div className="min-w-0">
						<div className="font-semibold">
							{t("composer.detected", {
								stack: t(`stacks.${detection.stack}`),
								style: detection.style ? ` + ${t(`styles.${detection.style}`)}` : "",
							})}
						</div>
						<div className="di-muted di-mono truncate text-2xs">{detection.evidence.join(", ")}</div>
					</div>
				</button>
			)}
			{GROUPS.map((group) => (
				<div key={group}>
					<div className="di-group-label">{t(`groups.${group}`)}</div>
					<div className="di-options">
						{DESIGN_TO_CODE_STACKS.filter((s) => DESIGN_STACK_INFO[s].group === group).map((stack) => (
							<button
								key={stack}
								type="button"
								className="di-option"
								aria-pressed={framework === stack}
								onClick={() => setFramework(stack)}
							>
								{t(`stacks.${stack}`)}
							</button>
						))}
					</div>
				</div>
			))}
			<div className="di-group-label">{t("groups.style")}</div>
			<div className="di-options">
				<button
					type="button"
					className="di-option"
					aria-pressed={style === null}
					onClick={() => setStyle(null)}
				>
					{t("styles.auto")}
				</button>
				{DESIGN_TO_CODE_STYLES.map((s) => (
					<button
						key={s}
						type="button"
						className="di-option"
						aria-pressed={style === s}
						disabled={!webStyles}
						onClick={() => setStyle(s)}
					>
						{t(`styles.${s}`)}
					</button>
				))}
			</div>
		</div>
	);
}

/**
 * The bottom bar, as in Claude Code: what the agent should respect, the
 * target, and the action of the moment (generate, stop waiting, write).
 */
export function DesignComposer() {
	const { t } = useTranslation("designToCode");
	const [pickerOpen, setPickerOpen] = useState(false);
	const [taskState, setTaskState] = useState<"idle" | "creating" | "created">("idle");
	const pickerRef = useRef<HTMLDivElement>(null);

	const phase = useDesignToCodeStore((s) => s.phase);
	const result = useDesignToCodeStore((s) => s.result);
	const imageData = useDesignToCodeStore((s) => s.imageData);
	const figmaUrl = useDesignToCodeStore((s) => s.figmaUrl);
	const framework = useDesignToCodeStore((s) => s.framework);
	const style = useDesignToCodeStore((s) => s.style);
	const sourceType = useDesignToCodeStore((s) => s.sourceType);
	const designSystemPath = useDesignToCodeStore((s) => s.designSystemPath);
	const customInstructions = useDesignToCodeStore((s) => s.customInstructions);
	const writing = useDesignToCodeStore((s) => s.writing);
	const writeOutcome = useDesignToCodeStore((s) => s.writeOutcome);
	const setSourceType = useDesignToCodeStore((s) => s.setSourceType);
	const setDesignSystemPath = useDesignToCodeStore((s) => s.setDesignSystemPath);
	const setFigmaUrl = useDesignToCodeStore((s) => s.setFigmaUrl);
	const setCustomInstructions = useDesignToCodeStore((s) => s.setCustomInstructions);
	const resetPipeline = useDesignToCodeStore((s) => s.resetPipeline);
	const projectId = useProjectStore((s) => s.selectedProjectId);

	const running = !["idle", "complete", "error"].includes(phase);
	const done = phase === "complete" && Boolean(result?.success);
	const canRun = !running && Boolean(imageData || figmaUrl);
	const fileCount = (result?.generated_files.length ?? 0) + (result?.visual_tests.length ?? 0);

	useEffect(() => {
		if (!pickerOpen) return;
		const close = (event: MouseEvent) => {
			if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [pickerOpen]);

	useEffect(() => {
		if (phase !== "complete") setTaskState("idle");
	}, [phase]);

	const generate = () => {
		if (canRun) void runDesignToCodePipeline();
	};

	const createKanbanTask = async () => {
		const state = useDesignToCodeStore.getState();
		if (!projectId || !state.result) return;
		setTaskState("creating");
		const task = await createTask(
			projectId,
			t("kanban.title", { name: state.imageName ?? t("kanban.untitled") }),
			buildDesignTaskDescription(state, t),
		);
		setTaskState(task ? "created" : "idle");
	};

	return (
		<footer className="di-composer">
			<div className="di-box">
				<div className="di-box-input">
					<span className="di-prompt" aria-hidden="true">
						{">"}
					</span>
					<textarea
						rows={1}
						value={customInstructions}
						placeholder={t("composer.placeholder")}
						aria-label={t("composer.instructions")}
						disabled={running}
						onChange={(event) => setCustomInstructions(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
								event.preventDefault();
								generate();
							}
						}}
					/>
				<div className="di-actions">
					{phase !== "idle" && !running && (
						<button type="button" className="di-btn" onClick={resetPipeline}>
							<RotateCcw className="h-3 w-3" />
							{t("footer.reset")}
						</button>
					)}
					{done && projectId && (
						<button
							type="button"
							className="di-btn"
							disabled={taskState !== "idle"}
							onClick={createKanbanTask}
						>
							{t(
								taskState === "created"
									? "footer.taskCreated"
									: taskState === "creating"
										? "footer.creatingTask"
										: "footer.createTask",
							)}
						</button>
					)}
					{done && (
						<button type="button" className="di-btn" disabled={!canRun} onClick={generate}>
							{t("footer.regenerate")}
						</button>
					)}
					{done && projectId ? (
						<button
							type="button"
							className="di-btn di-btn-primary"
							disabled={writing || Boolean(writeOutcome)}
							onClick={() => void writeDesignFilesToProject()}
							data-testid="design-write-button"
						>
							{writing && <Loader2 className="h-3 w-3 animate-spin" />}
							{t(writeOutcome ? "footer.written" : "footer.write", { count: fileCount })}
						</button>
					) : (
						!done && (
							<button
								type="button"
								className="di-btn di-btn-primary"
								disabled={!canRun}
								onClick={generate}
								data-testid="design-generate-button"
							>
								{running ? (
									<Loader2 className="h-3 w-3 animate-spin" />
								) : (
									<Sparkles className="h-3 w-3" />
								)}
								{t(running ? "footer.processing" : "footer.generateCode")}
								{!running && <kbd>{t("footer.shortcut")}</kbd>}
							</button>
						)
					)}
				</div>
				</div>
				<div className="di-box-row">
					<label className="di-pick">
						{t("composer.source")}
						<select
							value={sourceType}
							disabled={running}
							onChange={(event) => setSourceType(event.target.value as DesignSourceKind)}
						>
							{DESIGN_SOURCE_TYPES.map((s) => (
								<option key={s} value={s}>
									{t(`sourceTypes.${s}`)}
								</option>
							))}
						</select>
					</label>

					<div className="relative" ref={pickerRef}>
						<button
							type="button"
							className="di-pick"
							data-open={pickerOpen}
							disabled={running}
							aria-expanded={pickerOpen}
							onClick={() => setPickerOpen((open) => !open)}
							data-testid="design-stack-button"
						>
							{t("composer.target")}
							<b>
								{t(`stacks.${framework}`)}
								{style ? ` · ${t(`styles.${style}`)}` : ""}
							</b>
							<ChevronDown className="h-3 w-3" />
						</button>
						{pickerOpen && <StackPicker onClose={() => setPickerOpen(false)} />}
					</div>

					<label className="di-pick">
						{t("composer.designSystem")}
						<input
							value={designSystemPath}
							disabled={running}
							placeholder={t("composer.designSystemPlaceholder")}
							onChange={(event) => setDesignSystemPath(event.target.value)}
							size={Math.max(10, designSystemPath.length)}
						/>
					</label>

					<label className="di-pick">
						{t("composer.figma")}
						<input
							value={figmaUrl}
							disabled={running}
							placeholder={t("composer.figmaPlaceholder")}
							onChange={(event) => setFigmaUrl(event.target.value)}
							size={Math.max(12, Math.min(figmaUrl.length, 32))}
						/>
					</label>

				</div>
			</div>
		</footer>
	);
}
