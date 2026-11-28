/** The task engine offers each phase its own code mode while Settings' switch is not off. */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskEngine } from "../../../../shared/utils/task-engine";
import { TaskEngineEditor } from "../TaskEngineEditor";

const { store } = vi.hoisted(() => ({
	store: { settings: {} as Record<string, unknown> },
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../../stores/settings-store", () => ({
	useSettingsStore: (pick: (state: typeof store) => unknown) => pick(store),
}));
vi.mock("../../../hooks/useConfiguredProviders", () => ({
	useConfiguredProviders: () => ({
		providers: [{ name: "anthropic", label: "Anthropic" }],
		loading: false,
	}),
}));
vi.mock("../EngineTrioPicker", () => ({ EngineTrioPicker: () => null }));

const trio = { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" };
const engine = {
	spec: trio,
	planning: trio,
	coding: { ...trio, model: "claude-sonnet-5-5" },
	qa: trio,
} as unknown as TaskEngine;

function renderEditor(onPhaseCodeModeChange = vi.fn()) {
	render(
		<TaskEngineEditor
			engine={engine}
			onChange={vi.fn()}
			idPrefix="e"
			phaseCodeMode={{}}
			onPhaseCodeModeChange={onPhaseCodeModeChange}
		/>,
	);
	return onPhaseCodeModeChange;
}

describe("TaskEngineEditor and code mode", () => {
	beforeEach(() => {
		store.settings = {};
	});

	it("offers each phase its own mode when the switch is on", () => {
		store.settings = { codeMode: "auto" };
		const change = renderEditor();
		fireEvent.click(screen.getByTestId("e-coding-code-mode-on"));
		expect(change).toHaveBeenCalledWith({ coding: "on" });
		expect(screen.getByTestId("e-qa-code-mode-default")).toHaveAttribute("aria-pressed", "true");
	});

	it("offers nothing while the switch is off", () => {
		renderEditor();
		expect(screen.queryByTestId("e-coding-code-mode-on")).toBeNull();
	});
});
