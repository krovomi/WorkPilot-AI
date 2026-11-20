/**
 * What the Mission Control cards and dialog share: the roles an agent can take
 * (the backend's `AgentRole`), and how a run's elapsed time is written.
 * Role names and hints are translated under `missionControl:roles` / `roleHints`.
 */

export const AGENT_ROLES = [
	{ value: "architect", emoji: "🏗️" },
	{ value: "coder", emoji: "💻" },
	{ value: "tester", emoji: "🧪" },
	{ value: "reviewer", emoji: "👁️" },
	{ value: "documenter", emoji: "📝" },
	{ value: "planner", emoji: "📋" },
	{ value: "debugger", emoji: "🐛" },
	{ value: "custom", emoji: "⚙️" },
] as const;

export const ROLE_EMOJI: Record<string, string> = Object.fromEntries(AGENT_ROLES.map((r) => [r.value, r.emoji]));

/** 42s, 3m 5s, 2h 7m. */
export function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${Math.floor(seconds)}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	return `${h}h ${m}m`;
}
