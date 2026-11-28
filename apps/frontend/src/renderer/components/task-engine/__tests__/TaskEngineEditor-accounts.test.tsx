/** The task engine offers the card's account pins for the providers its phases use. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskEngine } from "../../../../shared/utils/task-engine";
import { TaskEngineEditor } from "../TaskEngineEditor";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../../stores/settings-store", () => ({
	useSettingsStore: (pick: (state: { settings: object }) => unknown) => pick({ settings: {} }),
}));
vi.mock("../../../hooks/useConfiguredProviders", () => ({
	useConfiguredProviders: () => ({
		providers: [{ name: "anthropic", label: "Anthropic" }],
		loading: false,
	}),
}));
vi.mock("../EngineTrioPicker", () => ({ EngineTrioPicker: () => null }));
const pinsEditor = vi.fn((_props: Record<string, unknown>) => <div data-testid="pins" />);
vi.mock("../../ai-account-pins/AiAccountPinsEditor", () => ({
	AiAccountPinsEditor: (props: Record<string, unknown>) => pinsEditor(props),
}));

const trio = { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" };
const engine = {
	spec: trio,
	planning: trio,
	coding: { ...trio, provider: "openai", model: "gpt-5" },
	qa: trio,
} as unknown as TaskEngine;

describe("TaskEngineEditor and account pins", () => {
	it("offers the pins of the engine's providers, with the project's as inherited", () => {
		const onAccountsChange = vi.fn();
		render(
			<TaskEngineEditor
				engine={engine}
				onChange={vi.fn()}
				idPrefix="e"
				accounts={{ openai: "client" }}
				onAccountsChange={onAccountsChange}
				inheritedAccounts={{ claude: "team" }}
			/>,
		);
		expect(screen.getByTestId("pins")).toBeInTheDocument();
		expect(pinsEditor).toHaveBeenCalledWith(
			expect.objectContaining({
				providers: ["anthropic", "openai"],
				value: { openai: "client" },
				onChange: onAccountsChange,
				inherited: { claude: "team" },
				scope: "card",
			}),
		);
	});

	it("offers none without a setter", () => {
		render(<TaskEngineEditor engine={engine} onChange={vi.fn()} idPrefix="e" />);
		expect(screen.queryByTestId("pins")).toBeNull();
	});
});
