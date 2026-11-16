/**
 * Defaults and bounds of the agent safety settings, the same as the backend's
 * (`apps/backend/security/agent_safety_settings.py`): the Settings pages edit
 * a normalized copy, and what the main process sends is normalized again.
 */

import type { AgentSafetySettings, SandboxMode } from "../types/agent-safety";

export const MAX_ALLOWED_PATHS = 50;

export const DEFAULT_AGENT_SAFETY: AgentSafetySettings = {
	snapshots: { enabled: true, keep: 10, autoRollback: true },
	sandbox: {
		mode: "normal",
		allowedPaths: [],
		maxFilesWritten: 200,
		maxFileSizeMb: 10,
		maxSessionMinutes: 0,
	},
	anomaly: {
		enabled: true,
		pauseBelow: 40,
		stopBelow: 20,
		massDeletionCount: 5,
		maxErrorCount: 10,
		rapidChangeWindowS: 10,
	},
};

/** A snapshot id as the backend names one: a UTC timestamp and a label. */
export const SNAPSHOT_ID = /^\d{8}T\d{12}Z-[a-z_]{1,32}$/;

function section(raw: unknown, key: string): Record<string, unknown> {
	if (!raw || typeof raw !== "object") return {};
	const value = (raw as Record<string, unknown>)[key];
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function bool(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
	return typeof raw[key] === "boolean" ? (raw[key] as boolean) : fallback;
}

function num(
	raw: Record<string, unknown>,
	key: string,
	fallback: number,
	low: number,
	high: number,
	integer = true,
): number {
	const value = raw[key];
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const bounded = Math.min(Math.max(value, low), high);
	return integer ? Math.trunc(bounded) : bounded;
}

/** A project-relative path, forward slashes, no `..`; null when unusable. */
export function normalizeAllowedPath(entry: unknown): string | null {
	if (typeof entry !== "string") return null;
	const text = entry.trim().replace(/\\/g, "/");
	if (!text || text.length > 400 || text.includes("\0")) return null;
	if (text.startsWith("/") || /^[A-Za-z]:/.test(text)) return null;
	const parts = text.split("/").filter((part) => part && part !== ".");
	if (parts.length === 0 || parts.includes("..")) return null;
	return parts.join("/");
}

export function normalizeAgentSafety(raw: unknown): AgentSafetySettings {
	const d = DEFAULT_AGENT_SAFETY;
	const snap = section(raw, "snapshots");
	const box = section(raw, "sandbox");
	const watch = section(raw, "anomaly");
	const mode: SandboxMode = box.mode === "restricted" ? "restricted" : "normal";
	const paths: string[] = [];
	if (Array.isArray(box.allowedPaths)) {
		for (const entry of box.allowedPaths.slice(0, MAX_ALLOWED_PATHS * 2)) {
			const path = normalizeAllowedPath(entry);
			if (path && !paths.includes(path)) paths.push(path);
		}
	}
	const pauseBelow = num(watch, "pauseBelow", d.anomaly.pauseBelow, 0, 100);
	return {
		snapshots: {
			enabled: bool(snap, "enabled", d.snapshots.enabled),
			keep: num(snap, "keep", d.snapshots.keep, 1, 50),
			autoRollback: bool(snap, "autoRollback", d.snapshots.autoRollback),
		},
		sandbox: {
			mode,
			allowedPaths: paths.slice(0, MAX_ALLOWED_PATHS),
			maxFilesWritten: num(box, "maxFilesWritten", d.sandbox.maxFilesWritten, 0, 10_000),
			maxFileSizeMb: num(box, "maxFileSizeMb", d.sandbox.maxFileSizeMb, 0, 1024, false),
			maxSessionMinutes: num(box, "maxSessionMinutes", d.sandbox.maxSessionMinutes, 0, 1440),
		},
		anomaly: {
			enabled: bool(watch, "enabled", d.anomaly.enabled),
			pauseBelow,
			stopBelow: Math.min(num(watch, "stopBelow", d.anomaly.stopBelow, 0, 100), pauseBelow),
			massDeletionCount: num(watch, "massDeletionCount", d.anomaly.massDeletionCount, 1, 1000),
			maxErrorCount: num(watch, "maxErrorCount", d.anomaly.maxErrorCount, 1, 1000),
			rapidChangeWindowS: num(watch, "rapidChangeWindowS", d.anomaly.rapidChangeWindowS, 1, 3600),
		},
	};
}
