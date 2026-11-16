/**
 * The Azure DevOps handlers: the connection, the repositories, the work items
 * and their import as tasks (`azure-devops-import.ts`), and two repairs of an
 * imported task, its display fields and its acceptance criteria. Azure DevOps
 * is reached through the backend runner (`azure-devops-connector.ts`), the
 * project's credentials in its environment only. Every channel registers on
 * `azureDevOpsIpcMain` (`azure-devops-ipc-guard.ts`), which checks what the
 * renderer sends before the handler runs.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { AUTO_BUILD_PATHS, getSpecsDir, IPC_CHANNELS } from "../../shared/constants";
import type {
	AzureDevOpsImportResult,
	AzureDevOpsRepository,
	AzureDevOpsSyncStatus,
	AzureDevOpsWorkItem,
	IPCResult,
	Project,
	Task,
} from "../../shared/types";
import { parseAcceptanceCriteriaText } from "../../shared/utils/acceptance-criteria";
import type { AgentManager } from "../agent";
import { readProjectEnv } from "../project-env-file";
import { projectStore } from "../project-store";
import { readIfExists, updateExistingFile } from "../utils/existing-file";
import { type AzureDevOpsOperation, callAzureDevOpsPython } from "./azure-devops-connector";
import { importWorkItem, nextSpecNumber, plainTitle, specIdOf } from "./azure-devops-import";
import { azureDevOpsIpcMain } from "./azure-devops-ipc-guard";
import { inlineAzureDevOpsImages, stripAzureAttachmentImages } from "./shared/azure-attachments";

/** The project's Azure DevOps settings, from its `.workpilot/.env`. */
interface AzureConfig {
	pat?: string;
	orgUrl?: string;
	/** Decoded: the settings may hold it as it appears in a URL (`My%20Project`). */
	projectName?: string;
}

/** A project whose settings name an organization and a token. */
interface Configured {
	project: Project;
	config: AzureConfig & { pat: string; orgUrl: string };
}

type Refusal = { success: false; error: string };

const decodeName = (name: string | undefined): string | undefined => {
	if (!name) return undefined;
	try {
		return decodeURIComponent(name);
	} catch {
		return name;
	}
};

function readConfig(project: Project): AzureConfig {
	if (!project.autoBuildPath) return {};
	try {
		const vars = readProjectEnv(project);
		return {
			pat: vars.AZURE_DEVOPS_PAT || undefined,
			orgUrl: vars.AZURE_DEVOPS_ORG_URL || undefined,
			projectName: decodeName(vars.AZURE_DEVOPS_PROJECT),
		};
	} catch {
		return {};
	}
}

/** What went wrong: the runner, the file system and these handlers only throw errors. */
const messageOf = (error: unknown): string => (error as Error).message;

/**
 * Calls the connector in the project's folder. Its environment holds the
 * project's credentials, and its Azure DevOps project over any the system has.
 */
function call<T>(project: Project, config: AzureConfig, operation: AzureDevOpsOperation, params = {}): Promise<T> {
	const env: Record<string, string> = {};
	if (config.pat) env.AZURE_DEVOPS_PAT = config.pat;
	if (config.orgUrl) env.AZURE_DEVOPS_ORG_URL = config.orgUrl;
	if (config.projectName) env.AZURE_DEVOPS_PROJECT = config.projectName;
	return callAzureDevOpsPython(
		path.join(project.path, project.autoBuildPath || ""),
		operation,
		params,
		env,
	) as Promise<T>;
}

/** The project and its settings, or why the channel cannot reach Azure DevOps. */
function configured(projectId: string, mustBeInitialized = false): Configured | Refusal {
	const project = projectStore.getProject(projectId);
	if (!project || (mustBeInitialized && !project.autoBuildPath)) {
		return { success: false, error: mustBeInitialized ? "Project not found or not initialized" : "Project not found" };
	}
	const { pat, orgUrl, projectName } = readConfig(project);
	if (!pat || !orgUrl) {
		return {
			success: false,
			error: mustBeInitialized ? "Azure DevOps not configured" : "Azure DevOps not configured for this project",
		};
	}
	return { project, config: { pat, orgUrl, projectName } };
}

/** The result of `work`, or its error as the channel's answer. */
async function attempt<T>(work: () => Promise<T>): Promise<IPCResult<T>> {
	try {
		return { success: true, data: await work() };
	} catch (error) {
		return { success: false, error: messageOf(error) };
	}
}

/** The work item an imported task came from: its identifier is `ADO-<id>`. */
function workItemIdOf(task: Task): number | undefined {
	const id = Number(/^ADO-(\d+)$/i.exec(task.metadata?.azureDevOpsIdentifier ?? "")?.[1]);
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

const findTask = (projectId: string, taskId: string): Task | undefined =>
	projectStore.getTasks(projectId).find((task) => task.id === taskId);

/** The JSON object a file holds, or `undefined` when it holds anything else. */
function parseObject(text: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Imports the chosen work items of the project's backlog as tasks, one spec folder each. */
async function importWorkItems(
	{ project, config }: Configured,
	workItemIds: number[],
	requireReviewBeforeCoding: boolean | undefined,
): Promise<AzureDevOpsImportResult> {
	const items = await call<AzureDevOpsWorkItem[]>(project, config, "list_work_items", { max_items: 1000 });
	const wanted = new Set(workItemIds);
	const selected = items.filter((item) => wanted.has(item.id));
	if (selected.length === 0) throw new Error("No matching work items found");

	const specsDir = path.join(project.path, getSpecsDir(project.autoBuildPath));
	mkdirSync(specsDir, { recursive: true });
	let specNumber = nextSpecNumber(specsDir);
	const context = { projectId: project.id, specsDir, pat: config.pat, orgUrl: config.orgUrl, requireReviewBeforeCoding };
	const tasks: Task[] = [];
	const errors: string[] = [];
	for (const item of selected) {
		try {
			tasks.push(await importWorkItem(item, specIdOf(specNumber, plainTitle(item.title)), context));
		} catch (error) {
			errors.push(`Failed to import work item ${item.id}: ${messageOf(error)}`);
		}
		specNumber += 1;
	}
	projectStore.invalidateTasksCache(project.id);
	return {
		success: true,
		imported: tasks.length,
		failed: errors.length,
		errors: errors.length > 0 ? errors : undefined,
		tasks,
	};
}

/**
 * The accented title of an imported task that has none: older imports only
 * kept the spec folder name, a slug without accents. A failed fetch leaves it
 * missing.
 */
async function fetchTitle(project: Project, config: AzureConfig, task: Task): Promise<string | undefined> {
	const workItemId = workItemIdOf(task);
	if (!workItemId || !config.pat || !config.orgUrl) return undefined;
	try {
		const item = await call<{ title?: string }>(project, config, "get_work_item", { work_item_id: workItemId });
		return plainTitle(item.title ?? "") || undefined;
	} catch (error) {
		console.warn("[AZURE_DEVOPS_HYDRATE_TASK_DISPLAY] Title fetch failed (non-fatal):", messageOf(error));
		return undefined;
	}
}

/**
 * The display fields of an imported task, repaired once, on open: the
 * accented title when it is missing, and the description with its Azure
 * DevOps images inlined (they need the PAT, so the renderer cannot load them),
 * any that still fail stripped so that they never fire a failing request. The
 * fields that changed are written onto the file as it is by then.
 */
async function hydrateTaskDisplay(projectId: string, taskId: string): Promise<{ html: string; title?: string }> {
	const project = projectStore.getProject(projectId);
	if (!project) throw new Error("Project not found");
	const task = findTask(projectId, taskId);
	if (!task?.specsPath) throw new Error("Task spec directory not found");
	const requirementsPath = path.join(task.specsPath, AUTO_BUILD_PATHS.REQUIREMENTS);
	const text = readIfExists(requirementsPath);
	if (text === null) throw new Error("requirements.json not found");
	const requirements = parseObject(text);
	if (!requirements) throw new Error("requirements.json is malformed");

	const config = readConfig(project);
	const changes: Record<string, string> = {};

	let title = typeof requirements.display_title === "string" ? requirements.display_title : undefined;
	if (!title) {
		title = await fetchTitle(project, config, task);
		if (title) changes.display_title = title;
	}

	const display = typeof requirements.display_description === "string" ? requirements.display_description : "";
	const source = display || (typeof requirements.task_description === "string" ? requirements.task_description : "");
	let html = source;
	if (source.includes("<img")) {
		if (config.pat && config.orgUrl) html = await inlineAzureDevOpsImages(source, config.orgUrl, config.pat);
		html = stripAzureAttachmentImages(html, config.orgUrl);
		if (html !== display) changes.display_description = html;
	}

	if (Object.keys(changes).length > 0) {
		try {
			updateExistingFile(requirementsPath, (current) => {
				const latest = parseObject(current);
				return latest ? JSON.stringify({ ...latest, ...changes }, null, 2) : null;
			});
			projectStore.invalidateTasksCache(projectId);
		} catch (error) {
			console.warn("[AZURE_DEVOPS_HYDRATE_TASK_DISPLAY] Could not persist display fields:", messageOf(error));
		}
	}
	return { html, title };
}

/**
 * The acceptance criteria of a task's work item, read again from Azure DevOps
 * and written into its metadata and requirements. The work item must be the
 * one the task was imported from.
 */
async function syncTaskCriteria(
	{ project, config }: Configured,
	taskId: string,
	workItemId: number,
): Promise<{ acceptanceCriteria: string[] }> {
	const task = findTask(project.id, taskId);
	if (!task || workItemIdOf(task) !== workItemId) throw new Error("This task was not imported from that work item");
	const item = await call<{ acceptanceCriteria?: string }>(project, config, "get_work_item", {
		work_item_id: workItemId,
	});
	const acceptanceCriteria = parseAcceptanceCriteriaText(item.acceptanceCriteria ?? undefined);
	if (task.specsPath) {
		const write = (file: string, key: string) =>
			updateExistingFile(path.join(task.specsPath as string, file), (text) => {
				const content = parseObject(text);
				return content ? JSON.stringify({ ...content, [key]: acceptanceCriteria }, null, 2) : null;
			});
		write("task_metadata.json", "acceptanceCriteria");
		write(AUTO_BUILD_PATHS.REQUIREMENTS, "acceptance_criteria");
		projectStore.invalidateTasksCache(project.id);
	}
	return { acceptanceCriteria };
}

/** Register all Azure DevOps-related IPC handlers. */
export function registerAzureDevOpsHandlers(
	_agentManager: AgentManager,
	_getMainWindow: () => BrowserWindow | null,
): void {
	azureDevOpsIpcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION,
		async (_, projectId: string): Promise<IPCResult<AzureDevOpsSyncStatus>> => {
			const ready = configured(projectId);
			if (!("project" in ready)) {
				return ready.error === "Project not found"
					? ready
					: { success: true, data: { connected: false, error: "Azure DevOps not configured" } };
			}
			const { project, config } = ready;
			try {
				// The runner gives the project it detected from the git remote.
				const info = await call<{ project?: string } | null>(project, config, "test_connection");
				return {
					success: true,
					data: { connected: true, organizationUrl: config.orgUrl, projectName: info?.project || config.projectName },
				};
			} catch (error) {
				return { success: true, data: { connected: false, error: messageOf(error) } };
			}
		},
	);

	azureDevOpsIpcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_LIST_REPOSITORIES,
		async (_, projectId: string): Promise<IPCResult<AzureDevOpsRepository[]>> => {
			const ready = configured(projectId);
			if (!("project" in ready)) return ready;
			return attempt(() => call(ready.project, ready.config, "list_repositories"));
		},
	);

	// The repository comes from the git remote: no credential is needed.
	azureDevOpsIpcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_DETECT_REPOSITORY,
		async (_, projectId: string): Promise<IPCResult<{ repository: string | null }>> => {
			const project = projectStore.getProject(projectId);
			if (!project) return { success: false, error: "Project not found" };
			return attempt(() => call(project, {}, "detect_repository"));
		},
	);

	azureDevOpsIpcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEMS,
		async (
			_,
			projectId: string,
			_azureProject?: string,
			itemTypes?: string[],
			maxItems?: number,
		): Promise<IPCResult<AzureDevOpsWorkItem[]>> => {
			const ready = configured(projectId);
			if (!("project" in ready)) return ready;
			return attempt(() =>
				call(ready.project, ready.config, "list_work_items", { item_types: itemTypes, max_items: maxItems || 100 }),
			);
		},
	);

	// Any work item by its id, custom types and items outside the backlog
	// window included, so that the import search finds it.
	azureDevOpsIpcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM,
		async (_, projectId: string, workItemId: number): Promise<IPCResult<AzureDevOpsWorkItem>> => {
			const ready = configured(projectId);
			if (!("project" in ready)) return ready;
			return attempt(() => call(ready.project, ready.config, "get_work_item", { work_item_id: workItemId }));
		},
	);

	azureDevOpsIpcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_IMPORT_WORK_ITEMS,
		async (
			_,
			projectId: string,
			workItemIds: number[],
			options?: { requireReviewBeforeCoding?: boolean },
		): Promise<IPCResult<AzureDevOpsImportResult>> => {
			const ready = configured(projectId, true);
			if (!("project" in ready)) return ready;
			return attempt(() => importWorkItems(ready, workItemIds, options?.requireReviewBeforeCoding));
		},
	);

	azureDevOpsIpcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_HYDRATE_TASK_DISPLAY,
		(_, projectId: string, taskId: string): Promise<IPCResult<{ html: string; title?: string }>> =>
			attempt(() => hydrateTaskDisplay(projectId, taskId)),
	);

	azureDevOpsIpcMain.handle(
		IPC_CHANNELS.AZURE_DEVOPS_SYNC_TASK_AC,
		async (
			_,
			projectId: string,
			taskId: string,
			workItemId: number,
		): Promise<IPCResult<{ acceptanceCriteria: string[] }>> => {
			const ready = configured(projectId, true);
			if (!("project" in ready)) return ready;
			return attempt(() => syncTaskCriteria(ready, taskId, workItemId));
		},
	);
}
