/**
 * Le jeton Figma d'un projet : écrit par le processus principal, jamais relu
 * par le renderer.
 *
 * Il vit où vivent ceux de Jira et d'Azure DevOps — `FIGMA_ACCESS_TOKEN` dans
 * `<projet>/.workpilot/.env` —, parce que c'est ce fichier que le backend lit
 * quand une personne lie une maquette à une tâche (`docintel/figma.py`). Deux
 * canaux seulement, et aucun ne rend la valeur : l'un l'écrit (ou l'efface),
 * l'autre dit s'il y en a une.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult } from "../../shared/types";
import { projectStore } from "../project-store";

export const FIGMA_TOKEN_KEY = "FIGMA_ACCESS_TOKEN";

/** Un jeton Figma n'a ni espace ni retour à la ligne : rien d'autre n'entre. */
export function sanitizeFigmaToken(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const token = value.trim();
	if (token === "") return "";
	return /^[A-Za-z0-9_-]{8,256}$/.test(token) ? token : null;
}

/** `content` avec la ligne `FIGMA_ACCESS_TOKEN` remplacée, ajoutée ou retirée. */
export function withFigmaToken(content: string, token: string): string {
	const lines = content.split(/\r?\n/);
	const kept = lines.filter(
		(line) => !new RegExp(`^\\s*#?\\s*${FIGMA_TOKEN_KEY}\\s*=`).test(line),
	);
	while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
	if (token) kept.push(`${FIGMA_TOKEN_KEY}=${token}`);
	return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}

export function hasFigmaToken(content: string): boolean {
	return content
		.split(/\r?\n/)
		.some((line) =>
			new RegExp(`^\\s*${FIGMA_TOKEN_KEY}\\s*=\\s*\\S`).test(line),
		);
}

function envPath(projectId: string): string | null {
	const project = projectStore.getProject(projectId);
	if (!project?.autoBuildPath) return null;
	return path.join(project.path, project.autoBuildPath, ".env");
}

export function registerFigmaHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.FIGMA_TOKEN_STATUS,
		async (
			_,
			projectId: string,
		): Promise<IPCResult<{ configured: boolean; fromEnvironment: boolean }>> => {
			const file = envPath(projectId);
			let configured = false;
			if (file && existsSync(file)) {
				try {
					configured = hasFigmaToken(readFileSync(file, "utf-8"));
				} catch {
					configured = false;
				}
			}
			const fromEnvironment = Boolean(process.env[FIGMA_TOKEN_KEY]?.trim());
			return {
				success: true,
				data: { configured: configured || fromEnvironment, fromEnvironment },
			};
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.FIGMA_SET_TOKEN,
		async (_, projectId: string, value: unknown): Promise<IPCResult<boolean>> => {
			const token = sanitizeFigmaToken(value);
			if (token === null) {
				return { success: false, error: "invalid-token" };
			}
			const file = envPath(projectId);
			if (!file) return { success: false, error: "not-initialized" };
			try {
				const current = existsSync(file) ? readFileSync(file, "utf-8") : "";
				mkdirSync(path.dirname(file), { recursive: true });
				writeFileSync(file, withFigmaToken(current, token), "utf-8");
				return { success: true, data: token !== "" };
			} catch {
				return { success: false, error: "write-failed" };
			}
		},
	);
}
