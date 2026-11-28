/**
 * Whether this machine starts an MCP server that must run confined (#369,
 * lot 6), as the main asked the backend. One answer for every view that
 * shows a confined server; "check again" refreshes it for all of them.
 */
import { create } from "zustand";
import type { McpSandboxStatus } from "../../shared/types/mcp-sandbox";

interface McpSandboxState {
	/** null until asked, or when the main could not answer. */
	status: McpSandboxStatus | null;
	asked: boolean;
	checking: boolean;
	/** Asks once; with `refresh`, asks the main to probe again. */
	load: (refresh?: boolean) => Promise<void>;
}

export const useMcpSandboxStore = create<McpSandboxState>((set, get) => ({
	status: null,
	asked: false,
	checking: false,
	load: async (refresh = false) => {
		if (get().checking || (get().asked && !refresh)) return;
		set({ asked: true, checking: true });
		try {
			const answer = await window.electronAPI.getMcpSandboxStatus({ refresh });
			set({ status: answer.success && answer.data ? answer.data : null });
		} catch {
			set({ status: null });
		} finally {
			set({ checking: false });
		}
	},
}));
