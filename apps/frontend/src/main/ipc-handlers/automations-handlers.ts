/**
 * Automations IPC: list, save, delete and run a project's rules. The renderer
 * names a project by id and sends a rule as data; the main process resolves
 * the project and checks every field of the rule (`automations/rules.ts`).
 */

import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { AutomationsState, IPCResult, Project } from "../../shared/types";
import type { AgentManager } from "../agent";
import { isRuleId, MAX_RULES, parseRule } from "../automations/rules";
import { AutomationScheduler, liveDeps } from "../automations/scheduler";
import { forgetRule, readLedger, readRules, writeLedger, writeRules } from "../automations/store";
import { projectStore } from "../project-store";

let scheduler: AutomationScheduler | null = null;

function projectFor(projectId: unknown): Project | string {
	if (typeof projectId !== "string") return "Unknown project";
	const project = projectStore.getProject(projectId);
	if (!project) return "Unknown project";
	if (!project.autoBuildPath) return "Initialize WorkPilot in this project first";
	return project;
}

export function automationsState(project: Project): AutomationsState {
	const ledger = readLedger(project);
	return {
		rules: readRules(project),
		statuses: ledger.statuses,
		activity: [...ledger.activity].reverse(),
	};
}

export function registerAutomationsHandlers(
	agentManager: AgentManager,
	getMainWindow: () => BrowserWindow | null,
	createScheduler: () => AutomationScheduler = () =>
		new AutomationScheduler(liveDeps(agentManager), getMainWindow),
): void {
	scheduler = createScheduler();
	scheduler.start();

	ipcMain.handle(
		IPC_CHANNELS.AUTOMATIONS_GET,
		async (_, projectId: unknown): Promise<IPCResult<AutomationsState>> => {
			const project = projectFor(projectId);
			if (typeof project === "string") return { success: false, error: project };
			return { success: true, data: automationsState(project) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.AUTOMATIONS_SAVE,
		async (_, projectId: unknown, raw: unknown): Promise<IPCResult<AutomationsState>> => {
			const project = projectFor(projectId);
			if (typeof project === "string") return { success: false, error: project };
			const rules = readRules(project);
			const id = (raw as { id?: unknown } | null)?.id;
			let existing: (typeof rules)[number] | undefined;
			if (id !== undefined) {
				existing = isRuleId(id) ? rules.find((rule) => rule.id === id) : undefined;
				if (!existing) return { success: false, error: "Unknown rule" };
			} else if (rules.length >= MAX_RULES) {
				return { success: false, error: `A project has at most ${MAX_RULES} rules` };
			}
			const rule = parseRule(raw, existing);
			if (typeof rule === "string") return { success: false, error: rule };
			writeRules(
				project,
				existing ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule],
			);
			return { success: true, data: automationsState(project) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.AUTOMATIONS_DELETE,
		async (_, projectId: unknown, ruleId: unknown): Promise<IPCResult<AutomationsState>> => {
			const project = projectFor(projectId);
			if (typeof project === "string") return { success: false, error: project };
			const rules = readRules(project);
			if (!isRuleId(ruleId) || !rules.some((rule) => rule.id === ruleId)) {
				return { success: false, error: "Unknown rule" };
			}
			writeRules(
				project,
				rules.filter((rule) => rule.id !== ruleId),
			);
			const ledger = readLedger(project);
			forgetRule(ledger, ruleId);
			writeLedger(project, ledger);
			return { success: true, data: automationsState(project) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.AUTOMATIONS_RUN,
		async (_, projectId: unknown): Promise<IPCResult<AutomationsState>> => {
			const project = projectFor(projectId);
			if (typeof project === "string") return { success: false, error: project };
			if (!scheduler) return { success: false, error: "Automations are not running" };
			await scheduler.run(project);
			return { success: true, data: automationsState(project) };
		},
	);
}
