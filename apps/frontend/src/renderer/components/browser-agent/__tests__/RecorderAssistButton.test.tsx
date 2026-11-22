/** @vitest-environment jsdom */
/** The assistant button (#387), in French: only once steps exist, and it says where the answer came from. */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { useBrowserRecorderStore } from "../../../stores/browser-recorder-store";
import { RecorderAssistButton } from "../RecorderAssistButton";

const initial = useBrowserRecorderStore.getState();
const assist = vi.fn(async () => undefined);

beforeEach(async () => {
	await i18n.changeLanguage("fr");
	useBrowserRecorderStore.setState({ ...initial, assist }, true);
	vi.clearAllMocks();
});
afterEach(cleanup);

describe("RecorderAssistButton", () => {
	it("asks once there are steps, and names its source", () => {
		const { rerender } = render(<RecorderAssistButton projectPath="/p" />);
		const button = screen.getByRole("button", { name: "Proposer un nom et classer les vérifications" });
		expect(button).toBeDisabled();
		useBrowserRecorderStore.setState({ steps: [{ id: "s1", kind: "navigate", selectors: [], url: "http://a/" }] });
		rerender(<RecorderAssistButton projectPath="/p" />);
		fireEvent.click(button);
		expect(assist).toHaveBeenCalledWith("/p");
		useBrowserRecorderStore.setState({ assistSource: "rules" });
		rerender(<RecorderAssistButton projectPath="/p" />);
		expect(screen.getByText(/aucun modèle/)).toBeInTheDocument();
		useBrowserRecorderStore.setState({ assistSource: "model" });
		rerender(<RecorderAssistButton projectPath="/p" />);
		expect(screen.getByText(/rien de ce que vous avez saisi/)).toBeInTheDocument();
	});
});
