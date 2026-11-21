import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { CatalogModel } from "../../../hooks/useProviderModelCatalog";
import { useSettingsStore } from "../../../stores/settings-store";
import { HubDiscoveryWithCloud } from "../HubDiscoveryWithCloud";

const served: CatalogModel[] = [
	{
		value: "moonshotai/Kimi-K3.1-Pro",
		label: "moonshotai/Kimi-K3.1-Pro",
		inputPrice: 0.2403,
		outputPrice: 8.4023,
	},
];
vi.mock("../../../hooks/useProviderModelCatalog", () => ({
	useProviderModelCatalog: (provider: string) => ({
		models: provider === "huggingface" ? served : [],
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
			globalHuggingFaceModel: undefined,
			globalHuggingFaceApiKey: undefined,
		},
	}));
	saveSettings.mockReset().mockResolvedValue({ success: true });
	Object.assign(window.electronAPI, {
		saveSettings,
		searchHuggingFaceModels: vi.fn().mockResolvedValue({
			success: true,
			data: [
				// The Hub spells the repo in its own case; the router serves it.
				{ id: "moonshotai/kimi-k3.1-pro", url: "https://huggingface.co/x", library: "gguf" },
				{ id: "org/local-only-GGUF", url: "https://huggingface.co/y", library: "gguf" },
			],
		}),
	});
});
afterEach(cleanup);

describe("HubDiscoveryWithCloud", () => {
	it("offers the cloud only for a repo the router serves, with its price", async () => {
		render(<HubDiscoveryWithCloud onSelectModel={vi.fn()} />);
		const tryButtons = await screen.findAllByTitle(/Make .* the Hugging Face cloud model/);
		expect(tryButtons).toHaveLength(1);
		expect(tryButtons[0].getAttribute("title")).toContain("moonshotai/Kimi-K3.1-Pro");
		expect(screen.getByText(/\$0\.24 \/ \$8\.4 per M tokens/)).toBeTruthy();
	});

	it("makes the repo the Hugging Face model and says how to try it", async () => {
		const onSelectModel = vi.fn();
		render(<HubDiscoveryWithCloud onSelectModel={onSelectModel} />);
		fireEvent.click(await screen.findByTitle(/Make .* the Hugging Face cloud model/));
		await waitFor(() =>
			expect(saveSettings).toHaveBeenCalledWith({
				globalHuggingFaceModel: "moonshotai/Kimi-K3.1-Pro",
			}),
		);
		// The local default is left alone.
		expect(onSelectModel).not.toHaveBeenCalled();
		const status = await screen.findByRole("status");
		expect(status.textContent).toContain("is now the Hugging Face cloud model");
		expect(status.textContent).toContain("Add a Hugging Face token");
		expect(useSettingsStore.getState().settings.globalHuggingFaceModel).toBe(
			"moonshotai/Kimi-K3.1-Pro",
		);
		expect(await screen.findByText("Cloud model")).toBeTruthy();
	});

	it("does not ask for a token the user already gave", async () => {
		useSettingsStore.setState((s) => ({
			settings: { ...s.settings, globalHuggingFaceApiKey: "********" },
		}));
		render(<HubDiscoveryWithCloud onSelectModel={vi.fn()} />);
		fireEvent.click(await screen.findByTitle(/Make .* the Hugging Face cloud model/));
		const status = await screen.findByRole("status");
		expect(status.textContent).not.toContain("Add a Hugging Face token");
	});

	it("says when the model could not be saved", async () => {
		saveSettings.mockResolvedValue({ success: false, error: "refused" });
		render(<HubDiscoveryWithCloud onSelectModel={vi.fn()} />);
		fireEvent.click(await screen.findByTitle(/Make .* the Hugging Face cloud model/));
		expect((await screen.findByRole("status")).textContent).toContain(
			"could not be saved",
		);
	});
});
