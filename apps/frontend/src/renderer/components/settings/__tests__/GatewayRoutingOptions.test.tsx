import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { useSettingsStore } from "../../../stores/settings-store";
import { GatewayRoutingOptions } from "../GatewayRoutingOptions";

vi.mock("../../../hooks/useProviderModelCatalog", () => ({
	useProviderModelCatalog: () => ({
		models: [{ value: "z-ai/glm-5.3", label: "GLM 5.3" }],
		source: "live",
		fetchedAt: null,
		error: null,
		loading: false,
		refresh: () => {},
	}),
}));

const saveSettings = vi.fn();

beforeEach(async () => {
	await i18n.changeLanguage("en");
	useSettingsStore.setState((s) => ({
		settings: {
			...s.settings,
			openRouterSort: undefined,
			openRouterFallbackModels: ["deepseek/v4"],
			openRouterDenyDataCollection: undefined,
			openRouterZeroRetention: undefined,
			huggingFaceRoutingPolicy: undefined,
		},
	}));
	saveSettings.mockReset().mockResolvedValue({ success: true });
	Object.assign(window.electronAPI, { saveSettings });
});
afterEach(cleanup);

describe("GatewayRoutingOptions", () => {
	it("saves the OpenRouter provider order and privacy filters", async () => {
		render(<GatewayRoutingOptions provider="openrouter" />);
		fireEvent.change(screen.getByLabelText("Provider order"), {
			target: { value: "price" },
		});
		fireEvent.click(screen.getByLabelText(/do not store or train/));
		fireEvent.click(screen.getByLabelText(/zero-data-retention/));
		await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(3));
		expect(saveSettings.mock.calls.map((c) => c[0])).toEqual([
			{ openRouterSort: "price" },
			{ openRouterDenyDataCollection: true },
			{ openRouterZeroRetention: true },
		]);
		fireEvent.change(screen.getByLabelText("Provider order"), {
			target: { value: "" },
		});
		await waitFor(() =>
			expect(saveSettings).toHaveBeenLastCalledWith({ openRouterSort: "" }),
		);
	});

	it("saves the fallbacks in order and refuses what is not a model id", async () => {
		render(<GatewayRoutingOptions provider="openrouter" />);
		const first = screen.getByLabelText("Fallback model 1") as HTMLInputElement;
		expect(first.value).toBe("deepseek/v4");
		const second = screen.getByLabelText("Fallback model 2");
		fireEvent.change(second, { target: { value: "not an id" } });
		fireEvent.blur(second);
		expect(screen.getByText("Not a model id: not an id")).toBeTruthy();
		expect(saveSettings).not.toHaveBeenCalled();

		fireEvent.change(second, { target: { value: " z-ai/glm-5.3 " } });
		fireEvent.blur(second);
		await waitFor(() =>
			expect(saveSettings).toHaveBeenCalledWith({
				openRouterFallbackModels: ["deepseek/v4", "z-ai/glm-5.3"],
			}),
		);
	});

	it("saves the Hugging Face router policy, and says when saving fails", async () => {
		saveSettings.mockResolvedValue({ success: false, error: "refused" });
		render(<GatewayRoutingOptions provider="huggingface" />);
		expect(screen.queryByLabelText("Provider order")).toBeNull();
		fireEvent.change(screen.getByLabelText("Router policy"), {
			target: { value: "cheapest" },
		});
		await waitFor(() =>
			expect(saveSettings).toHaveBeenCalledWith({ huggingFaceRoutingPolicy: "cheapest" }),
		);
		expect(await screen.findByText("The routing could not be saved.")).toBeTruthy();
	});
});
