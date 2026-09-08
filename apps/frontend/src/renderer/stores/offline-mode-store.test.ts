import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOfflineModeStore } from "./offline-mode-store";
import {
	isValidOfflinePolicy,
	modelsForProvider,
} from "./offline-mode-routing";

const catalog = {
	providers: { ollama: ["qwen2.5-coder:7b"], "lm-studio": [], "llama-cpp": [] },
	local: { ollama: true, lmStudio: false, llamaCpp: false },
	cachedAt: "",
	ttlSeconds: 900,
	fromCache: false,
	ageSeconds: 0,
};
const policy = () => ({
	version: 1,
	airgapStrict: true,
	defaultProvider: "ollama",
	history: [],
	routing: { coder: { provider: "ollama", model: "qwen2.5-coder:7b" } },
});
const api = {
	getOfflineStatus: vi.fn(),
	getOfflinePolicy: vi.fn(),
	getOfflineReport: vi.fn(),
	scanOfflineModels: vi.fn(),
	setOfflinePolicy: vi.fn(),
};

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubGlobal("electronAPI", api);
	useOfflineModeStore.setState({
		projectPath: "project",
		savedPolicy: null,
		policy: policy(),
		catalog,
		dirty: false,
		error: null,
		loading: false,
		saving: false,
		scanning: false,
	});
});

describe("offline routing", () => {
	it("adds an installed model belonging to the selected provider", () => {
		useOfflineModeStore.getState().addRoutingRow("summary");
		expect(useOfflineModeStore.getState().policy?.routing.summary).toEqual({
			provider: "ollama",
			model: "qwen2.5-coder:7b",
		});
		useOfflineModeStore.getState().setDefaultProvider("lm-studio");
		useOfflineModeStore.getState().addRoutingRow("triage");
		expect(useOfflineModeStore.getState().policy?.routing.triage).toEqual({
			provider: "lm-studio",
			model: "",
		});
	});

	it("rejects cloud models even when supplied by a legacy cache", () => {
		expect(
			modelsForProvider(
				{ ...catalog, providers: { anthropic: ["claude"] } },
				"anthropic",
			),
		).toEqual([]);
		const invalid = policy();
		invalid.routing.coder.model = "missing:7b";
		expect(isValidOfflinePolicy(invalid, catalog)).toBe(false);
	});

	it("does not save an unavailable model", async () => {
		useOfflineModeStore.getState().setRouting("coder", "ollama", "missing:7b");
		await useOfflineModeStore.getState().save("project");
		expect(api.setOfflinePolicy).not.toHaveBeenCalled();
		expect(useOfflineModeStore.getState().dirty).toBe(true);
	});

	it("refreshes both inventory and catalog without overwriting edits", async () => {
		const edited = policy();
		useOfflineModeStore.setState({ policy: edited, dirty: true });
		api.getOfflineStatus.mockResolvedValue({ offlineReady: false });
		api.scanOfflineModels.mockResolvedValue({
			...catalog,
			providers: { ollama: [] },
		});
		await useOfflineModeStore.getState().refreshStatus("project");
		expect(api.scanOfflineModels).toHaveBeenCalledWith("project", true);
		expect(useOfflineModeStore.getState().catalog?.providers.ollama).toEqual(
			[],
		);
		expect(useOfflineModeStore.getState().policy).toBe(edited);
		expect(useOfflineModeStore.getState().dirty).toBe(true);
	});

	it("ignores a late response from a previous project", async () => {
		let finish!: (value: unknown) => void;
		api.getOfflineStatus.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		api.getOfflinePolicy.mockResolvedValue({
			policy: policy(),
			persisted: true,
		});
		api.getOfflineReport.mockResolvedValue({ total: 0 });
		api.scanOfflineModels.mockResolvedValue(catalog);
		const pending = useOfflineModeStore.getState().loadAll("old");
		api.getOfflineStatus.mockResolvedValue({ offlineReady: true });
		await useOfflineModeStore.getState().loadAll("new");
		finish({ offlineReady: false });
		await pending;
		expect(useOfflineModeStore.getState().projectPath).toBe("new");
		expect(useOfflineModeStore.getState().status?.offlineReady).toBe(true);
	});

	it("makes a generated policy available to save immediately", async () => {
		api.getOfflineStatus.mockResolvedValue({ offlineReady: true });
		api.getOfflinePolicy.mockResolvedValue({
			policy: policy(),
			persisted: false,
		});
		api.getOfflineReport.mockResolvedValue({ total: 0 });
		api.scanOfflineModels.mockResolvedValue(catalog);
		await useOfflineModeStore.getState().loadAll("project");
		expect(useOfflineModeStore.getState().dirty).toBe(true);
	});
});

it("can disable strict with an unavailable runtime without changing routes", async () => {
	const saved = policy();
	useOfflineModeStore.setState({
		savedPolicy: saved,
		policy: saved,
		catalog: { ...catalog, providers: {} },
	});
	useOfflineModeStore.getState().setAirgap(false);
	await useOfflineModeStore.getState().save("project");
	expect(api.setOfflinePolicy).toHaveBeenCalledWith("project", {
		...saved,
		airgapStrict: false,
	});
});

it("refuses a strict default runtime without any configured model", () => {
	const invalid = policy();
	invalid.defaultProvider = "lm-studio";
	expect(isValidOfflinePolicy(invalid, catalog)).toBe(false);
});
