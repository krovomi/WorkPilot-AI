import { create } from "zustand";
import type {
	GuardrailActivity,
	GuardrailDiffCheck,
	GuardrailPolicyReport,
	GuardrailRuleDoc,
	GuardrailsDoc,
	GuardrailTestResult,
} from "../../preload/api/modules/guardrails-api";

interface GuardrailsState {
	doc: GuardrailsDoc;
	dirty: boolean;
	loading: boolean;
	error: string | null;
	lastTest: GuardrailTestResult | null;
	/** The file could not be read: saving would replace the person's rules. */
	loadFailed: boolean;
	policy: GuardrailPolicyReport | null;
	activity: GuardrailActivity | null;
	diffCheck: GuardrailDiffCheck | null;
	checking: boolean;

	load: (projectPath: string) => Promise<void>;
	/** What the backend reads (layers, errors) and what the rules did. */
	refreshInsights: (projectPath: string) => Promise<void>;
	answer: (projectPath: string, requestId: string, approve: boolean) => Promise<void>;
	checkDiff: (projectPath: string, ref?: string) => Promise<void>;
	save: (projectPath: string) => Promise<void>;
	addRule: () => void;
	updateRule: (index: number, patch: Partial<GuardrailRuleDoc>) => void;
	deleteRule: (index: number) => void;
	runTest: (
		projectPath: string,
		toolName: string,
		toolInput: Record<string, unknown>,
	) => Promise<void>;
	reset: () => void;
}

/** Two rules added in the same millisecond still need two ids. */
let lastRule = 0;
const emptyRule = (): GuardrailRuleDoc => ({
	id: `rule-${Date.now()}-${++lastRule}`,
	description: "",
	action: "warn",
	when: { tool: ["Write", "Edit"] },
});

/**
 * The project the page is on, and the project whose rules `doc` holds. They
 * differ while another project's rules load: answers for a project left
 * behind are dropped, and a save never writes one project's rules into
 * another's file.
 */
let shownPath: string | null = null;
let loadedPath: string | null = null;
const isShown = (projectPath: string) => projectPath === shownPath;

export const useGuardrailsStore = create<GuardrailsState>((set, get) => ({
	doc: { version: 1, rules: [] },
	dirty: false,
	loading: false,
	error: null,
	lastTest: null,
	loadFailed: false,
	policy: null,
	activity: null,
	diffCheck: null,
	checking: false,

	load: async (projectPath) => {
		shownPath = projectPath;
		set({ loading: true, error: null, loadFailed: false, diffCheck: null });
		// Another project: the last one's rules and results are not its own.
		if (projectPath !== loadedPath) {
			set({ doc: { version: 1, rules: [] }, dirty: false, lastTest: null, policy: null, activity: null });
		}
		try {
			const doc = await globalThis.electronAPI.loadGuardrails(projectPath);
			if (!isShown(projectPath)) return;
			loadedPath = projectPath;
			// A reply without a rules array (an older main, a preview) is an
			// empty document, never a page that cannot render.
			const rules = Array.isArray(doc?.rules) ? doc.rules : [];
			set({
				doc: { version: doc?.version ?? 1, rules: rules.map((r) => ({ ...r, when: r.when ?? {} })) },
				dirty: false,
				loading: false,
			});
		} catch (e) {
			if (!isShown(projectPath)) return;
			set({ error: String(e), loading: false, loadFailed: true });
		}
		void get().refreshInsights(projectPath);
	},

	save: async (projectPath) => {
		if (get().loadFailed || loadedPath !== projectPath) return;
		set({ loading: true, error: null });
		try {
			await globalThis.electronAPI.saveGuardrails(projectPath, get().doc);
			set({ dirty: false, loading: false });
		} catch (e) {
			set({ error: String(e), loading: false });
		}
		void get().refreshInsights(projectPath);
	},

	refreshInsights: async (projectPath) => {
		const [policy, activity] = await Promise.allSettled([
			globalThis.electronAPI.validateGuardrails(projectPath),
			globalThis.electronAPI.getGuardrailActivity(projectPath),
		]);
		if (!isShown(projectPath)) return;
		set({
			policy: policy.status === "fulfilled" ? policy.value : null,
			activity: activity.status === "fulfilled" ? activity.value : null,
		});
	},

	answer: async (projectPath, requestId, approve) => {
		try {
			await globalThis.electronAPI.answerGuardrailRequest(projectPath, requestId, approve);
		} catch (e) {
			set({ error: String(e) });
		}
		await get().refreshInsights(projectPath);
	},

	checkDiff: async (projectPath, ref) => {
		set({ checking: true, error: null });
		try {
			const diffCheck = await globalThis.electronAPI.checkGuardrailsDiff(projectPath, ref);
			if (isShown(projectPath)) set({ diffCheck, checking: false });
		} catch (e) {
			if (isShown(projectPath)) set({ error: String(e), checking: false });
		}
	},

	addRule: () =>
		set((s) => ({
			doc: { ...s.doc, rules: [...s.doc.rules, emptyRule()] },
			dirty: true,
		})),

	updateRule: (index, patch) =>
		set((s) => ({
			doc: {
				...s.doc,
				rules: s.doc.rules.map((r, i) =>
					i === index ? { ...r, ...patch, when: { ...r.when, ...(patch.when ?? {}) } } : r,
				),
			},
			dirty: true,
		})),

	deleteRule: (index) =>
		set((s) => ({
			doc: {
				...s.doc,
				rules: s.doc.rules.filter((_, i) => i !== index),
			},
			dirty: true,
		})),

	runTest: async (projectPath, toolName, toolInput) => {
		try {
			const lastTest = await globalThis.electronAPI.testGuardrails(
				projectPath,
				toolName,
				toolInput,
			);
			if (isShown(projectPath)) set({ lastTest });
		} catch (e) {
			if (isShown(projectPath)) set({ error: String(e) });
		}
	},

	reset: () => set({ lastTest: null, error: null }),
}));
