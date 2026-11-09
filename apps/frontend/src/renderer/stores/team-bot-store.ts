import { create } from "zustand";
import type {
	TeamBotConfig,
	TeamBotNotification,
} from "../../shared/types/team-bot";

/**
 * Where an earlier version kept the whole configuration, webhook URL in clear.
 * Read once, handed to the main process, then removed (F177).
 */
export const LEGACY_STORAGE_KEY = "workpilot-team-bot";

interface TeamBotState {
	/** As the main process shows it: the webhook URL is masked once saved. */
	config: TeamBotConfig;
	loaded: boolean;
	testing: boolean;
	lastResult: "ok" | "error" | null;
	lastError: string | null;
	load: () => Promise<void>;
	setConfig: (patch: Partial<TeamBotConfig>) => void;
	sendTest: () => Promise<void>;
	notify: (payload: TeamBotNotification) => Promise<boolean>;
}

const DEFAULT_CONFIG: TeamBotConfig = {
	kind: "slack",
	webhook_url: "",
	enabled: false,
	tags: [],
};

function takeLegacyConfig(): TeamBotConfig | null {
	try {
		const raw = globalThis.localStorage?.getItem(LEGACY_STORAGE_KEY);
		if (!raw) return null;
		globalThis.localStorage?.removeItem(LEGACY_STORAGE_KEY);
		const config = (JSON.parse(raw) as { state?: { config?: TeamBotConfig } })
			.state?.config;
		return config?.webhook_url ? config : null;
	} catch {
		return null;
	}
}

let saving: Promise<unknown> = Promise.resolve();

export const useTeamBotStore = create<TeamBotState>()((set, get) => ({
	config: DEFAULT_CONFIG,
	loaded: false,
	testing: false,
	lastResult: null,
	lastError: null,

	load: async () => {
		try {
			const legacy = takeLegacyConfig();
			const config = legacy
				? await window.electronAPI.teamBotSaveConfig(legacy)
				: await window.electronAPI.teamBotGetConfig();
			set({ config, loaded: true });
		} catch (e) {
			set({ loaded: true, lastError: (e as Error).message });
		}
	},

	setConfig: (patch) => {
		const config = { ...get().config, ...patch };
		set({ config });
		// In order, so a quick succession of edits cannot store an older one last.
		saving = saving
			.catch(() => undefined)
			.then(() => window.electronAPI.teamBotSaveConfig(config))
			.then(
				() => set({ lastError: null }),
				(e: Error) => set({ lastResult: "error", lastError: e.message }),
			);
	},

	sendTest: async () => {
		set({ testing: true, lastResult: null, lastError: null });
		try {
			await saving;
			const { ok } = await window.electronAPI.teamBotTest();
			set({ lastResult: ok ? "ok" : "error" });
		} catch (e) {
			set({ lastResult: "error", lastError: (e as Error).message });
		} finally {
			set({ testing: false });
		}
	},

	notify: async (payload) => {
		try {
			const { ok } = await window.electronAPI.teamBotSend(payload);
			return ok;
		} catch {
			return false;
		}
	},
}));
