/**
 * Guardrails API — renderer-side bridge for user-defined agent guardrails.
 */

import { invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export type GuardrailAction = "allow" | "warn" | "deny" | "require_approval";

export interface GuardrailRuleDoc {
	id: string;
	description: string;
	action: GuardrailAction;
	/** Shown to the agent with the refusal: what to do instead. */
	message?: string;
	when: {
		tool?: string | string[];
		path_prefix?: string;
		path_regex?: string;
		path_glob?: string;
		content_regex?: string;
		command_pattern?: string;
		content_max_lines?: number;
		content_max_bytes?: number;
		forbidden_strings?: string[];
		new_file_max_lines?: number;
		adds_regex?: string;
		deletes_tests?: boolean;
		adds_dependency?: boolean;
		branch?: string | string[];
	};
}

/** What the backend read: the layers, the rules kept, and what is wrong. */
export interface GuardrailPolicyReport {
	rules: Array<{ id: string; action: GuardrailAction; description: string; source: string }>;
	sources: Array<{ layer: "global" | "repository" | "project"; path: string; rules: number }>;
	errors: string[];
	warnings: string[];
}

export interface GuardrailEvent {
	id: string;
	at: string;
	action: GuardrailAction;
	outcome: "warn" | "deny" | "pending" | "approved" | string;
	rules: string[];
	tool: string;
	target: { kind: "file" | "command"; key: string; summary: string };
	details: Record<string, string[]>;
	task: string | null;
	message: string;
}

export interface GuardrailActivity {
	events: GuardrailEvent[];
	pending: GuardrailEvent[];
	counts: Record<string, Record<string, number>>;
	blockedLast10Min: number;
	answers: Record<string, "approved" | "refused">;
}

export interface GuardrailDiffCheck {
	policy: GuardrailPolicyReport;
	ref: string;
	checked?: number;
	files: Array<{
		path: string;
		change: string;
		action: GuardrailAction;
		triggered: string[];
		message: string;
		details: Record<string, string[]>;
	}>;
}

export interface GuardrailsDoc {
	version: number;
	rules: GuardrailRuleDoc[];
}

export interface GuardrailTestResult {
	action: GuardrailAction;
	triggered: string[];
	message: string;
	details?: Record<string, string[]>;
	policyErrors?: string[];
}

export interface GuardrailsAPI {
	loadGuardrails: (projectPath: string) => Promise<GuardrailsDoc>;
	saveGuardrails: (projectPath: string, doc: GuardrailsDoc) => Promise<boolean>;
	testGuardrails: (
		projectPath: string,
		toolName: string,
		toolInput: Record<string, unknown>,
	) => Promise<GuardrailTestResult>;
	validateGuardrails: (projectPath: string) => Promise<GuardrailPolicyReport>;
	getGuardrailActivity: (projectPath: string) => Promise<GuardrailActivity>;
	answerGuardrailRequest: (projectPath: string, requestId: string, approve: boolean) => Promise<unknown>;
	checkGuardrailsDiff: (projectPath: string, ref?: string) => Promise<GuardrailDiffCheck>;
}

export const createGuardrailsAPI = (): GuardrailsAPI => ({
	loadGuardrails: (projectPath) =>
		invokeIpc<GuardrailsDoc>(IPC_CHANNELS.GUARDRAILS_LOAD, { projectPath }),
	saveGuardrails: (projectPath, doc) =>
		invokeIpc<boolean>(IPC_CHANNELS.GUARDRAILS_SAVE, { projectPath, doc }),
	testGuardrails: (projectPath, toolName, toolInput) =>
		invokeIpc<GuardrailTestResult>(IPC_CHANNELS.GUARDRAILS_TEST, {
			projectPath,
			toolName,
			toolInput,
		}),
	validateGuardrails: (projectPath) =>
		invokeIpc<GuardrailPolicyReport>(IPC_CHANNELS.GUARDRAILS_VALIDATE, { projectPath }),
	getGuardrailActivity: (projectPath) =>
		invokeIpc<GuardrailActivity>(IPC_CHANNELS.GUARDRAILS_ACTIVITY, { projectPath }),
	answerGuardrailRequest: (projectPath, requestId, approve) =>
		invokeIpc<unknown>(IPC_CHANNELS.GUARDRAILS_ANSWER, { projectPath, requestId, approve }),
	checkGuardrailsDiff: (projectPath, ref) =>
		invokeIpc<GuardrailDiffCheck>(IPC_CHANNELS.GUARDRAILS_CHECK_DIFF, { projectPath, ref }),
});
