import { beforeEach, describe, expect, it, vi } from "vitest";
import { useI18nEditorStore } from "../i18n-editor-store";

const listI18nNamespaces = vi.fn();
const loadI18nNamespace = vi.fn();
const mutateI18n = vi.fn();

Object.defineProperty(globalThis, "electronAPI", {
	value: { listI18nNamespaces, loadI18nNamespace, mutateI18n },
	writable: true,
	configurable: true,
});

const VIEW = {
	namespace: "common",
	locales: ["en", "fr"],
	entries: [
		{
			key: "buttons.save",
			values: { en: "Save", fr: "Enregistrer" },
			placeholder_mismatch: false,
		},
		{ key: "buttons.undo", values: { en: "Undo", fr: null }, placeholder_mismatch: false },
	],
	fingerprints: { en: "sha-en", fr: "sha-fr" },
	root: "/p/locales",
};

const NAMESPACES = {
	success: true,
	locales_dir: "/p/locales",
	locales: ["en", "fr"],
	layout: "nested",
	redirected_from: null,
	namespaces: [
		{ namespace: "common", total_keys: 2, translated: { en: 2, fr: 1 }, missing: { en: 0, fr: 1 } },
	],
};

async function loadedStore() {
	listI18nNamespaces.mockResolvedValue(NAMESPACES);
	loadI18nNamespace.mockResolvedValue({ success: true, view: VIEW });
	const store = useI18nEditorStore.getState();
	await store.loadNamespaces("/p/locales", "en");
	await useI18nEditorStore.getState().selectNamespace("common");
	return useI18nEditorStore;
}

beforeEach(() => {
	vi.clearAllMocks();
	useI18nEditorStore.getState().reset();
});

describe("loading", () => {
	it("keeps the directory the backend read, not the one that was picked", async () => {
		listI18nNamespaces.mockResolvedValue({
			...NAMESPACES,
			locales_dir: "/p/locales",
			redirected_from: "/p/locales/fr",
		});
		await useI18nEditorStore.getState().loadNamespaces("/p/locales/fr", "fr");
		expect(useI18nEditorStore.getState().localesDir).toBe("/p/locales");
	});

	it("falls back to the first locale when the reference is not one of them", async () => {
		listI18nNamespaces.mockResolvedValue(NAMESPACES);
		await useI18nEditorStore.getState().loadNamespaces("/p/locales", "de");
		expect(useI18nEditorStore.getState().referenceLocale).toBe("en");
	});

	it("surfaces a backend refusal instead of an empty editor", async () => {
		listI18nNamespaces.mockResolvedValue({ success: false, error: "No locales here." });
		await useI18nEditorStore.getState().loadNamespaces("/p/nope");
		const s = useI18nEditorStore.getState();
		expect(s.phase).toBe("error");
		expect(s.error).toBe("No locales here.");
	});

	it("drops the draft when another namespace is opened", async () => {
		const store = await loadedStore();
		store.getState().setValue("buttons.save", "fr", "Sauver");
		expect(Object.keys(store.getState().draft.edits)).toHaveLength(1);
		await store.getState().selectNamespace("other");
		expect(store.getState().draft.edits).toEqual({});
	});
});

describe("save", () => {
	it("sends the operations the draft implies, with the loaded fingerprints", async () => {
		const store = await loadedStore();
		mutateI18n.mockResolvedValue({
			success: true,
			namespace: "common",
			written: ["/p/locales/fr/common.json"],
			fingerprints: { en: "sha-en", fr: "sha-fr2" },
		});

		store.getState().setValue("buttons.save", "fr", "Sauver");
		store.getState().addKey("buttons.redo", { en: "Redo" });
		store.getState().deleteKey("buttons.undo");
		await store.getState().save();

		expect(mutateI18n).toHaveBeenCalledWith(
			"/p/locales",
			"common",
			[
				{ op: "delete", key: "buttons.undo" },
				{ op: "add", key: "buttons.redo", values: { en: "Redo" } },
				{ op: "set", key: "buttons.save", values: { fr: "Sauver" } },
			],
			{ en: "sha-en", fr: "sha-fr" },
		);
	});

	it("does nothing when there is nothing to save", async () => {
		const store = await loadedStore();
		await store.getState().save();
		expect(mutateI18n).not.toHaveBeenCalled();
	});

	it("clears the draft and re-reads the namespace on success", async () => {
		const store = await loadedStore();
		mutateI18n.mockResolvedValue({
			success: true,
			namespace: "common",
			written: ["/p/locales/fr/common.json"],
			fingerprints: {},
		});
		store.getState().setValue("buttons.save", "fr", "Sauver");
		loadI18nNamespace.mockClear();

		await store.getState().save();

		const s = store.getState();
		expect(s.draft.edits).toEqual({});
		expect(s.lastSave?.written).toEqual(["/p/locales/fr/common.json"]);
		// Fresh fingerprints for the next save, and the keys the save created.
		expect(loadI18nNamespace).toHaveBeenCalled();
	});

	it("keeps the draft when the save is refused", async () => {
		// The draft is the user's work. Losing it on a failure is the one thing
		// that makes an editor untrustworthy.
		const store = await loadedStore();
		mutateI18n.mockResolvedValue({ success: false, error: "'a..b' is not usable." });
		store.getState().setValue("buttons.save", "fr", "Sauver");

		await store.getState().save();

		const s = store.getState();
		expect(s.phase).toBe("error");
		expect(s.error).toContain("not usable");
		expect(s.draft.edits["buttons.save"]).toEqual({ fr: "Sauver" });
	});

	it("flags a stale save separately so the panel can offer the reload", async () => {
		const store = await loadedStore();
		mutateI18n.mockResolvedValue({
			success: false,
			error: "common.json changed on disk.",
			stale: true,
		});
		store.getState().setValue("buttons.save", "fr", "Sauver");

		await store.getState().save();

		expect(store.getState().stale).toBe(true);
		expect(store.getState().draft.edits["buttons.save"]).toEqual({ fr: "Sauver" });
	});
});

describe("reloadKeepingDraft", () => {
	it("re-reads the file and leaves the draft in place to replay", async () => {
		const store = await loadedStore();
		store.getState().setValue("buttons.save", "fr", "Sauver");
		useI18nEditorStore.setState({ stale: true });

		loadI18nNamespace.mockResolvedValue({
			success: true,
			view: { ...VIEW, fingerprints: { en: "new-en", fr: "new-fr" } },
		});
		await store.getState().reloadKeepingDraft();

		const s = store.getState();
		expect(s.stale).toBe(false);
		expect(s.view?.fingerprints).toEqual({ en: "new-en", fr: "new-fr" });
		expect(s.draft.edits["buttons.save"]).toEqual({ fr: "Sauver" });
	});
});
