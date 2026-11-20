/**
 * The model and thinking level of one chat session, in the app's language.
 *
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { InsightsModelConfig } from "../../../shared/types";
import { useSettingsStore } from "../../stores/settings-store";
import { CustomModelModal } from "../CustomModelModal";

const initialSettings = useSettingsStore.getState().settings;

function renderModal(props: Partial<Parameters<typeof CustomModelModal>[0]> = {}) {
	const onSave = vi.fn();
	const onClose = vi.fn();
	const view = render(<CustomModelModal onSave={onSave} onClose={onClose} {...props} />);
	return { ...view, onSave, onClose };
}

async function pick(triggerLabel: string, option: RegExp) {
	fireEvent.keyDown(screen.getByLabelText(triggerLabel), { key: "Enter" });
	fireEvent.click((await screen.findAllByRole("option", { name: option }))[0]);
}

describe("CustomModelModal", () => {
	beforeAll(() => {
		Element.prototype.scrollIntoView = vi.fn();
		Element.prototype.hasPointerCapture = vi.fn(() => false);
		Element.prototype.releasePointerCapture = vi.fn();
	});

	beforeEach(async () => {
		useSettingsStore.setState({ settings: { ...initialSettings, selectedProvider: undefined } });
		await i18n.changeLanguage("en");
	});

	afterEach(async () => {
		await act(() => i18n.changeLanguage("en"));
	});

	it("starts on Sonnet at medium thinking and applies a new thinking level", async () => {
		const { onSave } = renderModal();
		expect(screen.getByText("Custom Model Configuration")).toBeTruthy();
		const thinking = screen.getByLabelText("Thinking Level");
		expect(thinking.textContent).toContain("Medium");
		expect(thinking.textContent).toContain("Moderate analysis");
		expect(screen.getByLabelText("Model").textContent).toMatch(/Sonnet/);

		await pick("Thinking Level", /High/);
		expect(screen.getByLabelText("Thinking Level").textContent).toContain("Deep thinking");
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));

		expect(onSave).toHaveBeenCalledWith({
			profileId: "custom",
			model: "sonnet",
			thinkingLevel: "high",
		});
	});

	it("names every thinking level in French", async () => {
		await act(() => i18n.changeLanguage("fr"));
		renderModal();
		fireEvent.keyDown(screen.getByLabelText("Niveau de réflexion"), { key: "Enter" });
		const list = await screen.findByRole("listbox");
		expect(within(list).getByText("Aucun")).toBeTruthy();
		expect(within(list).getByText("Pas de réflexion étendue")).toBeTruthy();
		expect(within(list).getByText("Élevé")).toBeTruthy();
		expect(within(list).getByText("Réflexion approfondie")).toBeTruthy();
		expect(within(list).getByText("Profondeur de raisonnement maximale")).toBeTruthy();
		expect(within(list).queryByText("Deep thinking")).toBeNull();
	});

	it("opens on the session's current choice and saves another model", async () => {
		const currentConfig: InsightsModelConfig = {
			profileId: "custom",
			model: "haiku",
			thinkingLevel: "low",
		};
		const { onSave } = renderModal({ currentConfig });
		expect(screen.getByLabelText("Model").textContent).toMatch(/Haiku/);
		expect(screen.getByLabelText("Thinking Level").textContent).toContain("Low");

		await pick("Model", /Opus/);
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		const saved = onSave.mock.calls[0][0] as InsightsModelConfig;
		expect(saved.thinkingLevel).toBe("low");
		expect(saved.model).toMatch(/opus/);
	});

	it("lists the models of the provider the insights page uses", () => {
		useSettingsStore.setState({ settings: { ...initialSettings, selectedProvider: "openai" } });
		renderModal({ currentConfig: { profileId: "custom", model: "gpt-5.5" as InsightsModelConfig["model"], thinkingLevel: "none" } });
		expect(screen.getByLabelText("Model").textContent).toMatch(/GPT/);
		expect(screen.getByLabelText("Thinking Level").textContent).toContain("None");
	});

	it("drops an unsaved edit when it is opened again", async () => {
		const onSave = vi.fn();
		const onClose = vi.fn();
		const { rerender } = render(<CustomModelModal onSave={onSave} onClose={onClose} />);
		await pick("Thinking Level", /Ultra Think/);
		rerender(<CustomModelModal open={false} onSave={onSave} onClose={onClose} />);
		rerender(<CustomModelModal open onSave={onSave} onClose={onClose} />);
		expect(screen.getByLabelText("Thinking Level").textContent).toContain("Medium");
	});

	it("closes on cancel without saving", () => {
		const { onSave, onClose } = renderModal();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onClose).toHaveBeenCalled();
		expect(onSave).not.toHaveBeenCalled();
	});
});
