/**
 * TaskCodeEditor — the files a pending subtask plans to touch, as a tree; a
 * file the subtask should leave alone is removed from its plan, and nothing
 * else changes.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { Subtask } from "../../../../shared/types";
import { TooltipProvider } from "../../ui/tooltip";
import { TaskCodeEditor } from "../TaskCodeEditor";

const SUBTASK: Subtask = {
	id: "s1",
	title: "Add the export",
	description: "Add the export",
	status: "pending",
	files: ["src/export/csv.ts", "src\\export\\json.ts", "README.md", "src/app.ts"],
};

function renderEditor(onUpdate?: (subtask: Subtask) => Promise<boolean>, subtask = SUBTASK) {
	return render(<TaskCodeEditor subtask={subtask} onUpdate={onUpdate} />, {
		wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider>,
	});
}

afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

describe("TaskCodeEditor", () => {
	it("shows the planned files as a tree, folders first, and says nothing changes on disk", async () => {
		renderEditor();
		expect(screen.getByText(/The files themselves do not change/)).toBeInTheDocument();
		const rows = () => screen.getAllByText(/\.(ts|md)$|^src$|^export$/).map((n) => n.textContent);
		expect(rows()).toEqual(["src", "README.md"]);
		const src = screen.getByRole("button", { name: "src" });
		expect(src).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(src);
		await userEvent.click(screen.getByRole("button", { name: "export" }));
		expect(rows()).toEqual(["src", "export", "csv.ts", "json.ts", "app.ts", "README.md"]);
		expect(screen.getByText("json.ts").parentElement).toHaveAttribute("title", "src/export/json.ts");
		await userEvent.click(src);
		expect(rows()).toEqual(["src", "README.md"]);
	});

	it("removes files from the plan and saves what is left", async () => {
		const onUpdate = vi.fn(async () => true);
		renderEditor(onUpdate);
		await userEvent.click(screen.getByRole("button", { name: "Remove README.md from this subtask" }));
		expect(screen.queryByText("README.md")).toBeNull();
		expect(screen.getByText("1 file removed from the plan")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "src" }));
		await userEvent.click(screen.getByRole("button", { name: "Remove src/app.ts from this subtask" }));
		expect(screen.getByText("2 files removed from the plan")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		expect(onUpdate).toHaveBeenCalledWith({ ...SUBTASK, files: ["src/export/csv.ts", "src\\export\\json.ts"] });
		expect(screen.queryByText(/removed from the plan/)).toBeNull();
	});

	it("keeps the removals when the save is refused or fails, and cancel restores the files", async () => {
		await i18n.changeLanguage("fr");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const onUpdate = vi.fn(async () => false).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("IPC"));
		renderEditor(onUpdate);
		await userEvent.click(screen.getByRole("button", { name: "Retirer README.md de cette sous-tâche" }));
		const save = screen.getByRole("button", { name: "Enregistrer les modifications" });
		await userEvent.click(save);
		await userEvent.click(save);
		expect(error).toHaveBeenCalled();
		expect(screen.getByText("1 fichier retiré du plan")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Annuler" }));
		expect(screen.getByText("README.md")).toBeInTheDocument();
	});

	it("shows that it is saving, and does nothing without a way to save", async () => {
		let finish: (saved: boolean) => void = () => undefined;
		renderEditor(
			() =>
				new Promise<boolean>((resolve) => {
					finish = resolve;
				}),
		);
		await userEvent.click(screen.getByRole("button", { name: "Remove README.md from this subtask" }));
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
		finish(true);
		cleanup();

		renderEditor();
		await userEvent.click(screen.getByRole("button", { name: "Remove README.md from this subtask" }));
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		expect(screen.getByText("1 file removed from the plan")).toBeInTheDocument();
	});

	it("says when the subtask has no file", () => {
		renderEditor(undefined, { ...SUBTASK, files: [] });
		expect(screen.getByText("No files in this subtask")).toBeInTheDocument();
	});
});
