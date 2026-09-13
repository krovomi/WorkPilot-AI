import { describe, expect, it, vi } from "vitest";

// Le module ne fait que lire un fichier et déléguer la décision au résolveur
// partagé : on remplace le fichier et le fournisseur d'environnement, pas
// Electron.
vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));
vi.mock("../settings-utils", () => ({
	readSettingsFile: vi.fn(),
	writeSettingsFile: vi.fn(),
}));
vi.mock("./credential-manager", () => ({
	credentialManager: { getEnvironmentVariables: vi.fn(() => ({})) },
}));

import { readSettingsFile } from "../settings-utils";
import { credentialManager } from "./credential-manager";
import {
	getPageFeatureSettings,
	getPageLlmConfig,
	getPageProviderEnv,
} from "./page-llm-config";

describe("getPageLlmConfig", () => {
	it("suit la liste « Fournisseur IA » quand la page ne surcharge rien", () => {
		vi.mocked(readSettingsFile).mockReturnValue({
			selectedProvider: "copilot",
			featureModels: { githubPrs: "claude-opus-4-6" },
			featureThinking: { githubPrs: "medium" },
		});

		const resolved = getPageLlmConfig("github-prs");

		expect(resolved.provider).toBe("copilot");
		expect(resolved.providerSource).toBe("settings");
		expect(resolved.model).toBe("claude-opus-4-6");
		expect(resolved.thinking).toBe("medium");
	});

	it("préfère ce que la page a choisi", () => {
		vi.mocked(readSettingsFile).mockReturnValue({
			selectedProvider: "copilot",
			pageLlmOverrides: { "github-prs": { thinking: "ultrathink" } },
		});

		const resolved = getPageLlmConfig("github-prs");

		expect(resolved.thinking).toBe("ultrathink");
		expect(resolved.thinkingSource).toBe("page");
		expect(resolved.provider).toBe("copilot");
	});

	it("répond sur un fichier de réglages absent", () => {
		vi.mocked(readSettingsFile).mockReturnValue(undefined);

		const { model, thinkingLevel, provider } =
			getPageFeatureSettings("ideation");

		expect(model).toBeTruthy();
		expect(thinkingLevel).toBeTruthy();
		expect(provider).toBe("");
	});
});

describe("getPageProviderEnv", () => {
	it("demande l'environnement du fournisseur de la page", () => {
		vi.mocked(readSettingsFile).mockReturnValue({
			selectedProvider: "openai",
			pageLlmOverrides: { insights: { provider: "ollama" } },
		});

		getPageProviderEnv("insights");

		expect(credentialManager.getEnvironmentVariables).toHaveBeenCalledWith(
			"ollama",
		);
	});

	it("ne nomme aucun fournisseur quand personne n'en a choisi", () => {
		vi.mocked(readSettingsFile).mockReturnValue({});

		getPageProviderEnv("insights");

		expect(credentialManager.getEnvironmentVariables).toHaveBeenCalledWith(
			undefined,
		);
	});
});
