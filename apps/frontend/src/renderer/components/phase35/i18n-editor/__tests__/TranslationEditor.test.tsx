/** @vitest-environment jsdom */
/**
 * The translation editor on a real store: pick a namespace, edit, add,
 * rename and delete keys, then save — or take any of it back first.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { I18nEntry } from "../../../../../preload/api/modules/phase35-features-api";
import { useI18nEditorStore } from "../../../../stores/i18n-editor-store";
import { type Api, deferred, openWorld } from "../../__tests__/phase35-world";
import { TranslationEditor } from "../TranslationEditor";

const NAMESPACES = [
	{ namespace: "common", total_keys: 4, translated: { en: 4, fr: 2 }, missing: { fr: 1 } },
	{ namespace: "alpha", total_keys: 2, translated: { en: 2, fr: 2 }, missing: {} },
	{ namespace: "", total_keys: 0, translated: {}, missing: {} },
	// No count for fr at all: none of its keys is translated there.
	{ namespace: "beta", total_keys: 2, translated: { en: 2 }, missing: {} },
];

const ENTRIES: I18nEntry[] = [
	{ key: "buttons.save", values: { en: "Save", fr: "Enregistrer" }, placeholder_mismatch: false },
	{ key: "buttons.undo", values: { en: "Undo", fr: null }, placeholder_mismatch: false },
	{ key: "items", values: { en: "{{count}} items", fr: "{{n}} éléments" }, placeholder_mismatch: true },
	{ key: "todo", values: { en: "Later", fr: "[FR] Later" }, placeholder_mismatch: false },
];

const view = (entries = ENTRIES) => ({
	success: true,
	view: { namespace: "common", locales: ["en", "fr"], entries, fingerprints: { en: "1", fr: "2" }, root: "/l" },
});

let api: Api;
beforeEach(async () => {
	api = await openWorld({
		listI18nNamespaces: async () => ({ success: true, locales: ["en", "fr"], layout: "nested", namespaces: NAMESPACES }),
		loadI18nNamespace: async () => view(),
		mutateI18n: async () => ({ success: true, namespace: "common", written: ["/l/fr/common.json"], fingerprints: {} }),
	});
	await useI18nEditorStore.getState().loadNamespaces("/l", "en");
});
afterEach(cleanup);

async function openCommon() {
	render(<TranslationEditor />);
	fireEvent.click(screen.getByRole("button", { name: /^common/ }));
	return screen.findByText("buttons.save");
}

const names = () =>
	within(screen.getByRole("list"))
		.getAllByRole("button")
		.map((b) => b.textContent);

describe("NamespaceList", () => {
	it("lists the namespaces with the most work first, then by name, and filters them", () => {
		render(<TranslationEditor />);
		expect(screen.getByText("Pick a namespace on the left to start editing.")).toBeInTheDocument();
		expect(names()).toEqual(["common1", "beta", "(single file)", "alpha"]);
		expect(screen.getAllByLabelText("Complete")).toHaveLength(3);
		expect(screen.getByRole("img", { name: "75% translated" })).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "50% translated" })).toBeInTheDocument();
		expect(screen.getAllByRole("img", { name: "100% translated" })).toHaveLength(2);
		fireEvent.click(screen.getByRole("button", { name: "A → Z" }));
		expect(names()).toEqual(["(single file)", "alpha", "beta", "common1"]);
		fireEvent.change(screen.getByLabelText("Filter namespaces"), { target: { value: " ALP " } });
		expect(names()).toEqual(["alpha"]);
		fireEvent.change(screen.getByLabelText("Filter namespaces"), { target: { value: "zzz" } });
		expect(screen.getByText("No namespace matches")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "To do first" }));
	});

	it("counts a namespace of a directory without locales as done", () => {
		act(() => useI18nEditorStore.setState({ locales: [] }));
		render(<TranslationEditor />);
		expect(screen.getAllByRole("img", { name: "100% translated" }).length).toBeGreaterThan(0);
	});
});

describe("TranslationEditor", () => {
	it("opens a namespace: reference locale, missing values, and the variables that differ", async () => {
		const answer = deferred<unknown>();
		api.loadI18nNamespace.mockReturnValueOnce(answer.promise);
		render(<TranslationEditor />);
		fireEvent.click(screen.getByRole("button", { name: /^common/ }));
		expect(screen.getByText("Loading…")).toBeInTheDocument();
		await act(async () => answer.resolve(view()));
		expect(api.loadI18nNamespace).toHaveBeenCalledWith("/l", "common", "en");
		expect(screen.getByRole("button", { name: /^common/ })).toHaveAttribute("aria-current", "true");
		expect(screen.getByText("(reference)")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add the fr translation of buttons.undo" })).toBeInTheDocument();
		expect(screen.getByTitle("The reference uses: count")).toBeInTheDocument();
		expect(screen.getByLabelText("fr value of items")).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});

	it("filters the keys by what is missing, untranslated or mismatched, and by text", async () => {
		await openCommon();
		const filter = (name: RegExp) => screen.getByRole("button", { name });
		expect(filter(/^All4$/)).toBeInTheDocument();
		fireEvent.click(filter(/^Missing1$/));
		expect(screen.queryByText("buttons.save")).not.toBeInTheDocument();
		expect(screen.getByText("buttons.undo")).toBeInTheDocument();
		fireEvent.click(filter(/^Untranslated1$/));
		expect(screen.getByText("todo")).toBeInTheDocument();
		fireEvent.click(filter(/^Variables1$/));
		expect(screen.getByText("items")).toBeInTheDocument();
		fireEvent.click(filter(/^All4$/));
		fireEvent.change(screen.getByLabelText("Search keys and values"), { target: { value: "enregistrer" } });
		expect(screen.getByText("buttons.save")).toBeInTheDocument();
		expect(screen.queryByText("todo")).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Search keys and values"), { target: { value: "UNDO" } });
		expect(screen.getByText("buttons.undo")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Search keys and values"), { target: { value: "nothing like it" } });
		expect(screen.getByText("No key matches")).toBeInTheDocument();
	});

	it("disables a filter that can only show nothing", async () => {
		api.loadI18nNamespace.mockResolvedValueOnce(view([ENTRIES[0]]));
		await openCommon();
		expect(screen.getByRole("button", { name: /^Missing0$/ })).toBeDisabled();
	});

	it("fills a missing value, and reverting it shows it missing again", async () => {
		await openCommon();
		fireEvent.click(screen.getByRole("button", { name: "Add the fr translation of buttons.undo" }));
		const cell = screen.getByLabelText("fr value of buttons.undo");
		expect(cell).toHaveFocus();
		fireEvent.change(cell, { target: { value: "Annuler" } });
		expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Revert this value" }));
		// It used to stay an empty box, which reads like a deliberate blank.
		expect(screen.getByRole("button", { name: "Add the fr translation of buttons.undo" })).toBeInTheDocument();
		expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
	});

	it("puts an edited value back with Escape, and leaves an unchanged one alone", async () => {
		await openCommon();
		const cell = screen.getByLabelText("fr value of buttons.save");
		fireEvent.keyDown(cell, { key: "Escape" });
		fireEvent.change(cell, { target: { value: "Sauver" } });
		fireEvent.keyDown(cell, { key: "a" });
		expect(cell).toHaveValue("Sauver");
		fireEvent.keyDown(cell, { key: "Escape" });
		expect(cell).toHaveValue("Enregistrer");
	});

	it("saves the edits with Ctrl+S, then says how many files were written", async () => {
		await openCommon();
		fireEvent.keyDown(globalThis.window, { key: "s", ctrlKey: true });
		expect(api.mutateI18n).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("fr value of buttons.save"), { target: { value: "Sauver" } });
		fireEvent.keyDown(globalThis.window, { key: "x", metaKey: true });
		fireEvent.keyDown(globalThis.window, { key: "S", metaKey: true });
		await waitFor(() =>
			expect(api.mutateI18n).toHaveBeenCalledWith(
				"/l",
				"common",
				[{ op: "set", key: "buttons.save", values: { fr: "Sauver" } }],
				{ en: "1", fr: "2" },
			),
		);
		expect(await screen.findByText("Saved — 1 file written")).toBeInTheDocument();
	});

	it("saves with the button, and says when the files already matched", async () => {
		const answer = deferred<unknown>();
		api.mutateI18n.mockReturnValueOnce(answer.promise);
		await openCommon();
		fireEvent.change(screen.getByLabelText("fr value of buttons.save"), { target: { value: "Sauver" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		expect(screen.getByLabelText("fr value of buttons.save")).toBeDisabled();
		await act(async () => answer.resolve({ success: true, namespace: "common", written: [], fingerprints: {} }));
		expect(await screen.findByText("Saved — the files already matched")).toBeInTheDocument();
	});

	it("keeps the edits when the files moved, and reloads under them", async () => {
		api.mutateI18n.mockResolvedValueOnce({ success: false, error: "stale", stale: true });
		await openCommon();
		fireEvent.change(screen.getByLabelText("fr value of buttons.save"), { target: { value: "Sauver" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText(/These files changed on disk/)).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reload, keep my edits" }));
		await waitFor(() => expect(screen.queryByText(/These files changed on disk/)).not.toBeInTheDocument());
		expect(screen.getByLabelText("fr value of buttons.save")).toHaveValue("Sauver");
	});

	it("shows a refused save in the app's words, and Discard drops the edits", async () => {
		api.mutateI18n.mockResolvedValueOnce({ success: false, error: "permission denied" });
		await openCommon();
		fireEvent.change(screen.getByLabelText("fr value of buttons.save"), { target: { value: "Sauver" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Access denied. Check directory permissions.");
		fireEvent.click(screen.getByRole("button", { name: "Discard" }));
		expect(screen.getByLabelText("fr value of buttons.save")).toHaveValue("Enregistrer");
		expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument();
	});

	it("deletes a key, keeps it on screen struck through, and restores it", async () => {
		await openCommon();
		const row = screen.getByText("todo").closest("tr") as HTMLElement;
		fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
		expect(screen.getByText("Will be deleted from every locale when you save")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Search keys and values"), { target: { value: "nothing like it" } });
		expect(screen.queryByText("No key matches")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Restore" }));
		expect(screen.queryByText("Will be deleted from every locale when you save")).not.toBeInTheDocument();
	});

	it("renames a key, and says why a name cannot be used instead of dropping it", async () => {
		await openCommon();
		const row = () => screen.getByText("buttons.save").closest("tr") as HTMLElement;
		fireEvent.click(within(row()).getByRole("button", { name: "Rename" }));
		const box = screen.getByRole("textbox", { name: "Rename" });
		expect(box).toHaveValue("buttons.save");
		fireEvent.change(box, { target: { value: "buttons..save" } });
		fireEvent.keyDown(box, { key: "Enter" });
		expect(screen.getByText(/Segments are separated by single dots/)).toBeInTheDocument();
		expect(box).toHaveAttribute("aria-invalid", "true");
		fireEvent.change(box, { target: { value: "todo" } });
		fireEvent.keyDown(box, { key: "Enter" });
		expect(screen.getByText("This key already exists in this namespace.")).toBeInTheDocument();
		fireEvent.change(box, { target: { value: "buttons.store" } });
		fireEvent.keyDown(box, { key: "a" });
		fireEvent.keyDown(box, { key: "Enter" });
		expect(screen.getByText("buttons.store")).toBeInTheDocument();
		expect(screen.getByTitle("Renamed from buttons.save")).toBeInTheDocument();
		expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
	});

	it("keeps a valid name when the box is left, drops an invalid one, and Escape cancels", async () => {
		await openCommon();
		const rename = (key: string) =>
			fireEvent.click(within(screen.getByText(key).closest("tr") as HTMLElement).getByRole("button", { name: "Rename" }));
		rename("todo");
		fireEvent.change(screen.getByRole("textbox", { name: "Rename" }), { target: { value: " " } });
		expect(screen.getByText("A key cannot be empty.")).toBeInTheDocument();
		fireEvent.blur(screen.getByRole("textbox", { name: "Rename" }));
		expect(screen.getByText("todo")).toBeInTheDocument();
		rename("todo");
		fireEvent.change(screen.getByRole("textbox", { name: "Rename" }), { target: { value: "later" } });
		fireEvent.blur(screen.getByRole("textbox", { name: "Rename" }));
		expect(screen.getByText("later")).toBeInTheDocument();
		rename("later");
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename" }), { key: "Escape" });
		expect(screen.queryByRole("textbox", { name: "Rename" })).not.toBeInTheDocument();
	});

	it("adds a key, checking its name, and leaves a blank locale untranslated", async () => {
		await openCommon();
		fireEvent.click(screen.getByRole("button", { name: "Add key" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("It will be created in common, in every locale you fill in.")).toBeInTheDocument();
		const key = within(dialog).getByLabelText("Key");
		const add = within(dialog).getByRole("button", { name: "Add" });
		expect(add).toBeDisabled();
		fireEvent.change(key, { target: { value: ".bad" } });
		expect(within(dialog).getByText(/Segments are separated/)).toBeInTheDocument();
		fireEvent.change(key, { target: { value: "todo" } });
		expect(within(dialog).getByText("This key already exists in this namespace.")).toBeInTheDocument();
		fireEvent.change(key, { target: { value: "buttons" } });
		expect(within(dialog).getByText("buttons.save already holds a value at that path.")).toBeInTheDocument();
		fireEvent.change(key, { target: { value: "todo.later" } });
		expect(within(dialog).getByText("todo already holds a value at that path.")).toBeInTheDocument();
		fireEvent.keyDown(key, { key: "Enter" });
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		fireEvent.change(key, { target: { value: "menu.open" } });
		fireEvent.change(within(dialog).getByLabelText(/^en/), { target: { value: "Open {{name}}" } });
		fireEvent.change(within(dialog).getByLabelText(/^fr/), { target: { value: "  " } });
		fireEvent.keyDown(key, { key: "a" });
		fireEvent.keyDown(key, { key: "Enter" });
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(screen.getByText("menu.open")).toBeInTheDocument();
		expect(screen.getByText("new")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add the fr translation of menu.open" })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(api.mutateI18n).toHaveBeenCalledWith(
				"/l",
				"common",
				[{ op: "add", key: "menu.open", values: { en: "Open {{name}}" } }],
				{ en: "1", fr: "2" },
			),
		);
	});

	it("closes the new key dialog with Cancel and starts it empty again", async () => {
		await openCommon();
		fireEvent.click(screen.getByRole("button", { name: "Add key" }));
		fireEvent.change(await screen.findByLabelText("Key"), { target: { value: "half.typed" } });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		fireEvent.click(screen.getByRole("button", { name: "Add key" }));
		expect(await screen.findByLabelText("Key")).toHaveValue("");
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});

	it("names the single-file namespace in the new key dialog", async () => {
		render(<TranslationEditor />);
		fireEvent.click(screen.getByRole("button", { name: /single file/ }));
		await screen.findByText("buttons.save");
		fireEvent.click(screen.getByRole("button", { name: "Add key" }));
		expect(await screen.findByText("It will be created in (single file), in every locale you fill in.")).toBeInTheDocument();
	});

	it("shows the rows by pages of 150", async () => {
		const many = Array.from({ length: 320 }, (_, i) => ({
			key: `k${String(i).padStart(3, "0")}`,
			values: { en: "x", fr: "y" },
			placeholder_mismatch: false,
		}));
		api.loadI18nNamespace.mockResolvedValueOnce(view(many));
		render(<TranslationEditor />);
		fireEvent.click(screen.getByRole("button", { name: /^common/ }));
		expect(await screen.findByText("Showing 150 of 320")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(screen.getByText("Showing 300 of 320")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
		expect(screen.getByText("k319")).toBeInTheDocument();
	});
});
