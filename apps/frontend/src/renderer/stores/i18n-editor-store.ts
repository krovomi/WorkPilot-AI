/**
 * The translation editor's state.
 *
 * Separate from `phase35-stores.ts` because this one is not the shape the
 * twelve panels share (`phase + error + result`): it holds a *document* being
 * edited, an unsaved draft on top of it, and the fingerprints that let a save
 * refuse to clobber. The rules of that draft live in
 * `components/phase35/i18n-editor/drafts.ts`, without React, and this store
 * only sequences the calls around them.
 */

import { create } from "zustand";
import type {
	I18nLocaleRoot,
	I18nNamespaceSummary,
	I18nNamespaceView,
} from "../../preload/api/modules/phase35-features-api";
import {
	addKey as addKeyToDraft,
	countChanges,
	deleteKey as deleteKeyFromDraft,
	type Draft,
	emptyDraft,
	renameKey as renameKeyInDraft,
	restoreKey as restoreKeyInDraft,
	revertValue as revertValueInDraft,
	setValue as setValueInDraft,
	buildOperations,
} from "../components/phase35/i18n-editor/drafts";

type Phase = "idle" | "loading" | "loadingNamespace" | "saving" | "ok" | "error";

interface SaveOutcome {
	/** File paths the save actually rewrote. Empty when nothing differed. */
	written: string[];
	at: number;
}

interface I18nEditorState {
	phase: Phase;
	error: string | null;
	/**
	 * Set when a save was refused because the files moved under us. It is a
	 * separate flag from `error` because it has its own remedy — reload and
	 * replay — and the panel offers that instead of an error nobody can act on.
	 */
	stale: boolean;

	/**
	 * Translation directories found in the open project. The panel offers them
	 * so the common case is one click instead of a walk through a native
	 * folder dialog down to `apps/frontend/src/shared/i18n/locales`.
	 */
	detectedRoots: I18nLocaleRoot[];
	detecting: boolean;

	localesDir: string | null;
	locales: string[];
	layout: "nested" | "flat" | "none";
	namespaces: I18nNamespaceSummary[];

	selectedNamespace: string | null;
	view: I18nNamespaceView | null;
	draft: Draft;
	referenceLocale: string;
	lastSave: SaveOutcome | null;

	detectRoots: (projectPath: string) => Promise<void>;
	loadNamespaces: (localesDir: string, referenceLocale?: string) => Promise<void>;
	selectNamespace: (namespace: string) => Promise<void>;

	setValue: (originalKey: string, locale: string, value: string) => void;
	revertValue: (originalKey: string, locale: string) => void;
	addKey: (key: string, values: Record<string, string>) => void;
	deleteKey: (originalKey: string) => void;
	restoreKey: (originalKey: string) => void;
	renameKey: (originalKey: string, newKey: string) => void;
	discard: () => void;

	save: () => Promise<void>;
	/** Re-read the namespace from disk and keep the draft on top of it. */
	reloadKeepingDraft: () => Promise<void>;
	/** Refresh the sidebar counts without putting the panel back into loading. */
	loadSummariesQuietly: () => Promise<void>;
	reset: () => void;
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

const INITIAL = {
	phase: "idle" as Phase,
	error: null,
	stale: false,
	detectedRoots: [] as I18nLocaleRoot[],
	detecting: false,
	localesDir: null,
	locales: [] as string[],
	layout: "none" as const,
	namespaces: [] as I18nNamespaceSummary[],
	selectedNamespace: null,
	view: null,
	draft: emptyDraft(),
	referenceLocale: "en",
	lastSave: null,
};

export const useI18nEditorStore = create<I18nEditorState>((set, get) => ({
	...INITIAL,

	detectRoots: async (projectPath) => {
		if (!projectPath) return;
		set({ detecting: true });
		try {
			const res = await globalThis.electronAPI.detectI18nRoots(projectPath);
			set({ detecting: false, detectedRoots: res.success ? res.roots : [] });
		} catch {
			// Detection is a convenience on top of the picker, never a blocker.
			set({ detecting: false, detectedRoots: [] });
		}
	},

	loadNamespaces: async (localesDir, referenceLocale) => {
		set({ phase: "loading", error: null, stale: false });
		try {
			const res = await globalThis.electronAPI.listI18nNamespaces(localesDir);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			const locales = res.locales ?? [];
			set({
				phase: "ok",
				// The directory the backend actually read, which is not always the
				// one that was picked — see `discover_locales`.
				localesDir: res.locales_dir ?? localesDir,
				locales,
				layout: res.layout ?? "none",
				namespaces: res.namespaces ?? [],
				referenceLocale:
					referenceLocale && locales.includes(referenceLocale)
						? referenceLocale
						: (locales[0] ?? "en"),
				selectedNamespace: null,
				view: null,
				draft: emptyDraft(),
				lastSave: null,
			});
		} catch (e) {
			set({ phase: "error", error: message(e) });
		}
	},

	selectNamespace: async (namespace) => {
		const { localesDir, referenceLocale } = get();
		if (!localesDir) return;
		set({
			phase: "loadingNamespace",
			error: null,
			stale: false,
			selectedNamespace: namespace,
			// A draft belongs to the namespace it was typed in. Carrying it across
			// would save edits against keys that live in another file.
			draft: emptyDraft(),
			lastSave: null,
		});
		try {
			const res = await globalThis.electronAPI.loadI18nNamespace(
				localesDir,
				namespace,
				referenceLocale,
			);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			set({ phase: "ok", view: res.view });
		} catch (e) {
			set({ phase: "error", error: message(e), view: null });
		}
	},

	setValue: (originalKey, locale, value) =>
		set((s) => ({ draft: setValueInDraft(s.draft, originalKey, locale, value) })),
	revertValue: (originalKey, locale) =>
		set((s) => ({ draft: revertValueInDraft(s.draft, originalKey, locale) })),
	addKey: (key, values) =>
		set((s) => ({ draft: addKeyToDraft(s.draft, key, values) })),
	deleteKey: (originalKey) =>
		set((s) => ({ draft: deleteKeyFromDraft(s.draft, originalKey) })),
	restoreKey: (originalKey) =>
		set((s) => ({ draft: restoreKeyInDraft(s.draft, originalKey) })),
	renameKey: (originalKey, newKey) =>
		set((s) => ({ draft: renameKeyInDraft(s.draft, originalKey, newKey) })),
	discard: () => set({ draft: emptyDraft(), stale: false, error: null }),

	save: async () => {
		const { localesDir, selectedNamespace, view, draft } = get();
		if (!localesDir || selectedNamespace === null || !view) return;
		const operations = buildOperations(draft);
		if (!operations.length) return;

		set({ phase: "saving", error: null, stale: false });
		try {
			const res = await globalThis.electronAPI.mutateI18n(
				localesDir,
				selectedNamespace,
				operations,
				view.fingerprints,
			);
			if (!res.success) {
				// The draft is deliberately kept on every failure. It is the user's
				// work, and a stale save in particular is recoverable — the panel
				// reloads and replays it rather than asking them to retype.
				set({
					phase: "error",
					error: res.error ?? "Backend error",
					stale: Boolean(res.stale),
				});
				return;
			}
			set({
				phase: "ok",
				draft: emptyDraft(),
				lastSave: { written: res.written ?? [], at: Date.now() },
			});
			// Re-read so the table shows what is on disk, including the keys the
			// save created, and so the next save carries fresh fingerprints.
			const reloaded = await globalThis.electronAPI.loadI18nNamespace(
				localesDir,
				selectedNamespace,
				get().referenceLocale,
			);
			if (reloaded.success) set({ view: reloaded.view });
			void get().loadSummariesQuietly();
		} catch (e) {
			set({ phase: "error", error: message(e) });
		}
	},

	reloadKeepingDraft: async () => {
		const { localesDir, selectedNamespace, referenceLocale } = get();
		if (!localesDir || selectedNamespace === null) return;
		set({ phase: "loadingNamespace", error: null, stale: false });
		try {
			const res = await globalThis.electronAPI.loadI18nNamespace(
				localesDir,
				selectedNamespace,
				referenceLocale,
			);
			if (!res.success) throw new Error(res.error ?? "Backend error");
			// `draft` is untouched: it is keyed by the key names, so it re-applies
			// cleanly on top of whatever the file now holds.
			set({ phase: "ok", view: res.view });
		} catch (e) {
			set({ phase: "error", error: message(e) });
		}
	},

	reset: () => set({ ...INITIAL, draft: emptyDraft() }),

	// Refresh the sidebar counts after a save without flashing the whole panel
	// into a loading state — the numbers are secondary to what is on screen.
	loadSummariesQuietly: async () => {
		const { localesDir } = get();
		if (!localesDir) return;
		try {
			const res = await globalThis.electronAPI.listI18nNamespaces(localesDir);
			if (res.success) set({ namespaces: res.namespaces ?? [] });
		} catch {
			/* the counts are stale for a moment; the editor still works */
		}
	},
}));

/** How many unsaved changes the draft holds. Re-exported so components need one import. */
export function pendingChangeCount(draft: Draft): number {
	return countChanges(draft);
}
