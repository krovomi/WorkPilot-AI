import * as DialogPrimitive from "@radix-ui/react-dialog";
import { FlaskConical, Play, Search, Square, X, Zap } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	isTestStudioLanguage,
	testStudioLanguage,
} from "../../../shared/constants/test-studio-languages";
import { useTestDestinationPrompt } from "../../hooks/use-test-destination-prompt";
import { useTestLibraries } from "../../hooks/use-test-libraries";
import {
	type InspectorTab,
	inspectorTabForStep,
	STUDIO_MODES,
	type StudioMode,
	type StudioStep,
	studioStepStates,
} from "../../lib/test-studio-steps";
import { useProjectStore } from "../../stores/project-store";
import { useTestGenerationStore } from "../../stores/test-generation-store";
import { Dialog, DialogOverlay, DialogPortal } from "../ui/dialog";
import { StudioInspector, tabsForMode } from "./studio/StudioInspector";
import { StudioPipeline } from "./studio/StudioPipeline";
import { looksLikeFile, TargetColumn } from "./studio/TargetColumn";
import { TestDestinationDialog } from "./TestDestinationDialog";
import "./studio/test-studio.css";

const MODE_ACCENT: Record<StudioMode, string> = {
	analyze: "var(--tg-analyze)",
	unit: "var(--tg-unit)",
	e2e: "var(--tg-e2e)",
	tdd: "var(--tg-tdd)",
};

/** Used when neither the person nor the project names a TDD language. */
const FALLBACK_TDD_LANGUAGE = "typescript";

interface TestGenerationDialogProps {
	/** Called when tests are generated and should be applied */
	readonly onApplyTests?: (
		testFileContent: string,
		testFilePath: string,
	) => void;
}

/**
 * The test generation agent, as a studio in the look of Visual-to-Code and
 * Import Design: what to test on the left, the run as cards on glowing wires
 * in the middle, the result on the right, and the action of the moment in the
 * bar at the bottom.
 *
 * Four modes share the layout — coverage analysis, unit tests, E2E from a
 * user story, TDD from a description — and every one of them works for the
 * project's own stack: the language and the test framework come from the
 * project's manifests, not from a list of two.
 */
export function TestGenerationDialog({
	onApplyTests,
}: TestGenerationDialogProps) {
	const { t } = useTranslation(["testGeneration", "common"]);
	const [mode, setMode] = useState<StudioMode>("analyze");
	const [tab, setTab] = useState<InspectorTab>("gaps");
	const [selectedStep, setSelectedStep] = useState<StudioStep | null>(null);
	const [userStory, setUserStory] = useState("");
	const [targetModule, setTargetModule] = useState("");
	const [tddDescription, setTddDescription] = useState("");
	const [projectLanguage, setProjectLanguage] = useState<string>();
	// Where the tests go is settled before the run starts: asking after a
	// generation would mean holding a finished file hostage to a question.
	const destinationPrompt = useTestDestinationPrompt();
	const projectPath = useProjectStore((state) => state.getActiveProject()?.path);

	const {
		isOpen,
		closeDialog,
		phase,
		runKind,
		liveStages,
		liveMeta,
		selectedFile,
		existingTestPath,
		coverageTarget,
		setCoverageTarget,
		tddLanguage,
		setTddLanguage,
		tddSnippetType,
		setTddSnippetType,
		reset,
		setSelectedFile,
		analyzeCoverage,
		generateUnitTests,
		generateE2ETests,
		generateTDDTests,
		cancelGeneration,
	} = useTestGenerationStore();

	// What the tests are written against follows the mode: the TDD language
	// picked (or the project's), the E2E target, or the file of the moment.
	// It used to follow `selectedFile` everywhere, so a C# TDD run was offered
	// the libraries of whatever file the Unit tab had open.
	const librariesFile =
		mode === "tdd" ? "" : mode === "e2e" ? (looksLikeFile(targetModule) ? targetModule : "") : selectedFile;
	const libraries = useTestLibraries(
		librariesFile,
		projectPath,
		undefined,
		mode === "tdd" && tddLanguage ? tddLanguage : undefined,
	);

	// With no language pinned, the backend answers with the project's own:
	// remember it for the "auto" chip and the run.
	useEffect(() => {
		if (mode === "tdd" && !tddLanguage && libraries.selection?.language) {
			setProjectLanguage(libraries.selection.language);
		}
	}, [mode, tddLanguage, libraries.selection?.language]);

	useEffect(() => {
		if (!isOpen) {
			reset();
			setMode("analyze");
			setTab("gaps");
			setSelectedStep(null);
			setUserStory("");
			setTargetModule("");
			setTddDescription("");
		}
	}, [isOpen, reset]);

	const running = phase === "analyzing" || phase === "generating";
	const states = studioStepStates({ mode, runKind, phase, liveStages });

	const switchMode = (next: StudioMode) => {
		if (running || next === mode) return;
		setMode(next);
		setTab(tabsForMode(next)[0]);
		setSelectedStep(null);
	};

	const selectStep = (step: StudioStep | null) => {
		setSelectedStep(step);
		if (step) {
			const wanted = inspectorTabForStep(step);
			if (tabsForMode(mode).includes(wanted)) setTab(wanted);
		}
	};

	const handleAnalyzeCoverage = useCallback(async () => {
		if (!selectedFile) return;
		setTab("gaps");
		try {
			await analyzeCoverage(selectedFile, existingTestPath || undefined);
		} catch {
			// Surfaced through the store's error state, in the inspector.
		}
	}, [selectedFile, existingTestPath, analyzeCoverage]);

	const handleGenerateUnitTests = useCallback(async () => {
		if (!selectedFile) return;
		const choice = await destinationPrompt.prompt(selectedFile, projectPath, {
			existingTestPath: existingTestPath || undefined,
		});
		if (choice.cancelled) return;
		setTab("code");
		try {
			await generateUnitTests(
				selectedFile,
				existingTestPath || undefined,
				coverageTarget,
				choice.directory,
				libraries.chosen,
			);
		} catch {
			// Surfaced through the store's error state, in the inspector.
		}
	}, [
		selectedFile,
		existingTestPath,
		coverageTarget,
		generateUnitTests,
		destinationPrompt,
		projectPath,
		libraries.chosen,
	]);

	const handleGenerateE2ETests = useCallback(async () => {
		if (!userStory.trim() || !targetModule.trim()) return;
		setTab("code");
		try {
			await generateE2ETests(userStory, targetModule.trim(), undefined, libraries.chosen);
		} catch {
			// Surfaced through the store's error state, in the inspector.
		}
	}, [userStory, targetModule, generateE2ETests, libraries.chosen]);

	// TDD has no source file to resolve a layout from, so there is nothing to
	// ask about: the backend falls back to the project's own test directory.
	const tddRunLanguage =
		tddLanguage || (isTestStudioLanguage(projectLanguage) ? projectLanguage : FALLBACK_TDD_LANGUAGE);
	const handleGenerateTDDTests = useCallback(async () => {
		if (!tddDescription.trim()) return;
		setTab("code");
		try {
			await generateTDDTests(
				{
					description: tddDescription,
					language: tddRunLanguage,
					snippet_type: tddSnippetType,
				},
				undefined,
				libraries.chosen,
			);
		} catch {
			// Surfaced through the store's error state, in the inspector.
		}
	}, [tddDescription, tddRunLanguage, tddSnippetType, generateTDDTests, libraries.chosen]);

	const ready: Record<StudioMode, boolean> = {
		analyze: Boolean(selectedFile),
		unit: Boolean(selectedFile),
		e2e: Boolean(userStory.trim() && targetModule.trim()),
		tdd: Boolean(tddDescription.trim()),
	};
	const run: Record<StudioMode, () => Promise<void>> = {
		analyze: handleAnalyzeCoverage,
		unit: handleGenerateUnitTests,
		e2e: handleGenerateE2ETests,
		tdd: handleGenerateTDDTests,
	};

	const launch = () => {
		if (!running && ready[mode]) void run[mode]();
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			launch();
		}
	};

	const generateFromGaps = () => {
		setMode("unit");
		setTab("code");
		setSelectedStep(null);
		void handleGenerateUnitTests();
	};

	const target =
		mode === "tdd"
			? tddDescription.trim()
			: mode === "e2e"
				? targetModule
				: selectedFile;
	const inputPreview = (mode === "e2e" ? userStory : tddDescription).trim().slice(0, 60);
	const ours = runKind === mode;
	const stackLanguage = testStudioLanguage(
		(ours && liveMeta.language) ||
			(mode === "tdd" ? tddRunLanguage : libraries.selection?.language),
	);
	const fileName = selectedFile ? selectedFile.split(/[\\/]/).pop() : "";

	return (
		<>
			<TestDestinationDialog
				destination={destinationPrompt.pending}
				onConfirm={destinationPrompt.confirm}
				onCancel={destinationPrompt.cancel}
			/>
			<Dialog open={isOpen} onOpenChange={(open) => !open && closeDialog()}>
				<DialogPortal>
					<DialogOverlay />
					<DialogPrimitive.Content
						className="tg-root"
						data-testid="test-studio"
						style={{ ["--tg-mode" as string]: MODE_ACCENT[mode] }}
						onKeyDown={onKeyDown}
					>
						<div className="tg-ambient" />
						<header className="tg-header">
							<div className="tg-brand">
								<span className="tg-glyph">
									<FlaskConical className="h-4 w-4" />
								</span>
								<div>
									<div className="tg-kicker">{t("studio.kicker")}</div>
									<DialogPrimitive.Title asChild>
										<h2>{t("title")}</h2>
									</DialogPrimitive.Title>
									<DialogPrimitive.Description className="sr-only">
										{t("description")}
									</DialogPrimitive.Description>
								</div>
							</div>

							<div className="tg-modes" role="tablist" aria-label={t("studio.modesLabel")}>
								{STUDIO_MODES.map((id) => (
									<button
										key={id}
										type="button"
										role="tab"
										className="tg-mode"
										aria-selected={mode === id}
										disabled={running && mode !== id}
										data-testid={`test-studio-mode-${id}`}
										style={{ ["--tg-accent" as string]: MODE_ACCENT[id] }}
										onClick={() => switchMode(id)}
									>
										<i />
										{t(`tabs.${id}`)}
										<small>{t(`studio.modes.${id}`)}</small>
									</button>
								))}
							</div>

							<div className="tg-header-tools">
								{stackLanguage && (
									<span
										className="tg-chip"
										style={{ ["--tg-accent" as string]: stackLanguage.color }}
									>
										<i />
										<b>{stackLanguage.label}</b>
										{ours && liveMeta.framework ? `· ${liveMeta.framework}` : ""}
									</span>
								)}
								<DialogPrimitive.Close className="tg-icon-btn" aria-label={t("common:buttons.close")}>
									<X className="h-4 w-4" />
								</DialogPrimitive.Close>
							</div>
						</header>

						<div className="tg-stage">
							<TargetColumn
								mode={mode}
								running={running}
								selectedFile={selectedFile}
								onSelectFile={setSelectedFile}
								existingTestPath={existingTestPath}
								coverageTarget={coverageTarget}
								onCoverageTarget={setCoverageTarget}
								userStory={userStory}
								onUserStory={setUserStory}
								targetModule={targetModule}
								onTargetModule={setTargetModule}
								tddDescription={tddDescription}
								onTddDescription={setTddDescription}
								tddLanguage={tddLanguage}
								projectLanguage={projectLanguage}
								onTddLanguage={setTddLanguage}
								tddSnippetType={tddSnippetType}
								onTddSnippetType={setTddSnippetType}
								libraries={libraries}
								canInstall={Boolean(projectPath)}
							/>
							<StudioPipeline
								mode={mode}
								states={states}
								selected={selectedStep}
								onSelect={selectStep}
								inputPreview={inputPreview}
								tddLanguage={tddRunLanguage}
							/>
							<StudioInspector
								mode={mode}
								tab={tab}
								onTab={setTab}
								selection={libraries.selection}
								chosenLibraries={libraries.chosen}
								target={target}
								onApplyTests={
									onApplyTests
										? (content, path) => {
												onApplyTests(content, path);
												closeDialog();
											}
										: undefined
								}
								onGenerateFromGaps={generateFromGaps}
							/>
						</div>

						<footer className="tg-composer">
							<div className="tg-composer-summary">
								<span className="tg-prompt">❯</span>
								{ready[mode] && (mode === "analyze" || mode === "unit") && fileName && (
									<span className="tg-chip" title={selectedFile}>
										<b>{fileName}</b>
									</span>
								)}
								{ready[mode] && mode === "unit" && (
									<span className="tg-chip">
										{t("studio.composer.coverage", { value: coverageTarget })}
									</span>
								)}
								<span className="tg-hint">
									{running
										? t(`studio.composer.running.${mode}`)
										: ready[mode]
											? t("studio.composer.ready")
											: t(`studio.composer.missing.${mode}`)}
								</span>
							</div>
							<div className="tg-actions">
								{running ? (
									<button type="button" className="tg-btn" onClick={cancelGeneration}>
										<Square className="h-3.5 w-3.5" />
										{t("live.cancel")}
									</button>
								) : (
									<>
										{mode === "analyze" && (
											<button
												type="button"
												className="tg-btn"
												disabled={!selectedFile}
												onClick={() => {
													setMode("unit");
													setTab("code");
													void handleGenerateUnitTests();
												}}
											>
												<Zap className="h-3.5 w-3.5" />
												{t("generateTests")}
											</button>
										)}
										<button
											type="button"
											className="tg-btn tg-btn-primary"
											disabled={!ready[mode]}
											data-testid="test-studio-run"
											onClick={launch}
										>
											{mode === "analyze" ? (
												<Search className="h-3.5 w-3.5" />
											) : (
												<Play className="h-3.5 w-3.5" />
											)}
											{t(`studio.composer.action.${mode}`)}
											<kbd>Ctrl ↵</kbd>
										</button>
									</>
								)}
							</div>
						</footer>
					</DialogPrimitive.Content>
				</DialogPortal>
			</Dialog>
		</>
	);
}
