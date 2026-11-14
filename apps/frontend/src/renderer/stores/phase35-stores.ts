/**
 * Zustand stores for the 12 Phase 3-5 backend feature modules.
 *
 * One slice per feature, all in one file because the features are simple
 * (status + result + error) and sharing the file keeps imports tight.
 */

import { create } from "zustand";
import type {
	ProjectAgentHealth,
	AnomalyReport,
	AnomalySignal,
	AuditEvent,
	DomainAgentBundle,
	DomainProfile,
	DomainSummary,
	DriftReport,
	GenerationSummary,
	GenTestCommand,
	I18nDict,
	I18nScalingReport,
	LicenseScanReport,
	LocaleDiffData,
	ModelChoice,
	OptimizedContext,
	PairOperation,
	PairRoomSnapshot,
	RegressionReport,
	RouteRequest,
	ArchitectureScanReport,
} from "../../preload/api/modules/phase35-features-api";
import type { LongevityReport } from "../../shared/types/longevity";

type Phase = "idle" | "running" | "ok" | "error";

interface BaseSlice {
	phase: Phase;
	error: string | null;
}

// ---------- helpers ----------

function unwrap<T>(
	res: { success: true } & T,
	fallback?: never,
): T;
function unwrap<_T>(res: { success: false; error: string }): never;
function unwrap<T>(res: { success: boolean; error?: string } & T): T {
	if (!res.success) throw new Error(res.error ?? "Unknown backend error");
	return res;
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ---------- #3.8 Longevity ----------

interface LongevityState extends BaseSlice {
	report: LongevityReport | null;
	compute: (projectPath: string) => Promise<void>;
	reset: () => void;
}

export const useLongevityStore = create<LongevityState>((set) => ({
	phase: "idle",
	error: null,
	report: null,
	compute: async (projectPath) => {
		if (!projectPath) {
			set({ phase: "error", error: "projectPath is required" });
			return;
		}
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.scoreLongevity(projectPath);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", report: res.report ?? null });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	reset: () => set({ phase: "idle", error: null, report: null }),
}));

// ---------- #3.11 Agent Health ----------

interface AgentHealthState extends BaseSlice {
	projectPath: string | null;
	health: ProjectAgentHealth | null;
	/** Score the agents that ran the project's Kanban tasks, read from their logs. */
	refresh: (projectPath: string) => Promise<void>;
}

export const useAgentHealthStore = create<AgentHealthState>((set) => ({
	phase: "idle",
	error: null,
	projectPath: null,
	health: null,
	refresh: async (projectPath) => {
		set({ phase: "running", error: null, projectPath });
		try {
			const res = await globalThis.electronAPI.scoreProjectAgentHealth(projectPath);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			const { scores, pending, tasks_read, min_runs } = res;
			set({ phase: "ok", health: { scores, pending, tasks_read, min_runs } });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e), health: null });
		}
	},
}));

// ---------- #3.1 Model Router ----------

interface ModelRouterState extends BaseSlice {
	chosen: ModelChoice | null;
	comparison: Record<string, ModelChoice> | null;
	route: (req: RouteRequest) => Promise<void>;
	compare: (req: RouteRequest) => Promise<void>;
}

export const useModelRouterStore = create<ModelRouterState>((set) => ({
	phase: "idle",
	error: null,
	chosen: null,
	comparison: null,
	route: async (req) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.routeModel(req);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", chosen: res.choice });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	compare: async (req) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.compareModels(req);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", comparison: res.by_tier });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.6 Domain Agents ----------

interface DomainAgentsState extends BaseSlice {
	domains: DomainSummary[];
	selectedDomain: string | null;
	profile: DomainProfile | null;
	bundle: DomainAgentBundle | null;
	loadDomains: () => Promise<void>;
	loadProfile: (domain: string) => Promise<void>;
	build: (domain: string, role: string) => Promise<void>;
}

export const useDomainAgentsStore = create<DomainAgentsState>((set) => ({
	phase: "idle",
	error: null,
	domains: [],
	selectedDomain: null,
	profile: null,
	bundle: null,
	loadDomains: async () => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.listDomains();
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", domains: res.domains });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	loadProfile: async (domain) => {
		set({ phase: "running", error: null, selectedDomain: domain });
		try {
			const res = await globalThis.electronAPI.getDomainProfile(domain);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", profile: res.profile });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	build: async (domain, role) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.buildDomainBundle(domain, role);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", bundle: res.bundle });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.4 CICD Anomaly ----------

interface CicdAnomalyState extends BaseSlice {
	signals: AnomalySignal[];
	report: AnomalyReport | null;
	scan: (log: string, label?: string) => Promise<void>;
	analyse: (samples: { label: string; text: string }[]) => Promise<void>;
}

export const useCicdAnomalyStore = create<CicdAnomalyState>((set) => ({
	phase: "idle",
	error: null,
	signals: [],
	report: null,
	scan: async (log, label) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.scanCicdLog(log, label);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", signals: res.signals });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	analyse: async (samples) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.analyseCicdLogs(samples);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", report: res.report, signals: res.report.signals });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.7 License Governance ----------

interface LicenseState extends BaseSlice {
	report: LicenseScanReport | null;
	/** Whether the last scan could ask the public registries. */
	online: boolean | null;
	scan: (
		projectPath: string,
		policy?: "permissive_only" | "open_source_friendly" | "saas_safe",
		online?: boolean,
	) => Promise<void>;
}

export const useLicenseStore = create<LicenseState>((set) => ({
	phase: "idle",
	error: null,
	report: null,
	online: null,
	scan: async (projectPath, policy, online = true) => {
		if (!projectPath) {
			set({ phase: "error", error: "projectPath is required" });
			return;
		}
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.scanLicenses(
				projectPath,
				policy,
				undefined,
				online,
			);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", report: res.report, online: res.online ?? online });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.9 Architecture Drift ----------

interface ArchDriftState extends BaseSlice {
	scanReport: ArchitectureScanReport | null;
	driftReport: DriftReport | null;
	configSource: string | null;
	/** Findings recorded by the last "save baseline", or null when none was saved this session. */
	baselineCount: number | null;
	scan: (projectPath: string) => Promise<void>;
	saveBaseline: (projectPath: string) => Promise<void>;
	compare: (projectPath: string) => Promise<void>;
}

export const useArchDriftStore = create<ArchDriftState>((set) => ({
	phase: "idle",
	error: null,
	scanReport: null,
	driftReport: null,
	configSource: null,
	baselineCount: null,
	scan: async (projectPath) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.scanArchitecture(projectPath);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", scanReport: res.report, configSource: res.config_source });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	saveBaseline: async (projectPath) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.saveArchBaseline(projectPath);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", baselineCount: res.violation_count, configSource: res.config_source });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	compare: async (projectPath) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.compareArchDrift(projectPath);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", driftReport: res.drift, configSource: res.config_source });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.10 Generational Tests ----------

export type GenSource = "run" | "report";
export type GenMode = "capture" | "compare";

interface GenTestsState extends BaseSlice {
	generations: GenerationSummary[];
	regression: RegressionReport | null;
	/** The project's test commands; null until detected. */
	commands: GenTestCommand[] | null;
	/** What the last capture or compare read: a command, or a report's format. */
	lastSource: { kind: GenSource; value: string } | null;
	running: GenMode | null;
	listGenerations: (projectPath: string) => Promise<void>;
	detect: (projectPath: string) => Promise<void>;
	capture: (projectPath: string, label: string, report: string) => Promise<boolean>;
	compare: (projectPath: string, baseline: string, report: string) => Promise<void>;
	/** Runs the project's own suite once, then captures it or compares it. */
	runSuite: (projectPath: string, mode: GenMode, label: string, commandId: string) => Promise<boolean>;
	cancel: () => Promise<void>;
	/** The report file the person picks, or null when they cancel. */
	importFile: () => Promise<{ name: string; content: string } | null>;
	deleteGen: (projectPath: string, label: string) => Promise<void>;
	reset: () => void;
}

const GEN_IDLE = {
	phase: "idle" as Phase,
	error: null,
	generations: [],
	regression: null,
	commands: null,
	lastSource: null,
	running: null,
};

export const useGenTestsStore = create<GenTestsState>((set, get) => ({
	...GEN_IDLE,
	listGenerations: async (projectPath) => {
		try {
			const res = await globalThis.electronAPI.listGenerations(projectPath);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ generations: res.details ?? [] });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	detect: async (projectPath) => {
		const res = await globalThis.electronAPI.detectGenTestCommands(projectPath);
		set({ commands: res.success ? res.commands : [] });
	},
	capture: async (projectPath, label, report) => {
		set({ phase: "running", running: "capture", error: null });
		try {
			const res = await globalThis.electronAPI.captureGeneration(projectPath, label, report);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", lastSource: { kind: "report", value: res.format } });
			await get().listGenerations(projectPath);
			return true;
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
			return false;
		} finally {
			set({ running: null });
		}
	},
	compare: async (projectPath, baseline, report) => {
		set({ phase: "running", running: "compare", error: null, regression: null });
		try {
			const res = await globalThis.electronAPI.compareGeneration(projectPath, baseline, report);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({
				phase: "ok",
				regression: res.report,
				lastSource: { kind: "report", value: res.format },
			});
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		} finally {
			set({ running: null });
		}
	},
	runSuite: async (projectPath, mode, label, commandId) => {
		set({
			phase: "running",
			running: mode,
			error: null,
			...(mode === "compare" ? { regression: null } : {}),
		});
		try {
			const res = await globalThis.electronAPI.runGenTests(projectPath, mode, label, commandId);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({
				phase: "ok",
				lastSource: { kind: "run", value: res.command },
				...(mode === "compare" ? { regression: res.report ?? null } : {}),
			});
			if (mode === "capture") await get().listGenerations(projectPath);
			return true;
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
			return false;
		} finally {
			set({ running: null });
		}
	},
	cancel: async () => {
		await globalThis.electronAPI.cancelGenTests();
	},
	importFile: async () => {
		const res = await globalThis.electronAPI.importGenTestsReport();
		if (res.success) return { name: res.name, content: res.content };
		if (res.error !== "cancelled") set({ phase: "error", error: res.error });
		return null;
	},
	deleteGen: async (projectPath, label) => {
		await globalThis.electronAPI.deleteGeneration(projectPath, label);
		await get().listGenerations(projectPath);
	},
	reset: () => set(GEN_IDLE),
}));

// ---------- #3.12 i18n Scaler ----------

interface I18nScalerState extends BaseSlice {
	report: I18nScalingReport | null;
	skeleton: I18nDict | null;
	diff: LocaleDiffData | null;
	/** Where the locales were actually read from — not always what was picked. */
	scannedDir: string | null;
	/** Set only when the picked directory was one language, not the root. */
	redirectedFrom: string | null;
	/** Catalog formats read, when the folder held another stack's catalogs rather than JSON. */
	formats: string[];
	runReport: (localesDir: string, sourceLocale?: string) => Promise<void>;
}

export const useI18nScalerStore = create<I18nScalerState>((set) => ({
	phase: "idle",
	error: null,
	report: null,
	skeleton: null,
	diff: null,
	scannedDir: null,
	redirectedFrom: null,
	formats: [],
	runReport: async (localesDir, sourceLocale) => {
		set({ phase: "running", error: null, redirectedFrom: null, formats: [] });
		try {
			const res = await globalThis.electronAPI.reportI18nFromDir(
				localesDir,
				sourceLocale,
			);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({
				phase: "ok",
				report: res.report,
				scannedDir: res.locales_dir ?? null,
				redirectedFrom: res.redirected_from ?? null,
				formats: res.layout === "catalogs" ? (res.formats ?? []) : [],
			});
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.2 Cognitive Context ----------

interface CogContextState extends BaseSlice {
	context: OptimizedContext | null;
	optimize: (
		projectPath: string,
		prompt: string,
		candidateFiles: string[],
		tokenBudget: number,
	) => Promise<void>;
}

export const useCogContextStore = create<CogContextState>((set) => ({
	phase: "idle",
	error: null,
	context: null,
	optimize: async (projectPath, prompt, candidateFiles, tokenBudget) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.optimizeContext(
				prompt,
				candidateFiles,
				tokenBudget,
				{ projectDir: projectPath },
			);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", context: res.context });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.3 Audit Trail ----------

interface AuditTrailState extends BaseSlice {
	events: AuditEvent[];
	replayEvents: AuditEvent[];
	integrity: { is_intact: boolean; events_checked: number; first_broken_sequence: number | null; breakage_reason: string | null } | null;
	loadEvents: (storageDir: string, trailName?: string) => Promise<void>;
	replay: (correlationId: string, storageDir: string, trailName?: string) => Promise<void>;
	verify: (storageDir: string, trailName?: string) => Promise<void>;
}

export const useAuditTrailStore = create<AuditTrailState>((set) => ({
	phase: "idle",
	error: null,
	events: [],
	replayEvents: [],
	integrity: null,
	loadEvents: async (storageDir, trailName) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.auditEvents({
				storageDir,
				trailName,
			});
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", events: res.events });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	replay: async (correlationId, storageDir, trailName) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.auditReplay(
				correlationId,
				storageDir,
				trailName,
			);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", replayEvents: res.bundle.events });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	verify: async (storageDir, trailName) => {
		set({ phase: "running", error: null });
		try {
			const res = await globalThis.electronAPI.auditVerify(storageDir, trailName);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", integrity: res.integrity });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
}));

// ---------- #3.5 Pair Realtime ----------

interface PairRealtimeState extends BaseSlice {
	currentRoom: PairRoomSnapshot | null;
	ops: PairOperation[];
	subscriptionId: string | null;
	isStreaming: boolean;
	createOrJoin: (
		roomId: string,
		userId: string,
		displayName: string,
		role?: "driver" | "navigator" | "ai",
	) => Promise<void>;
	leave: () => Promise<void>;
	sendChat: (text: string) => Promise<void>;
	sendEdit: (
		filePath: string,
		startLine: number,
		endLine: number,
		newText: string,
	) => Promise<void>;
	subscribe: () => Promise<void>;
	unsubscribe: () => Promise<void>;
	_appendOp: (op: PairOperation) => void;
}

export const usePairRealtimeStore = create<PairRealtimeState>((set, get) => ({
	phase: "idle",
	error: null,
	currentRoom: null,
	ops: [],
	subscriptionId: null,
	isStreaming: false,
	createOrJoin: async (roomId, userId, displayName, role) => {
		set({ phase: "running", error: null });
		try {
			// Try create; if it already exists, just join.
			await globalThis.electronAPI.createPairRoom(roomId);
			const joinRes = await globalThis.electronAPI.pairJoin(
				roomId,
				userId,
				displayName,
				role,
			);
			if (!joinRes.success) throw new Error(joinRes.error ?? "join failed");
			const snapRes = await globalThis.electronAPI.getPairRoom(roomId);
			if (!snapRes.success) throw new Error(snapRes.error ?? "snapshot failed");
			set({ phase: "ok", currentRoom: snapRes.room, ops: [] });
		} catch (e) {
			set({ phase: "error", error: errorMessage(e) });
		}
	},
	leave: async () => {
		const room = get().currentRoom;
		if (!room) return;
		await get().unsubscribe();
		set({ currentRoom: null, ops: [] });
	},
	sendChat: async (text) => {
		const room = get().currentRoom;
		if (!room) return;
		const me = room.participants[0]?.user_id ?? "anon";
		await globalThis.electronAPI.pairChat(room.room_id, me, text);
	},
	sendEdit: async (filePath, startLine, endLine, newText) => {
		const room = get().currentRoom;
		if (!room) return;
		const me = room.participants[0]?.user_id ?? "anon";
		await globalThis.electronAPI.pairEdit(
			room.room_id,
			me,
			filePath,
			startLine,
			endLine,
			newText,
		);
	},
	subscribe: async () => {
		const room = get().currentRoom;
		if (!room) return;
		const lastSeq = get().ops.length
			? get().ops[get().ops.length - 1].sequence + 1
			: 0;
		const res = await globalThis.electronAPI.subscribePairRoom(
			room.room_id,
			lastSeq,
		);
		if (!res.success) {
			set({ error: res.error ?? "subscribe failed" });
			return;
		}
		set({ subscriptionId: res.subscriptionId, isStreaming: true });
	},
	unsubscribe: async () => {
		const sid = get().subscriptionId;
		if (!sid) return;
		await globalThis.electronAPI.unsubscribePairRoom(sid);
		set({ subscriptionId: null, isStreaming: false });
	},
	_appendOp: (op) => set((s) => ({ ops: [...s.ops, op] })),
}));

// Listener helper to wire the SSE stream into the store.
export function setupPairRealtimeListeners(): () => void {
	const offEvent = globalThis.electronAPI.onPairOpEvent(({ subscriptionId, op }) => {
		const state = usePairRealtimeStore.getState();
		if (state.subscriptionId !== subscriptionId) return;
		state._appendOp(op);
	});
	const offError = globalThis.electronAPI.onPairStreamError(({ subscriptionId, error }) => {
		const state = usePairRealtimeStore.getState();
		if (state.subscriptionId !== subscriptionId) return;
		usePairRealtimeStore.setState({ error, isStreaming: false });
	});
	return () => {
		offEvent();
		offError();
	};
}

// Re-export the helpers some components might want.
export { unwrap, errorMessage };
