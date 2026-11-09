import { openAppEmulatorDialog } from "@/stores/app-emulator-store";
import { openArenaDialog } from "@/stores/arena-store";
import { openCodePlaygroundDialog } from "@/stores/code-playground-store";
import { openConflictPredictorDialog } from "@/stores/conflict-predictor-store";
import { openContextAwareSnippetsDialog } from "@/stores/context-aware-snippets-store";
import { openDependencySentinelDialog } from "@/stores/dependency-sentinel-store";
import { openLearningLoopDialog } from "@/stores/learning-loop-store";
import { useNaturalLanguageGitStore } from "@/stores/natural-language-git-store";
import { openPromptOptimizerDialog } from "@/stores/prompt-optimizer-store";
import { openTestGenerationDialog } from "@/stores/test-generation-store";
import { openVoiceAssistant } from "@/stores/voice-assistant-store";
import type { SidebarView } from "../Sidebar";

/**
 * The menu entries that open a dialog instead of a page. A tool picked from
 * the menu or from the command palette opens at once; its hub tab, when it has
 * one, says what it does and offers to open it.
 */
const DIALOG_OPENERS: Partial<Record<SidebarView, () => void>> = {
	"test-generation": openTestGenerationDialog,
	"prompt-optimizer": openPromptOptimizerDialog,
	"context-aware-snippets": openContextAwareSnippetsDialog,
	"code-playground": openCodePlaygroundDialog,
	"conflict-predictor": openConflictPredictorDialog,
	"dependency-sentinel": openDependencySentinelDialog,
	"natural-language-git": () => useNaturalLanguageGitStore.getState().openDialog(),
	"voice-control": openVoiceAssistant,
	"app-emulator": openAppEmulatorDialog,
	"learning-loop": openLearningLoopDialog,
	"arena-mode": openArenaDialog,
};

/** Whether picking this entry opens a dialog rather than a page. */
export function opensDialog(view: SidebarView): boolean {
	return view in DIALOG_OPENERS;
}

/**
 * Opens what a menu entry stands for: its dialog, or its page through
 * `onViewChange`. The sidebar and the command palette both go through here, so
 * a tool opens the same way whichever was used to find it.
 */
export function openNavView(
	view: SidebarView,
	onViewChange: ((view: SidebarView) => void) | undefined,
): void {
	const openDialog = DIALOG_OPENERS[view];
	if (openDialog) {
		openDialog();
		return;
	}
	onViewChange?.(view);
}
