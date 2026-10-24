/**
 * ProviderService - Service centralisé pour la gestion des providers LLM
 *
 * Architecture improvement 3.1: delegates to providerRegistry (single source of truth)
 * for the canonical provider list. Falls back to providerRegistry instead of
 * maintaining a duplicate hardcoded list.
 */

import { providerRegistry } from "./providerRegistry";

export interface Provider {
	name: string;
	label: string;
	description: string;
}

export interface ProviderConfig {
	api_key?: string;
	base_url?: string;
	validated?: boolean;
}

class ProviderServiceClass {
	private providers: Provider[] | null = null;
	private isLoading = false;
	private loadPromise: Promise<Provider[]> | null = null;

	/**
	 * Récupère tous les providers avec cache
	 */
	async getAllProviders(): Promise<Provider[]> {
		if (this.providers) {
			return this.providers;
		}

		if (this.isLoading && this.loadPromise) {
			return this.loadPromise;
		}

		this.isLoading = true;
		this.loadPromise = this.loadProvidersFromFile();

		try {
			this.providers = await this.loadPromise;
			return this.providers;
		} finally {
			this.isLoading = false;
			this.loadPromise = null;
		}
	}

	/**
	 * Force le rechargement des providers (utile après mise à jour)
	 */
	async refreshProviders(): Promise<Provider[]> {
		this.providers = null;
		return this.getAllProviders();
	}

	/**
	 * Récupère un provider par son nom
	 */
	async getProviderByName(name: string): Promise<Provider | undefined> {
		const providers = await this.getAllProviders();
		return providers.find((p) => p.name === name);
	}

	/**
	 * Charge les providers depuis configured_providers.json avec fallback
	 */
	private async loadProvidersFromFile(): Promise<Provider[]> {
		try {
			// Try to load from main process via IPC (file is now in config/ at repo root)
			if (globalThis.electronAPI?.invoke) {
				const result = await globalThis.electronAPI.invoke(
					"providers:getConfiguredProviders",
				);
				if (result?.providers) {
					return result.providers;
				}
			}
			throw new Error("IPC not available");
		} catch (error) {
			console.warn(
				"Failed to load providers from configured_providers.json, using fallback:",
				error,
			);
			const fallbackProviders = this.getFallbackProviders();
			return fallbackProviders;
		}
	}

	/**
	 * Fallback: delegate to providerRegistry (single source of truth)
	 */
	private getFallbackProviders(): Provider[] {
		return providerRegistry
			.getAllProviders()
			.filter((p) => p.name !== "custom")
			.map((p) => ({
				name: p.name,
				label: p.label,
				description: p.description,
			}));
	}

	/**
	 * Vérifie si un provider nécessite une clé API
	 */
	async getApiKeyField(providerName: string): Promise<string | null> {
		const apiKeyMap: Record<string, string | null> = {
			openai: "globalOpenAIApiKey",
			gemini: "globalGoogleApiKey",
			google: "globalGoogleDeepMindApiKey",
			meta: "globalMetaApiKey",
			"meta-llama": "globalMetaLlamaApiKey",
			mistral: "globalMistralApiKey",
			deepseek: "globalDeepSeekApiKey",
			grok: "globalGrokApiKey",
			aws: "globalAWSApiKey",
			ollama: null,
			copilot: null,
			"azure-openai": "globalOpenAIApiKey",
			anthropic: null, // Claude utilise OAuth
		};

		return apiKeyMap[providerName] || null;
	}

	/**
	 * Sauvegarde la configuration des providers dans le fichier utilisateur
	 */
	async saveUserProviderConfig(
		provider: string,
		config: ProviderConfig,
	): Promise<void> {
		try {
			// Utiliser localStorage au lieu de fs pour le contexte navigateur
			const configKey = `work_pilot_ai_llm_providers_${provider}`;
			const existingData = localStorage.getItem(configKey);
			let allConfigs: Record<string, ProviderConfig> = {};

			if (existingData) {
				try {
					allConfigs = JSON.parse(existingData);
				} catch {
					// Ignorer les erreurs de lecture
				}
			}

			// Fusionner avec la configuration existante
			allConfigs[provider] = { ...allConfigs[provider], ...config };

			localStorage.setItem(configKey, JSON.stringify(allConfigs, null, 2));
		} catch (error) {
			console.error(
				"[ProviderService] Failed to save user provider config:",
				error,
			);
			throw error;
		}
	}

	/**
	 * Teste la connexion à un provider.
	 *
	 * The test runs in the main process (`credential:testProvider`), which holds
	 * the keys: the renderer only ever sees them masked (rule S6), so it cannot
	 * and must not call a provider itself.
	 */
	async testProvider(
		providerName: string,
	): Promise<{ success: boolean; message: string; details?: unknown }> {
		if (!globalThis.electronAPI?.invoke) {
			return { success: false, message: "Provider test not available" };
		}
		try {
			return await globalThis.electronAPI.invoke(
				"credential:testProvider",
				providerName,
			);
		} catch (error) {
			console.error(
				`[ProviderService] Test failed for ${providerName}:`,
				error,
			);
			return {
				success: false,
				message: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Récupère la configuration utilisateur d'un provider
	 */
	async getUserProviderConfig(
		provider: string,
	): Promise<ProviderConfig | null> {
		try {
			// Utiliser localStorage au lieu de fs pour le contexte navigateur
			const configKey = `work_pilot_ai_llm_providers_${provider}`;
			const data = localStorage.getItem(configKey);

			if (!data) {
				return null;
			}

			const allConfigs: Record<string, ProviderConfig> = JSON.parse(data);
			return allConfigs[provider] || null;
		} catch (error) {
			console.warn(
				"[ProviderService] Failed to load user provider config:",
				error,
			);
			return null;
		}
	}
}

// Export du singleton
export const ProviderService = new ProviderServiceClass();

// Export des types pour compatibilité
export type { Provider as Connector };
