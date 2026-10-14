import { create } from "zustand";
import type { SecureStorageStatus } from "../../shared/types/ipc";

interface SecureStorageState {
	status: SecureStorageStatus | null;
	/** Hidden by the user for this session; back on the next launch. */
	dismissed: boolean;
	setStatus(status: SecureStorageStatus): void;
	dismiss(): void;
	refresh(): Promise<void>;
}

export const useSecureStorageStore = create<SecureStorageState>((set) => ({
	status: null,
	dismissed: false,
	// Secrets newly at risk bring a dismissed warning back.
	setStatus: (status) =>
		set((state) => ({
			status,
			dismissed: state.dismissed && !!state.status?.secretsAtRisk,
		})),
	dismiss: () => set({ dismissed: true }),
	refresh: async () => {
		try {
			const result = await window.electronAPI.getSecureStorageStatus();
			if (result.success && result.data) {
				useSecureStorageStore.getState().setStatus(result.data);
			}
		} catch {
			// The last known status stands.
		}
	},
}));

/**
 * Registered once by global-listeners: the status is pulled at startup, then
 * pushed by the main process when a secret is stored without the OS keyring.
 */
export function setupSecureStorageListeners(): () => void {
	const unsubscribe = window.electronAPI.onSecureStorageStatusChanged(
		(status) => useSecureStorageStore.getState().setStatus(status),
	);
	void useSecureStorageStore.getState().refresh();
	return unsubscribe;
}
