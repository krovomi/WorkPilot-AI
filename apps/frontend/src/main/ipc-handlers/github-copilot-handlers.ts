/**
 * IPC Handlers for GitHub Copilot CLI Service
 *
 * Fournit une interface IPC entre le frontend et le GitHubCopilotService
 */

import { ipcMain } from "electron";
import type {
	CopilotConfig,
	CopilotStatus,
} from "../services/github-copilot-service";
import { gitHubCopilotService } from "../services/github-copilot-service";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

/**
 * Enregistrer tous les handlers IPC pour GitHub Copilot
 */
export function registerGitHubCopilotHandlers(): void {
	/**
	 * Obtenir le statut de GitHub Copilot CLI
	 */
	ipcMain.handle(IPC_CHANNELS.GITHUB_COPILOT_GET_STATUS, (): CopilotStatus => {
		return gitHubCopilotService.getStatus();
	});

	/**
	 * Obtenir la configuration de GitHub Copilot
	 */
	ipcMain.handle(IPC_CHANNELS.GITHUB_COPILOT_GET_CONFIG, (): CopilotConfig => {
		return gitHubCopilotService.getConfig();
	});

	/**
	 * Configurer le token GitHub Copilot
	 */
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_COPILOT_SET_TOKEN,
		async (_event, token: string): Promise<void> => {
			await gitHubCopilotService.setToken(token);
		},
	);

	/**
	 * Supprimer le token GitHub Copilot
	 */
	ipcMain.handle(IPC_CHANNELS.GITHUB_COPILOT_REMOVE_TOKEN, async (): Promise<void> => {
		await gitHubCopilotService.removeToken();
	});

	/**
	 * Authentifier avec GitHub CLI
	 */
	ipcMain.handle(IPC_CHANNELS.GITHUB_COPILOT_AUTHENTICATE, async (): Promise<void> => {
		await gitHubCopilotService.authenticate();
	});

	/**
	 * Se déconnecter
	 */
	ipcMain.handle(IPC_CHANNELS.GITHUB_COPILOT_LOGOUT, async (): Promise<void> => {
		await gitHubCopilotService.logout();
	});

	/**
	 * Tester la connexion GitHub Copilot
	 */
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_COPILOT_TEST_CONNECTION,
		async (): Promise<{
			success: boolean;
			message: string;
			details?: unknown;
		}> => {
			return await gitHubCopilotService.testConnection();
		},
	);

	/**
	 * Rafraîchir le statut
	 */
	ipcMain.handle(IPC_CHANNELS.GITHUB_COPILOT_REFRESH_STATUS, async (): Promise<void> => {
		await gitHubCopilotService.refreshStatus();
	});

	/**
	 * Obtenir les variables d'environnement
	 */
	ipcMain.handle(IPC_CHANNELS.GITHUB_COPILOT_GET_ENV, (): Record<string, string> => {
		return gitHubCopilotService.getEnvironmentVariables();
	});
}
