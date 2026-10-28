/**
 * Provider Registry - Service centralisé pour la gestion des providers LLM
 * Point d'entrée unique pour backend et frontend
 */

import { PROVIDER_MODELS_MAP } from "../constants/models";
import type { AgentCliTool } from "../types/agent-cli";
import type { APIProfile } from "../types/profile";
import { detectProvider } from "../utils/provider-detection";

export interface Provider {
	name: string;
	label: string;
	description: string;
	icon?: string; // Chemin vers l'icône ou composant React
	category:
		| "anthropic"
		| "openai"
		| "google"
		| "meta"
		| "aws"
		| "local"
		| "special";
	requiresApiKey: boolean;
	requiresOAuth: boolean;
	requiresCLI: boolean;
	models: Array<{
		value: string;
		label: string;
		tier: "flagship" | "standard" | "fast" | "local";
		supportsThinking?: boolean;
	}>;
}

export interface ProviderStatus {
	available: boolean;
	authenticated: boolean;
	error?: string;
	lastChecked?: Date;
}

export interface ProvidersResponse {
	providers: Provider[];
	status: Record<string, ProviderStatus>;
}

/**
 * Coding-agent CLIs (OpenCode, Google Antigravity, pi) choose their model inside
 * the CLI the user signed in to; `default` hands that choice back to it. The
 * backend reads the same sentinel (`phase_config.CLI_DEFAULT_MODEL`).
 */
const CLI_DEFAULT_MODEL = "default";

/** OpenCode takes `provider/model` ids (see `opencode models`). */
const OPENCODE_MODELS: Provider["models"] = [
	{ value: CLI_DEFAULT_MODEL, label: "OpenCode default", tier: "standard" },
	{
		value: "anthropic/claude-opus-5",
		label: "Claude Opus 5",
		tier: "flagship",
		supportsThinking: true,
	},
	{
		value: "anthropic/claude-sonnet-4-5",
		label: "Claude Sonnet 4.5",
		tier: "standard",
		supportsThinking: true,
	},
	{
		value: "openai/gpt-5.5",
		label: "GPT-5.5",
		tier: "flagship",
		supportsThinking: true,
	},
	{
		value: "google/gemini-3.1-pro",
		label: "Gemini 3.1 Pro",
		tier: "flagship",
		supportsThinking: true,
	},
	{ value: "openai/gpt-5.5-mini", label: "GPT-5.5 mini", tier: "fast" },
];

/** Antigravity model slugs (see `agy models`). */
const ANTIGRAVITY_MODELS: Provider["models"] = [
	{
		value: CLI_DEFAULT_MODEL,
		label: "Antigravity default",
		tier: "standard",
	},
	{
		value: "gemini-3.1-pro",
		label: "Gemini 3.1 Pro",
		tier: "flagship",
		supportsThinking: true,
	},
	{
		value: "gemini-3-pro",
		label: "Gemini 3 Pro",
		tier: "standard",
		supportsThinking: true,
	},
	{
		value: "gemini-3.1-flash",
		label: "Gemini 3.1 Flash",
		tier: "fast",
		supportsThinking: true,
	},
	{
		value: "gemini-3-flash",
		label: "Gemini 3 Flash",
		tier: "fast",
		supportsThinking: true,
	},
];

/**
 * pi takes `provider/model` ids too (`pi --list-models`); `default` leaves the
 * choice to the model pi was configured with.
 */
const PI_MODELS: Provider["models"] = [
	{ value: CLI_DEFAULT_MODEL, label: "pi default", tier: "standard" },
	{
		value: "anthropic/claude-opus-5",
		label: "Claude Opus 5",
		tier: "flagship",
		supportsThinking: true,
	},
	{
		value: "anthropic/claude-sonnet-4-5",
		label: "Claude Sonnet 4.5",
		tier: "standard",
		supportsThinking: true,
	},
	{
		value: "openai/gpt-5.5",
		label: "GPT-5.5",
		tier: "fast",
		supportsThinking: true,
	},
];

/**
 * Gemini CLI over the Agent Client Protocol takes its own model ids
 * (`gemini --model`); `default` leaves it on its `auto` routing.
 */
const GEMINI_CLI_MODELS: Provider["models"] = [
	{ value: CLI_DEFAULT_MODEL, label: "Gemini CLI default (auto)", tier: "standard" },
	{ value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", tier: "flagship" },
	{ value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", tier: "standard" },
	{ value: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)", tier: "fast" },
];

/** The CLI each CLI-backed provider runs, as `checkAgentCli` names it. */
const AGENT_CLI_PROVIDERS = new Set(["opencode", "antigravity", "pi", "gemini-cli"]);

/**
 * Registre central des providers LLM
 */
class ProviderRegistry {
	private static instance: ProviderRegistry;
	private readonly providers: Map<string, Provider> = new Map();

	private constructor() {
		this.initializeProviders();
	}

	public static getInstance(): ProviderRegistry {
		if (!ProviderRegistry.instance) {
			ProviderRegistry.instance = new ProviderRegistry();
		}
		return ProviderRegistry.instance;
	}

	private initializeProviders(): void {
		// --- Anthropic (Claude) ---
		this.providers.set("anthropic", {
			name: "anthropic",
			label: "Anthropic (Claude)",
			description: "Claude models via Anthropic API",
			category: "anthropic",
			requiresApiKey: true,
			requiresOAuth: true,
			requiresCLI: false,
			models: PROVIDER_MODELS_MAP.anthropic || [],
		});

		// --- OpenAI ---
		this.providers.set("openai", {
			name: "openai",
			label: "OpenAI (ChatGPT)",
			description: "GPT and o-series models via OpenAI API",
			category: "openai",
			requiresApiKey: true,
			requiresOAuth: false,
			requiresCLI: false,
			models: PROVIDER_MODELS_MAP.openai || [],
		});

		// --- Google Gemini ---
		this.providers.set("google", {
			name: "google",
			label: "Google (Gemini)",
			description: "Gemini models via Google AI",
			category: "google",
			requiresApiKey: true,
			requiresOAuth: false,
			requiresCLI: false,
			models: PROVIDER_MODELS_MAP.google || [],
		});

		// --- Meta (LLaMA) ---
		this.providers.set("meta", {
			name: "meta",
			label: "Meta (LLaMA)",
			description: "LLaMA models via Meta API / Replicate",
			category: "meta",
			requiresApiKey: true,
			requiresOAuth: false,
			requiresCLI: false,
			models: PROVIDER_MODELS_MAP.meta || [],
		});

		// --- Mistral AI ---
		this.providers.set("mistral", {
			name: "mistral",
			label: "Mistral AI",
			description: "Mistral models via Mistral AI API",
			category: "special",
			requiresApiKey: true,
			requiresOAuth: false,
			requiresCLI: false,
			models: PROVIDER_MODELS_MAP.mistral || [],
		});

		// --- DeepSeek ---
		this.providers.set("deepseek", {
			name: "deepseek",
			label: "DeepSeek",
			description: "DeepSeek models via DeepSeek API",
			category: "special",
			requiresApiKey: true,
			requiresOAuth: false,
			requiresCLI: false,
			models: PROVIDER_MODELS_MAP.deepseek || [],
		});

		// --- AWS Bedrock ---
		this.providers.set("aws", {
			name: "aws",
			label: "AWS (Bedrock)",
			description: "Models via AWS Bedrock",
			category: "aws",
			requiresApiKey: true,
			requiresOAuth: false,
			requiresCLI: false,
			models: PROVIDER_MODELS_MAP.aws || [],
		});

		// --- GitHub Copilot ---
		this.providers.set("copilot", {
			name: "copilot",
			label: "GitHub Copilot",
			description: "GitHub Copilot CLI models (gh copilot)",
			category: "special",
			requiresApiKey: false,
			requiresOAuth: false,
			requiresCLI: true, // Requiert gh CLI
			models: PROVIDER_MODELS_MAP.copilot || [],
		});

		// --- Grok (xAI) ---
		this.providers.set("grok", {
			name: "grok",
			label: "Grok (xAI)",
			description: "Grok models via xAI",
			category: "special",
			requiresApiKey: true,
			requiresOAuth: false,
			requiresCLI: false,
			models: PROVIDER_MODELS_MAP.grok || [],
		});

		// --- Custom/Enterprise ---
		this.providers.set("custom", {
			name: "custom",
			label: "Custom/Enterprise",
			description: "Custom API endpoints",
			category: "special",
			requiresApiKey: true,
			requiresOAuth: false,
			requiresCLI: false,
			models: PROVIDER_MODELS_MAP.custom || [],
		});

		// --- Windsurf ---
		this.providers.set("windsurf", {
			name: "windsurf",
			label: "Windsurf (Codeium)",
			description: "AI-powered coding assistant by Codeium",
			category: "special",
			requiresApiKey: true,
			requiresOAuth: false,
			requiresCLI: false,
			models: PROVIDER_MODELS_MAP.windsurf || [],
		});

		// --- Cursor ---
		this.providers.set("cursor", {
			name: "cursor",
			label: "Cursor IDE",
			description: "AI-first VS Code fork with advanced features",
			category: "special",
			requiresApiKey: true,
			requiresOAuth: false,
			requiresCLI: false,
			models: PROVIDER_MODELS_MAP.cursor || [],
		});

		// --- Ollama (Local) ---
		this.providers.set("ollama", {
			name: "ollama",
			label: "Ollama (Local)",
			description: "Locally hosted models via Ollama",
			category: "local",
			requiresApiKey: false,
			requiresOAuth: false,
			requiresCLI: false,
			models: PROVIDER_MODELS_MAP.ollama || [],
		});

		// --- OpenCode (CLI) ---
		this.providers.set("opencode", {
			name: "opencode",
			label: "OpenCode",
			description: "Open-source coding agent driven through the opencode CLI",
			category: "special",
			requiresApiKey: false,
			requiresOAuth: false,
			requiresCLI: true,
			models: PROVIDER_MODELS_MAP.opencode ?? OPENCODE_MODELS,
		});

		// --- Google Antigravity (CLI) ---
		this.providers.set("antigravity", {
			name: "antigravity",
			label: "Google Antigravity",
			description: "Google's coding agent driven through the agy CLI",
			category: "google",
			requiresApiKey: false,
			requiresOAuth: false,
			requiresCLI: true,
			models: PROVIDER_MODELS_MAP.antigravity ?? ANTIGRAVITY_MODELS,
		});

		// --- pi (CLI) ---
		this.providers.set("pi", {
			name: "pi",
			label: "pi",
			description:
				"Minimal, extensible coding agent (pi.dev) driven through the pi CLI",
			category: "special",
			requiresApiKey: false,
			requiresOAuth: false,
			requiresCLI: true,
			models: PROVIDER_MODELS_MAP.pi ?? PI_MODELS,
		});

		// --- Gemini CLI (Agent Client Protocol) ---
		this.providers.set("gemini-cli", {
			name: "gemini-cli",
			label: "Gemini CLI (ACP)",
			description:
				"Google's coding agent driven over the Agent Client Protocol; it asks on the card before acting",
			category: "google",
			requiresApiKey: false,
			requiresOAuth: false,
			requiresCLI: true,
			models: PROVIDER_MODELS_MAP["gemini-cli"] ?? GEMINI_CLI_MODELS,
		});
	}

	/**
	 * Récupère tous les providers disponibles
	 */
	public getAllProviders(): Provider[] {
		return Array.from(this.providers.values());
	}

	/**
	 * Récupère un provider par son nom
	 */
	public getProvider(name: string): Provider | undefined {
		return this.providers.get(name);
	}

	/**
	 * Vérifie le statut d'authentification d'un provider
	 */
	public async checkProviderStatus(
		name: string,
		profiles: APIProfile[] = [],
	): Promise<ProviderStatus> {
		const provider = this.getProvider(name);
		if (!provider) {
			return {
				available: false,
				authenticated: false,
				error: `Provider ${name} not found`,
			};
		}

		const status: ProviderStatus = {
			available: true,
			authenticated: false,
			lastChecked: new Date(),
		};

		try {
			// Cas spécial pour Anthropic (toujours disponible via OAuth/Claude Code)
			if (name === "anthropic") {
				status.authenticated = true;
				return status;
			}

			// Cas spécial pour GitHub Copilot (vérification gh CLI)
			if (name === "copilot" && provider.requiresCLI) {
				if (typeof globalThis !== "undefined" && globalThis.electronAPI) {
					// Dans Electron, utiliser Node.js pour vérifier gh CLI
					// `checkCopilotAuth` rend `{success, data?: {authenticated}}`, pas un
					// booleen : l'objet entier etait affecte a `status.authenticated`,
					// donc toujours truthy — Copilot passait pour authentifie meme
					// quand gh CLI ne l'etait pas.
					const authResult = await globalThis.electronAPI.checkCopilotAuth();
					status.authenticated =
						authResult.success && authResult.data?.authenticated === true;
				} else {
					// Fallback dans le navigateur (assume disponible pour le développement)
					status.authenticated = true;
				}
				return status;
			}

			// CLI-backed providers: each CLI owns its login, so "installed" is
			// the one thing WorkPilot can check.
			if (AGENT_CLI_PROVIDERS.has(name)) {
				const check = globalThis.electronAPI?.checkAgentCli;
				if (check) {
					const result = await check(name as AgentCliTool);
					status.available = result.installed;
					status.authenticated = result.installed;
				} else {
					status.authenticated = true;
				}
				return status;
			}

			// Vérification basique pour les autres providers
			if (provider.requiresApiKey) {
				const hasProfile = profiles.some(
					(p) => this.detectProviderFromProfile(p) === name,
				);
				status.authenticated = hasProfile;
			}

			if (provider.requiresOAuth) {
				// Logique OAuth spécifique au provider
				status.authenticated = this.checkOAuthStatus(name);
			}
		} catch (error) {
			status.error = error instanceof Error ? error.message : "Unknown error";
			status.authenticated = false;
		}

		return status;
	}

	/**
	 * Vérifie le statut de tous les providers
	 */
	public async checkAllProvidersStatus(
		profiles: APIProfile[] = [],
	): Promise<Record<string, ProviderStatus>> {
		const providers = this.getAllProviders();
		const status: Record<string, ProviderStatus> = {};

		for (const provider of providers) {
			status[provider.name] = await this.checkProviderStatus(
				provider.name,
				profiles,
			);
		}

		return status;
	}

	/**
	 * Détecte le provider à partir d'un profil
	 */
	private detectProviderFromProfile(profile: APIProfile): string {
		// Use hostname-safe URL detection when baseUrl is available
		if (profile.baseUrl) {
			const detected = detectProvider(profile.baseUrl);
			if (detected !== "unknown" && detected !== "ollama_local") {
				return detected;
			}
		}

		// Fallback to name-based detection
		const nameLower = profile.name?.toLowerCase() ?? "";
		if (nameLower.includes("claude")) return "anthropic";
		if (nameLower.includes("openai")) return "openai";
		if (nameLower.includes("gemini")) return "google";
		if (nameLower.includes("llama")) return "meta";
		if (nameLower.includes("mistral")) return "mistral";
		if (nameLower.includes("deepseek")) return "deepseek";
		if (nameLower.includes("bedrock")) return "aws";
		if (nameLower.includes("ollama")) return "ollama";
		if (nameLower.includes("grok")) return "grok";
		if (nameLower.includes("windsurf")) return "windsurf";

		return "custom";
	}

	/**
	 * Vérifie le statut OAuth pour un provider
	 */
	private checkOAuthStatus(providerName: string): boolean {
		// Logique OAuth spécifique
		if (providerName === "anthropic") {
			// Vérifier le token Claude Code OAuth
			return (
				typeof localStorage !== "undefined" &&
				(localStorage.getItem("claude_oauth_token") ||
					localStorage.getItem("anthropic_api_key")) !== null
			);
		}

		return false;
	}

	/**
	 * Ajoute dynamiquement un nouveau provider
	 */
	public addProvider(provider: Provider): void {
		this.providers.set(provider.name, provider);
	}

	/**
	 * Supprime un provider
	 */
	public removeProvider(name: string): boolean {
		return this.providers.delete(name);
	}

	/**
	 * Met à jour un provider existant
	 */
	public updateProvider(name: string, updates: Partial<Provider>): boolean {
		const existing = this.providers.get(name);
		if (!existing) return false;

		const updated = { ...existing, ...updates };
		this.providers.set(name, updated);
		return true;
	}
}

// Export du singleton
export const providerRegistry = ProviderRegistry.getInstance();

// Fonctions utilitaires pour la compatibilité
export function getProviders(
	profiles: APIProfile[] = [],
): Promise<ProvidersResponse> {
	return providerRegistry.checkAllProvidersStatus(profiles).then((status) => ({
		providers: providerRegistry.getAllProviders(),
		status,
	}));
}

export function getProvider(name: string): Provider | undefined {
	return providerRegistry.getProvider(name);
}

export function getModelsForProvider(providerName: string): Provider["models"] {
	return PROVIDER_MODELS_MAP[providerName] || [];
}
