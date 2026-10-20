import { create } from "zustand";
import type { JevCredentialStatus } from "../../shared/types/jev";
interface JevState {
	status: JevCredentialStatus | null;
	refresh(): Promise<void>;
}
let generation = 0;
export const useJevStore = create<JevState>((set) => ({
	status: null,
	refresh: async () => {
		const current = ++generation;
		try {
			const result = await window.electronAPI.getJevStatus();
			if (current === generation)
				set({ status: result.success && result.data ? result.data : null });
		} catch {
			if (current === generation) set({ status: null });
		}
	},
}));
