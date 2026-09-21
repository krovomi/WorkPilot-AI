/**
 * Tests de l'environnement que le Bounty Board donne à ses participants.
 *
 * Le rapport de bug qu'ils gardent : un plateau Anthropic / OpenAI / Google où
 * seul le participant Claude échouait, sur « No OAuth token found. WorkPilot AI
 * requires Claude Code OAuth authentication », depuis une machine pourtant
 * authentifiée. Ce handler assemblait tout l'environnement à partir du seul
 * `credentialManager`, qui ne porte jamais l'authentification de Claude — elle
 * vient de `getBestAvailableProfileEnv` et `getAPIProfileEnv`, que tout le
 * reste de l'application obtient par `getRunnerEnv`.
 *
 * Le test vise la fonction plutôt que le canal IPC : ce qui est en cause est
 * la composition de l'environnement, pas le lancement d'un sous-processus, et
 * un faux `spawn` ferait porter au test le poids d'un mécanisme qui n'est pas
 * le sujet.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: () => undefined },
	app: { isPackaged: false, getAppPath: () => "/app/frontend" },
}));

vi.mock("../../python-env-manager.js", () => ({
	pythonEnvManager: { getPythonPath: () => "/usr/bin/python3" },
}));

const getEnvironmentVariables = vi.fn();
vi.mock("../../services/credential-manager.js", () => ({
	credentialManager: {
		getEnvironmentVariables: (...args: unknown[]) =>
			getEnvironmentVariables(...args),
	},
}));

const getRunnerEnv = vi.fn();
vi.mock("../github/utils/runner-env.js", () => ({
	getRunnerEnv: (...args: unknown[]) => getRunnerEnv(...args),
}));

import { buildContestantEnv } from "../bounty-board-handlers";

const CONTESTANTS = [
	{ provider: "anthropic", model: "claude-sonnet-4-6" },
	{ provider: "openai", model: "gpt-5" },
	{ provider: "google", model: "gemini-2.5-pro" },
];

beforeEach(() => {
	vi.clearAllMocks();
	getRunnerEnv.mockResolvedValue({
		CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
		ANTHROPIC_BASE_URL: "https://api.anthropic.com",
		PYTHONPATH: "/bundled",
		SELECTED_LLM_PROVIDER: "claude",
	});
	getEnvironmentVariables.mockImplementation((provider: string) =>
		provider === "openai"
			? { OPENAI_API_KEY: "sk-openai" }
			: { GOOGLE_API_KEY: "goog" },
	);
});

describe("buildContestantEnv", () => {
	it("porte l'authentification Claude, que credentialManager ne fournit pas", async () => {
		const env = await buildContestantEnv(CONTESTANTS, {});

		expect(getRunnerEnv).toHaveBeenCalledOnce();
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
		expect(env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
	});

	it("ajoute les clés de chaque autre fournisseur du plateau", async () => {
		const env = await buildContestantEnv(CONTESTANTS, {});

		expect(env.OPENAI_API_KEY).toBe("sk-openai");
		expect(env.GOOGLE_API_KEY).toBe("goog");
	});

	// La chaîne d'authentification de Claude est résolue une fois, par
	// `getRunnerEnv` : mode OAuth, profil API et bascule de profil au
	// rate-limit ensemble. Re-demander une clé à `credentialManager` par-dessus
	// pourrait contredire le mode qui vient d'être choisi.
	it("ne redemande pas les identifiants de Claude par-dessus", async () => {
		await buildContestantEnv(CONTESTANTS, {});

		const asked = getEnvironmentVariables.mock.calls.map(([p]) => p);
		expect(asked).toEqual(expect.arrayContaining(["openai", "google"]));
		expect(asked).not.toContain("anthropic");
		expect(asked).not.toContain("claude");
	});

	// Chaque participant nomme son propre fournisseur, que
	// `create_agent_client(provider=…)` honore directement : une valeur
	// ambiante serait une seconde réponse à une question déjà tranchée.
	it("ne laisse aucun SELECTED_LLM_PROVIDER ambiant", async () => {
		const env = await buildContestantEnv(CONTESTANTS, {});

		expect(env.SELECTED_LLM_PROVIDER).toBeUndefined();
	});

	it("transmet les variables supplémentaires du lanceur", async () => {
		await buildContestantEnv(CONTESTANTS, { PYTHONPATH: "/repo/apps/backend" });

		expect(getRunnerEnv).toHaveBeenCalledWith({
			PYTHONPATH: "/repo/apps/backend",
		});
	});

	// Un fournisseur dont les identifiants sont illisibles ne doit pas empêcher
	// le round : ce participant échoue visiblement avec l'erreur de son propre
	// fournisseur, ce qui est plus utile qu'un refus de démarrer.
	it("ne laisse pas un fournisseur illisible emporter le round", async () => {
		getEnvironmentVariables.mockImplementation((provider: string) => {
			if (provider === "openai") throw new Error("keychain locked");
			return { GOOGLE_API_KEY: "goog" };
		});

		const env = await buildContestantEnv(CONTESTANTS, {});

		expect(env.GOOGLE_API_KEY).toBe("goog");
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
	});
});
