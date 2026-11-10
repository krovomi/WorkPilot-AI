import { create } from "zustand";
import type {
	BranchDeletion,
	BranchListing,
	RewritePlan,
	RewriteResult,
	RewriteStep,
	SurgeonMonth,
} from "../../shared/types/git-surgeon";

export type RewritePhase = "idle" | "planning" | "ready" | "applying" | "done" | "error";

interface GitRewriteState {
	phase: RewritePhase;
	plan: RewritePlan | null;
	steps: RewriteStep[];
	result: RewriteResult | null;
	error: string | null;
	base: string;
	ai: boolean;
	branches: BranchListing | null;
	deletion: BranchDeletion | null;
	branchesBusy: boolean;
	months: SurgeonMonth[];

	setBase: (base: string) => void;
	setAi: (ai: boolean) => void;
	makePlan: (projectPath: string) => Promise<void>;
	setMessage: (id: string, message: string) => void;
	keepAsIs: (id: string) => void;
	restore: () => void;
	apply: (projectPath: string) => Promise<void>;
	loadBranches: (projectPath: string) => Promise<void>;
	deleteBranches: (projectPath: string, names: string[]) => Promise<void>;
	loadHistory: (projectPath: string) => Promise<void>;
	reset: () => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The steps with step `id` put back as the commits it came from: a squash
 * gives back each commit, a split its one commit, a reword the old message.
 */
export function undoStep(steps: RewriteStep[], plan: RewritePlan, id: string): RewriteStep[] {
	const index = steps.findIndex((s) => s.id === id);
	if (index < 0) return steps;
	const step = steps[index];
	const original = (sha: string) => {
		return plan.commits.find((c) => c.sha === sha)?.message ?? "";
	};
	const keep = (sha: string, n: number): RewriteStep => ({
		id: `${id}-k${n}`,
		kind: "keep",
		sources: [sha],
		message: original(sha),
		reason: "",
		paths: [],
		author: step.author,
	});
	if (step.kind === "split") {
		const group = steps.filter((s) => s.kind === "split" && s.sources[0] === step.sources[0]);
		const first = steps.indexOf(group[0]);
		return [...steps.slice(0, first), keep(step.sources[0], 0), ...steps.slice(first + group.length)];
	}
	return [...steps.slice(0, index), ...step.sources.map((sha, n) => keep(sha, n)), ...steps.slice(index + 1)];
}

export const useGitRewriteStore = create<GitRewriteState>((set, get) => ({
	phase: "idle",
	plan: null,
	steps: [],
	result: null,
	error: null,
	base: "",
	ai: false,
	branches: null,
	deletion: null,
	branchesBusy: false,
	months: [],

	setBase: (base) => set({ base }),
	setAi: (ai) => set({ ai }),

	makePlan: async (projectPath) => {
		set({ phase: "planning", error: null, result: null });
		try {
			const plan = await globalThis.electronAPI.planGitRewrite({
				projectPath,
				base: get().base.trim() || undefined,
				ai: get().ai,
			});
			set({ phase: "ready", plan, steps: plan.plan });
		} catch (err) {
			set({ phase: "error", error: message(err) });
		}
	},

	setMessage: (id, text) => set({ steps: get().steps.map((s) => (s.id === id ? { ...s, message: text } : s)) }),

	keepAsIs: (id) => {
		const plan = get().plan;
		if (plan) set({ steps: undoStep(get().steps, plan, id) });
	},

	restore: () => set({ steps: get().plan?.plan ?? [] }),

	apply: async (projectPath) => {
		const plan = get().plan;
		if (!plan) return;
		set({ phase: "applying", error: null });
		try {
			const result = await globalThis.electronAPI.applyGitRewrite({
				projectPath,
				plan: {
					base: plan.base,
					head: plan.head,
					plan: get().steps.map((s) => ({ kind: s.kind, sources: s.sources, message: s.message, paths: s.paths })),
				},
			});
			set({ phase: "done", result });
			void get().loadBranches(projectPath);
			void get().loadHistory(projectPath);
		} catch (err) {
			set({ phase: "ready", error: message(err) });
		}
	},

	loadBranches: async (projectPath) => {
		set({ branchesBusy: true });
		try {
			set({ branches: await globalThis.electronAPI.listGitBranches({ projectPath }) });
		} catch (err) {
			set({ error: message(err) });
		} finally {
			set({ branchesBusy: false });
		}
	},

	deleteBranches: async (projectPath, names) => {
		set({ branchesBusy: true, deletion: null });
		try {
			set({ deletion: await globalThis.electronAPI.deleteMergedBranches({ projectPath, names }) });
		} catch (err) {
			set({ error: message(err) });
		} finally {
			set({ branchesBusy: false });
		}
		await get().loadBranches(projectPath);
	},

	loadHistory: async (projectPath) => {
		try {
			set({ months: (await globalThis.electronAPI.gitSurgeonHistory({ projectPath })).months });
		} catch {
			set({ months: [] });
		}
	},

	reset: () => set({ phase: "idle", plan: null, steps: [], result: null, error: null }),
}));
