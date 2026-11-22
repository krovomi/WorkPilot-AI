/**
 * Whether this machine starts an MCP server that must run confined (#369,
 * lot 6), as the backend decides it (`core.mcp_confinement`,
 * `machine_confinement`, printed by `runners/mcp_sandbox_runner.py`).
 *
 * A confined server is never started without the OS sandbox: where there is
 * none, the app says so next to the server, with the reason.
 */

/**
 * - `available`: the OS sandbox works here;
 * - `off`: the person turned it off (`WORKPILOT_SANDBOX=off`);
 * - `unsupported`: this system has none WorkPilot can use (Windows, for now);
 * - `missing`: its program (`backend`: bubblewrap, seatbelt) is not installed;
 * - `refused`: its program is there and the system refused to run it;
 * - `unknown`: the app could not ask (no Python yet, the runner failed).
 */
export const MCP_SANDBOX_KINDS = [
	"available",
	"off",
	"unsupported",
	"missing",
	"refused",
	"unknown",
] as const;
export type McpSandboxKind = (typeof MCP_SANDBOX_KINDS)[number];

export interface McpSandboxStatus {
	available: boolean;
	kind: McpSandboxKind;
	/** The sandbox WorkPilot would use: `bubblewrap`, `seatbelt`, or none. */
	backend: string | null;
	/** Stable English detail from the backend, shown as text under the app's sentence. */
	reason: string | null;
}

export interface McpSandboxRequest {
	/** Probe again instead of the answer kept since the app started. */
	refresh?: boolean;
}
