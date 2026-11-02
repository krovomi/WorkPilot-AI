/**
 * Plugin Marketplace IPC Handlers
 *
 * Serves the plugin catalog and installs a plugin as a skill of a registered
 * project (`main/plugin-marketplace/project-skills.ts`). The renderer names the
 * project by id; its folder comes from the project store, never from the
 * renderer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { app, ipcMain, shell } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { appLog } from "../app-logger";
import {
	installPlugin,
	listInstalledPlugins,
	loadPluginCatalog,
	uninstallPlugin,
} from "../plugin-marketplace/project-skills";
import { projectStore } from "../project-store";

// ============================================
// Storage paths
// ============================================

function getPluginDataDir(): string {
	const userDataPath = app.getPath("userData");
	const dir = path.join(userDataPath, "plugin-marketplace");
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/** The folder of the registered project `payload.projectId` names. */
function registeredProjectPath(payload: unknown): string {
	const projectId = (payload as { projectId?: unknown } | null)?.projectId;
	if (typeof projectId !== "string" || !projectId) {
		throw new Error("No project selected");
	}
	const project = projectStore.getProject(projectId);
	if (!project) throw new Error("Unknown project");
	return project.path;
}

function pluginIdOf(payload: unknown): string {
	const pluginId = (payload as { pluginId?: unknown } | null)?.pluginId;
	if (typeof pluginId !== "string" || !pluginId) {
		throw new Error("No plugin named");
	}
	return pluginId;
}

/**
 * The directory `folderPath` names, when it is an existing folder strictly under
 * the creator's `local/` directory — symlinks resolved — and `null` otherwise.
 */
export function resolveLocalPluginFolder(
	folderPath: unknown,
	localRoot: string = path.join(getPluginDataDir(), "local"),
): string | null {
	if (typeof folderPath !== "string" || !folderPath) return null;
	try {
		const root = fs.realpathSync(localRoot);
		const target = fs.realpathSync(path.resolve(folderPath));
		const relative = path.relative(root, target);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
			return null;
		}
		return fs.statSync(target).isDirectory() ? target : null;
	} catch {
		return null;
	}
}

// ============================================
// IPC Handler Registration
// ============================================

export function registerPluginMarketplaceHandlers(): void {
	// Get full plugin catalog
	ipcMain.handle(IPC_CHANNELS.PLUGIN_MARKETPLACE_GET_CATALOG, async () => {
		try {
			return { success: true, data: loadPluginCatalog() };
		} catch (error) {
			appLog.error("[Plugin Marketplace] Failed to get catalog");
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});

	// The catalog plugins installed in a project (its skill folders)
	ipcMain.handle(
		IPC_CHANNELS.PLUGIN_MARKETPLACE_GET_INSTALLED,
		async (_event, payload: unknown) => {
			try {
				const projectPath = registeredProjectPath(payload);
				return { success: true, data: listInstalledPlugins(projectPath) };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Install a plugin: write its skill into the project
	ipcMain.handle(
		IPC_CHANNELS.PLUGIN_MARKETPLACE_INSTALL,
		async (_event, payload: unknown) => {
			try {
				const projectPath = registeredProjectPath(payload);
				const installed = installPlugin(projectPath, pluginIdOf(payload));
				appLog.info(
					`[Plugin Marketplace] Installed plugin skill: ${installed.pluginId}`,
				);
				return { success: true, data: installed };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Installation failed",
				};
			}
		},
	);

	// Uninstall a plugin: remove the skill the marketplace wrote
	ipcMain.handle(
		IPC_CHANNELS.PLUGIN_MARKETPLACE_UNINSTALL,
		async (_event, payload: unknown) => {
			try {
				const projectPath = registeredProjectPath(payload);
				uninstallPlugin(projectPath, pluginIdOf(payload));
				return { success: true };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Uninstall failed",
				};
			}
		},
	);

	// Open the folder of a plugin the creator scaffolded. Only a directory under
	// `<userData>/plugin-marketplace/local/` is opened: the renderer hands back the
	// path `pluginMarketplace:create` returned, and a path from the renderer is
	// never trusted to stay where it came from.
	ipcMain.handle(
		IPC_CHANNELS.PLUGIN_MARKETPLACE_OPEN_LOCAL_FOLDER,
		async (_event, folderPath: unknown) => {
			const target = resolveLocalPluginFolder(folderPath);
			if (!target) {
				return { success: false, error: "Not a local plugin folder" };
			}
			const failure = await shell.openPath(target);
			return failure ? { success: false, error: failure } : { success: true };
		},
	);

	// Scaffold a new plugin on disk
	ipcMain.handle(
		IPC_CHANNELS.PLUGIN_MARKETPLACE_CREATE,
		async (
			_event,
			data: {
				type: string;
				id: string;
				name: string;
				description: string;
				version: string;
				systemPrompt?: string;
				triggerKeywords?: string;
				authType?: string;
				apiEndpoint?: string;
				primaryColor?: string;
				backgroundColor?: string;
				templateContent?: string;
			},
		) => {
			try {
				const pluginsDir = path.join(getPluginDataDir(), "local", data.id);
				if (fs.existsSync(pluginsDir)) {
					return {
						success: false,
						error: `A plugin with ID "${data.id}" already exists`,
					};
				}
				fs.mkdirSync(pluginsDir, { recursive: true });

				// Build config object
				const config: Record<string, unknown> = {
					id: data.id,
					name: data.name,
					type: data.type,
					version: data.version,
					description: data.description,
				};

				if (data.type === "agent") {
					config.systemPrompt = data.systemPrompt || "";
					if (data.triggerKeywords?.trim()) {
						config.triggers = data.triggerKeywords
							.split(",")
							.map((k) => k.trim())
							.filter(Boolean);
					}
				} else if (data.type === "integration") {
					config.authType = data.authType || "none";
					if (data.apiEndpoint) config.apiEndpoint = data.apiEndpoint;
				} else if (data.type === "theme") {
					config.themeData = {
						"--color-primary": data.primaryColor || "#8b5cf6",
						"--color-background": data.backgroundColor || "#0a0a1a",
					};
				} else if (
					data.type === "spec-template" ||
					data.type === "custom-prompt"
				) {
					config.content = data.templateContent || "";
				}

				// Write plugin.config.json
				const configPath = path.join(pluginsDir, "plugin.config.json");
				fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

				// Write a README
				const readme = `# ${data.name}\n\n${data.description}\n\n## Type\n\n\`${data.type}\`\n\n## Version\n\n\`${data.version}\`\n`;
				fs.writeFileSync(path.join(pluginsDir, "README.md"), readme);

				// Register in local.json for auto-loading
				const localJsonPath = path.join(getPluginDataDir(), "local.json");
				let localConfig: {
					localPlugins: Array<{ path: string; enabled: boolean }>;
				} = { localPlugins: [] };
				try {
					localConfig = JSON.parse(fs.readFileSync(localJsonPath, "utf-8"));
				} catch {
					/* missing or unreadable: use default */
				}
				if (!localConfig.localPlugins.some((p) => p.path === pluginsDir)) {
					localConfig.localPlugins.push({ path: pluginsDir, enabled: true });
				}
				fs.writeFileSync(localJsonPath, JSON.stringify(localConfig, null, 2));

				appLog.info(
					`[Plugin Marketplace] Created plugin: ${data.name} at ${pluginsDir}`,
				);
				return { success: true, data: { path: pluginsDir } };
			} catch (error) {
				appLog.error(`[Plugin Marketplace] Failed to create plugin: ${error}`);
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to create plugin",
				};
			}
		},
	);
}
