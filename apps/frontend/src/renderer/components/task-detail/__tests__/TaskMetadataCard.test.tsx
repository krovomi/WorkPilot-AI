/**
 * TaskMetadata, the parts around the description: the classification badges
 * in the app's language, a description that comes as HTML from a tracker, the
 * Azure DevOps hydration, the details below the card, the description editor's
 * keys, and what the acceptance criteria and the note say when a save fails.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../__tests__/helpers/renderer-api";
import { JSON_ERROR_PREFIX } from "../../../../shared/constants";
import i18n from "../../../../shared/i18n";
import type { Task } from "../../../../shared/types";
import { TooltipProvider } from "../../ui/tooltip";
import { TaskMetadata } from "../TaskMetadata";

const { persist, updateTask, toast } = vi.hoisted(() => ({
	persist: vi.fn<(id: string, updates: unknown) => Promise<boolean>>(),
	updateTask: vi.fn(),
	toast: vi.fn(),
}));
vi.mock("../../../stores/task-store", () => ({
	persistUpdateTask: (id: string, updates: unknown) => persist(id, updates),
	useTaskStore: { getState: () => ({ updateTask }) },
}));
vi.mock("../../../hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("../TaskBlockers", () => ({ TaskBlockers: () => null }));
vi.mock("../TaskStack", () => ({ TaskStack: () => null }));
vi.mock("../TaskCicdRun", () => ({ TaskCicdRun: () => <div data-testid="cicd-run" /> }));

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		projectId: "p1",
		title: "Export",
		description: "Add a CSV export.",
		createdAt: new Date("2026-11-01T10:00:00Z"),
		updatedAt: new Date("2026-11-02T10:00:00Z"),
		metadata: { sourceType: "manual" },
		...overrides,
	} as unknown as Task;
}

function setup(task: Task, editable = true) {
	return render(<TaskMetadata task={task} editable={editable} />, {
		wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider>,
	});
}

let api: RendererApi;

function useApi(overrides: Record<string, unknown> = {}) {
	api?.restore();
	api = installRendererApi({
		openExternal: vi.fn(),
		hydrateAzureDevOpsTaskDisplay: vi.fn(async () => ({ success: false })),
		syncAzureDevOpsTaskAC: vi.fn(async () => ({ success: true, data: { acceptanceCriteria: ["Synced"] } })),
		...overrides,
	});
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	persist.mockReset().mockResolvedValue(true);
	useApi();
});

afterEach(() => {
	cleanup();
	api.restore();
	vi.clearAllMocks();
});

describe("classification", () => {
	it("names the category, priority, complexity, impact, severity and ideation type in the app's language", async () => {
		await i18n.changeLanguage("fr");
		setup(
			makeTask({
				metadata: {
					category: "bug_fix",
					priority: "urgent",
					complexity: "large",
					impact: "high",
					securitySeverity: "critical",
					sourceType: "ideation",
					ideationType: "security_hardening",
				},
			} as Partial<Task>),
		);
		const fr = (key: string) => i18n.t(key);
		for (const key of [
			"tasks:form.classification.values.category.bug_fix",
			"tasks:form.classification.values.priority.urgent",
			"tasks:form.classification.values.complexity.large",
			"tasks:form.classification.values.impact.high",
			"tasks:metadata.securitySeverity.critical",
			"ideation:types.security_hardening",
		]) {
			expect(fr(key)).not.toBe(key);
			expect(screen.getByText(fr(key))).toBeInTheDocument();
		}
		expect(screen.getByText("Gravité critique")).toBeInTheDocument();
	});

	it("shows a value it has no name for as it is", () => {
		setup(
			makeTask({
				metadata: { category: "chores", sourceType: "ideation", ideationType: "custom_type" },
			} as unknown as Partial<Task>),
		);
		expect(screen.getByText("chores")).toBeInTheDocument();
		expect(screen.getByText("custom_type")).toBeInTheDocument();
	});
});

describe("description", () => {
	it("explains an unreadable plan instead of offering to edit it", () => {
		setup(makeTask({ description: `${JSON_ERROR_PREFIX}Unexpected token` }));
		expect(screen.getByText(/JSON Parse Error: Unexpected token/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
	});

	it("renders a tracker's HTML in the theme's colours, numbered lists kept numbered", () => {
		const { container } = setup(
			makeTask({
				description: [
					'<p style="color: #000000; background-color: #ffffff; margin-top: 12pt">Intro</p>',
					'<div><b>Bold</b> <i>it</i> <u>under</u> <span>plain</span> <span style="color: red">red</span>',
					'<a href="https://x.test">link</a></div>',
					'<ol><li>first</li></ol><ul><li>bullet</li></ul><div class="keep">kept</div><br>',
					'<p style="color: black; background-color: white; margin-bottom: 10pt">B</p>',
					'<p style="color: rgb(0, 0, 0); background-color: rgb(255, 255, 255)">C</p>',
					"<script>alert(1)</script>",
				].join(""),
			}),
		);
		const html = container.querySelector(".html-content") as HTMLElement;
		const intro = screen.getByText("Intro");
		expect(intro.getAttribute("style")).toContain("color: hsl(var(--foreground))");
		expect(intro.getAttribute("style")).toContain("background-color: transparent");
		expect(intro.getAttribute("style")).toContain("margin-top: 0.75rem");
		expect(screen.getByText("B").getAttribute("style")).toContain("margin-bottom: 0.75rem");
		expect(screen.getByText("C").getAttribute("style")).toContain("hsl(var(--foreground))");
		expect(html.querySelector("ol")).toHaveClass("list-decimal");
		expect(html.querySelector("ul")).toHaveClass("list-disc");
		expect(screen.getByText("plain")).toHaveClass("text-foreground");
		expect(screen.getByText("red")).not.toHaveClass("text-foreground");
		expect(screen.getByText("kept")).toHaveClass("keep");
		expect(screen.getByText("link")).toHaveClass("text-info");
		expect(html.querySelector("script")).toBeNull();
	});

	it("renders Markdown code blocks and tables", () => {
		const { container } = setup(
			makeTask({ description: "Run `npm ci`.\n\n```bash\nnpm test\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |" }),
		);
		expect(container.querySelector("pre code.language-bash")).toHaveTextContent("npm test");
		expect(screen.getByText("npm ci").tagName).toBe("CODE");
		expect(container.querySelector(".overflow-x-auto > table")).not.toBeNull();
	});

	it("offers to add a description, or says there is none when it cannot be edited", async () => {
		setup(makeTask({ description: "" }));
		await userEvent.click(screen.getByRole("button", { name: "Add a description" }));
		expect(screen.getByRole("textbox", { name: "Description" })).toBeInTheDocument();
		cleanup();
		setup(makeTask({ description: "" }), false);
		expect(screen.getByText("No description.")).toBeInTheDocument();
	});

	it("does not open the editor when the click ends a text selection or hits a link", () => {
		setup(makeTask({ description: "Read [the spec](https://x.test) first." }));
		fireEvent.click(screen.getByText("the spec"));
		expect(screen.queryByRole("textbox")).toBeNull();
		const selection = vi
			.spyOn(globalThis, "getSelection")
			.mockReturnValue({ isCollapsed: false, toString: () => "Read" } as Selection);
		fireEvent.click(screen.getByText(/first/));
		expect(screen.queryByRole("textbox")).toBeNull();
		selection.mockRestore();
		fireEvent.click(screen.getByText(/first/));
		expect(screen.getByRole("textbox")).toBeInTheDocument();
	});

	it("cancels with Escape, closes an unchanged save, and stays open when the save fails", async () => {
		setup(makeTask());
		await userEvent.click(screen.getByRole("button", { name: "Edit" }));
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("textbox")).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: "Edit" }));
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(persist).not.toHaveBeenCalled();
		expect(screen.queryByRole("textbox")).toBeNull();

		persist.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("IPC"));
		await userEvent.click(screen.getByRole("button", { name: "Edit" }));
		const field = screen.getByRole("textbox", { name: "Description" });
		await userEvent.type(field, " Now.");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(toast).toHaveBeenCalledTimes(2);
		expect(screen.getByRole("textbox", { name: "Description" })).toBeEnabled();

		await userEvent.clear(field);
		expect(screen.getByText("The description cannot be empty.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("keeps the editor of the next task open when the previous save ends late", async () => {
		let finish: (ok: boolean) => void = () => undefined;
		persist.mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					finish = resolve;
				}),
		);
		const { rerender } = setup(makeTask());
		await userEvent.click(screen.getByRole("button", { name: "Edit" }));
		await userEvent.type(screen.getByRole("textbox"), " More.");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		const next = makeTask({ id: "t2", description: "Second task." });
		rerender(<TaskMetadata task={next} />);
		await userEvent.click(screen.getByRole("button", { name: "Edit" }));
		await act(async () => finish(true));
		expect(screen.getByRole("textbox")).toHaveValue("Second task.");
	});

	it("folds a long description and unfolds it on request", async () => {
		const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
		try {
			setup(makeTask({ description: "Long.\n\n".repeat(50) }));
			const more = await screen.findByRole("button", { name: "Show more" });
			expect(more).toHaveAttribute("aria-expanded", "false");
			await userEvent.click(more);
			expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
			expect(screen.queryByRole("textbox")).toBeNull();
		} finally {
			height.mockRestore();
		}
	});
});

describe("Azure DevOps hydration", () => {
	const imported = (overrides: Partial<Task> = {}) =>
		makeTask({
			title: "003-fen-tre-d-avertissement",
			description: '<p><img src="https://dev.azure.com/o/_apis/wit/attachments/1"></p>',
			metadata: { sourceType: "imported" },
			...overrides,
		} as Partial<Task>);

	it("shows the accented title and the inlined images once, per task", async () => {
		const hydrate = vi.fn(async () => ({
			success: true,
			data: { html: "<p>Inlined</p>", title: "Fenêtre d'avertissement" },
		}));
		useApi({ hydrateAzureDevOpsTaskDisplay: hydrate });
		const { rerender } = setup(imported());
		expect(await screen.findByText("Inlined")).toBeInTheDocument();
		expect(hydrate).toHaveBeenCalledWith("p1", "t1");
		expect(updateTask).toHaveBeenCalledWith("t1", { title: "Fenêtre d'avertissement" });
		rerender(<TaskMetadata task={imported({ title: "Fenêtre d'avertissement" })} />);
		expect(hydrate).toHaveBeenCalledTimes(1);
	});

	it("keeps the description as it is when the hydration fails or there is nothing to do", async () => {
		const hydrate = vi
			.fn()
			.mockRejectedValueOnce(new Error("PAT"))
			.mockResolvedValueOnce({ success: true, data: {} });
		useApi({ hydrateAzureDevOpsTaskDisplay: hydrate });
		setup(imported());
		await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
		cleanup();
		setup(imported({ id: "t2", title: "Fenêtre" }));
		await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(2));
		expect(updateTask).not.toHaveBeenCalled();
		cleanup();
		setup(imported({ id: "t3", title: "Clean title", description: "Plain text" }));
		expect(hydrate).toHaveBeenCalledTimes(2);
	});
});

describe("details", () => {
	it("lists the audience, dependencies, files and the pull request", async () => {
		setup(
			makeTask({
				metadata: {
					targetAudience: "Admins",
					dependencies: ["Auth service"],
					affectedFiles: ["src/export/csv.ts"],
					prUrl: "https://github.com/o/r/pull/7",
					cicdRun: { status: "success" },
				},
			} as unknown as Partial<Task>),
		);
		expect(screen.getByText("Admins")).toBeInTheDocument();
		expect(screen.getByText("Auth service")).toBeInTheDocument();
		expect(screen.getByText("csv.ts")).toBeInTheDocument();
		expect(screen.getByTestId("cicd-run")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /pull\/7/ }));
		expect(globalThis.electronAPI.openExternal).toHaveBeenCalledWith("https://github.com/o/r/pull/7");
	});
});

describe("acceptance criteria", () => {
	const ado = (criteria: string[] = ["Old"]) =>
		makeTask({
			metadata: { azureDevOpsIdentifier: "ADO-42", acceptanceCriteria: criteria },
		} as unknown as Partial<Task>);

	it("syncs them from Azure DevOps", async () => {
		setup(ado());
		await userEvent.click(screen.getByRole("button", { name: "Sync from Azure DevOps" }));
		expect(globalThis.electronAPI.syncAzureDevOpsTaskAC).toHaveBeenCalledWith("p1", "t1", 42);
		expect(persist).toHaveBeenCalledWith("t1", { metadata: { acceptanceCriteria: ["Synced"] } });
		expect(toast).not.toHaveBeenCalled();
	});

	it("says when the sync or its save failed", async () => {
		const sync = vi
			.fn()
			.mockResolvedValueOnce({ success: false, error: "401" })
			.mockRejectedValueOnce(new Error("IPC"))
			.mockResolvedValueOnce({ success: true, data: { acceptanceCriteria: [] } });
		useApi({ syncAzureDevOpsTaskAC: sync });
		persist.mockResolvedValueOnce(false);
		setup(ado());
		const button = screen.getByRole("button", { name: "Sync from Azure DevOps" });
		await userEvent.click(button);
		await userEvent.click(button);
		await userEvent.click(button);
		expect(toast.mock.calls.map(([call]) => call.title)).toEqual([
			"Could not sync",
			"Could not sync",
			"Save failed",
		]);
		expect(toast.mock.calls[0][0].description).toBe(
			"The acceptance criteria could not be read from Azure DevOps.",
		);
		expect(button).toBeEnabled();
	});

	it("does not stay saving when the save throws", async () => {
		persist.mockRejectedValueOnce(new Error("IPC"));
		setup(ado(["One"]));
		await userEvent.click(screen.getAllByRole("button", { name: "Edit" }).at(-1) as HTMLElement);
		await userEvent.type(screen.getByRole("textbox", { name: "Criterion 1" }), "s");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Save failed" }));
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
	});
});

describe("additional notes", () => {
	it("saves the note and says when it could not", async () => {
		persist.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("IPC"));
		setup(makeTask({ metadata: { extraNote: "Keep it short" } } as Partial<Task>));
		const note = screen.getByRole("textbox", { name: "Additional notes" });
		const save = screen.getByRole("button", { name: "Save note" });
		expect(save).toBeDisabled();
		await userEvent.type(note, ".");
		await userEvent.click(save);
		expect(persist).toHaveBeenCalledWith("t1", { metadata: { extraNote: "Keep it short." } });
		await userEvent.click(save);
		await userEvent.click(save);
		expect(toast.mock.calls.map(([call]) => call.description)).toEqual([
			"The note could not be saved.",
			"The note could not be saved.",
		]);
	});
});
