/**
 * The Ideation page on the real ideation store, with the main process behind
 * `electronAPI`: first run, generation, the list of ideas and its tabs, the
 * selection, the panel of an idea, and the dialogs.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { Idea } from "../../../../shared/types";
import { useViewState, ViewStateProvider } from "../../../contexts/ViewStateContext";
import { useIdeationStore } from "../../../stores/ideation-store";
import { Toaster } from "../../ui/toaster";
import { Ideation } from "../Ideation";
import { codeImprovement, security, session, uiux } from "./fixtures";

// The environment modal (another folder) is a form of its own; here it only
// has to open and report that the person configured it.
vi.mock("../../EnvConfigModal", () => ({
	EnvConfigModal: ({
		open,
		title,
		onConfigured,
	}: {
		open: boolean;
		title: string;
		onConfigured: () => void;
	}) =>
		open ? (
			<div role="dialog" aria-label={title}>
				<button type="button" onClick={onConfigured}>
					configured
				</button>
			</div>
		) : null,
}));

const INITIAL = useIdeationStore.getState();

type Api = Record<string, ReturnType<typeof vi.fn>>;
let api: Api;

function ok<T>(data?: T) {
	return Promise.resolve({ success: true, data });
}

function setApi(ideas: Idea[] | null, hasToken = true) {
	api = {
		getIdeation: vi.fn((projectId: string) =>
			ok(ideas ? session(ideas, projectId) : undefined),
		),
		checkSourceToken: vi.fn(() => ok({ hasToken })),
		getAPIProfiles: vi.fn(() => ok({ profiles: [], activeProfileId: "" })),
		generateIdeation: vi.fn(),
		refreshIdeation: vi.fn(),
		stopIdeation: vi.fn(() => ok()),
		convertIdeaToTask: vi.fn((_p: string, ideaId: string) => ok({ id: `task-${ideaId}` })),
		dismissIdea: vi.fn(() => ok()),
		dismissAllIdeas: vi.fn(() => ok()),
		deleteMultipleIdeas: vi.fn(() => ok()),
		getTasks: vi.fn(() => ok([])),
	};
	(globalThis as { electronAPI?: unknown }).electronAPI = new Proxy(api, {
		get: (target, key: string) => target[key] ?? vi.fn(() => () => undefined),
	});
}

function ArchivedToggle() {
	const { showArchived, toggleShowArchived } = useViewState();
	return (
		<button type="button" aria-pressed={showArchived} onClick={toggleShowArchived}>
			archived
		</button>
	);
}

function renderPage(projectId = "p1", onGoToTask = vi.fn()) {
	const view = (id: string) => (
		<ViewStateProvider>
			<ArchivedToggle />
			<Ideation projectId={id} onGoToTask={onGoToTask} />
			<Toaster />
		</ViewStateProvider>
	);
	const utils = render(view(projectId));
	return { ...utils, onGoToTask, switchTo: (id: string) => utils.rerender(view(id)) };
}

const IDEAS: Idea[] = [
	codeImprovement(),
	uiux(),
	security({ id: "sec-2", title: "Gone already", status: "dismissed" }),
	codeImprovement({ id: "ci-9", title: "Shipped", status: "archived", taskId: "task-9" }),
];

beforeEach(async () => {
	useIdeationStore.setState(INITIAL, true);
	useIdeationStore.setState({ selectedIds: new Set() });
	await i18n.changeLanguage("en");
});
afterEach(() => cleanup());

describe("the first run", () => {
	it("waits for the session, then generates the enabled types and stops", async () => {
		setApi(null);
		renderPage();
		expect(screen.getByRole("button", { name: "Generate Ideas" })).toBeDisabled();
		const generate = await screen.findByRole("button", { name: "Generate Ideas" });
		await waitFor(() => expect(generate).toBeEnabled());

		fireEvent.click(generate);
		expect(api.generateIdeation).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({ enabledTypes: INITIAL.config.enabledTypes }),
		);
		expect(screen.getByTestId("ideation-generation")).toBeInTheDocument();
		expect(screen.getByText("Generating Ideas")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await waitFor(() => expect(api.stopIdeation).toHaveBeenCalledWith("p1"));
		expect(await screen.findByRole("button", { name: "Generate Ideas" })).toBeInTheDocument();
	});

	it("asks for the Claude credentials first, then generates", async () => {
		setApi(null, false);
		renderPage();
		expect(await screen.findByText(/Claude token not configured/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Generate Ideas" }));
		expect(api.generateIdeation).not.toHaveBeenCalled();
		const modal = screen.getByRole("dialog", { name: "Claude Authentication Required" });
		fireEvent.click(within(modal).getByRole("button", { name: "configured" }));
		expect(api.generateIdeation).toHaveBeenCalled();
	});

	it("opens the configuration from the first-run screen", async () => {
		setApi([]);
		renderPage();
		fireEvent.click(await screen.findByRole("button", { name: "Configure" }));
		expect(screen.getByRole("dialog", { name: "Ideation Configuration" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("switch", { name: "Performance" }));
		expect(useIdeationStore.getState().config.enabledTypes).toContain(
			"performance_optimizations",
		);
	});
});

describe("the list of ideas", () => {
	it("lists the active ideas and narrows them by type", async () => {
		setApi(IDEAS);
		renderPage();
		expect(await screen.findByText("Reuse the retry helper")).toBeInTheDocument();
		expect(screen.getByText("2 ideas")).toBeInTheDocument();
		expect(screen.getByText("Label the icon buttons")).toBeInTheDocument();
		expect(screen.queryByText("Gone already")).toBeNull();
		expect(screen.queryByText("Shipped")).toBeNull();

		fireEvent.click(screen.getByRole("tab", { name: "UI/UX Improvements1" }));
		expect(
			screen.getByText("Visual and interaction improvements identified through app analysis"),
		).toBeInTheDocument();
		expect(screen.queryByText("Reuse the retry helper")).toBeNull();
		expect(screen.queryByRole("button", { name: "Import all" })).toBeNull();

		fireEvent.click(screen.getByRole("tab", { name: "Performance0" }));
		expect(screen.getByText("No ideas generated for this category")).toBeInTheDocument();
	});

	it("shows the dismissed and the archived ideas on demand", async () => {
		setApi(IDEAS);
		renderPage();
		await screen.findByText("Reuse the retry helper");
		fireEvent.click(screen.getByRole("tab", { name: "Security0" }));

		fireEvent.click(screen.getByRole("button", { name: "Show dismissed" }));
		expect(screen.getByText("Gone already")).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Security1" })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("tab", { name: "Code Improvements1" }));
		expect(screen.queryByText("Shipped")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "archived" }));
		expect(screen.getByText("Shipped")).toBeInTheDocument();
	});

	it("says so when every idea was dismissed", async () => {
		setApi([security({ status: "dismissed" })]);
		renderPage();
		expect(await screen.findByText("No ideas to display")).toBeInTheDocument();
		expect(screen.queryByRole("checkbox", { name: "Select all" })).toBeNull();
	});
});

describe("the selection", () => {
	it("goes from none to some to all and back with the select-all box", async () => {
		setApi(IDEAS);
		renderPage();
		await screen.findByText("Reuse the retry helper");
		const all = screen.getByRole("checkbox", { name: "Select all" });
		expect(all).toHaveAttribute("aria-checked", "false");

		fireEvent.click(
			screen.getByRole("checkbox", { name: "Select idea: Reuse the retry helper" }),
		);
		expect(all).toHaveAttribute("aria-checked", "mixed");
		expect(screen.getByText("1 selected")).toBeInTheDocument();

		fireEvent.click(all);
		expect(all).toHaveAttribute("aria-checked", "true");
		expect(screen.getByText("2 selected")).toBeInTheDocument();

		fireEvent.click(all);
		expect(all).toHaveAttribute("aria-checked", "false");

		fireEvent.click(screen.getByRole("button", { name: "Select all" }));
		expect(screen.getByText("2 selected")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
		expect(screen.queryByText("2 selected")).toBeNull();
	});

	it("imports every active idea into the Kanban", async () => {
		setApi(IDEAS);
		renderPage();
		await screen.findByText("Reuse the retry helper");
		fireEvent.click(screen.getByRole("button", { name: "Import all" }));
		await waitFor(() => expect(api.convertIdeaToTask).toHaveBeenCalledTimes(2));
		expect(await screen.findByText("2 idea(s) added to Kanban")).toBeInTheDocument();
	});

	it("deletes the selected ideas", async () => {
		setApi(IDEAS);
		renderPage();
		await screen.findByText("Reuse the retry helper");
		fireEvent.click(screen.getByRole("checkbox", { name: "Select idea: Label the icon buttons" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(screen.queryByText("Label the icon buttons")).toBeNull());
		expect(api.deleteMultipleIdeas).toHaveBeenCalledWith("p1", ["ux-1"]);
	});

	it("dismisses every idea", async () => {
		setApi(IDEAS);
		renderPage();
		await screen.findByText("Reuse the retry helper");
		fireEvent.click(screen.getByRole("button", { name: "Dismiss all ideas" }));
		expect(await screen.findByText("No ideas to display")).toBeInTheDocument();
	});
});

describe("the panel of an idea", () => {
	it("shows the idea as converted once its task exists, and leads to it", async () => {
		setApi(IDEAS);
		const { onGoToTask } = renderPage();
		fireEvent.click(await screen.findByRole("button", { name: /Reuse the retry helper/ }));
		const panel = screen.getByRole("complementary", { name: "Reuse the retry helper" });

		fireEvent.click(within(panel).getByRole("button", { name: "Convert to WorkPilot AI Task" }));
		const goTo = await within(panel).findByRole("button", { name: "Go to Task" });
		expect(within(panel).queryByRole("button", { name: /Convert/ })).toBeNull();
		fireEvent.click(goTo);
		expect(onGoToTask).toHaveBeenCalledWith("task-ci-1");
	});

	it("closes when the idea is dismissed, from the card again, or from its button", async () => {
		setApi(IDEAS);
		renderPage();
		const card = await screen.findByRole("button", { name: /Reuse the retry helper/ });
		fireEvent.click(card);
		fireEvent.click(card);
		expect(screen.queryByRole("complementary")).toBeNull();

		fireEvent.click(card);
		fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
		expect(screen.queryByRole("complementary")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /Label the icon buttons/ }));
		fireEvent.click(screen.getByRole("button", { name: "Dismiss Idea" }));
		await waitFor(() => expect(screen.queryByText("Label the icon buttons")).toBeNull());
		expect(api.dismissIdea).toHaveBeenCalledWith("p1", "ux-1");
		expect(screen.queryByRole("complementary")).toBeNull();
	});

	it("does not keep the previous project's idea open", async () => {
		setApi(IDEAS);
		const { switchTo } = renderPage();
		fireEvent.click(await screen.findByRole("button", { name: /Reuse the retry helper/ }));
		expect(screen.getByRole("complementary")).toBeInTheDocument();

		setApi([uiux({ id: "ux-p2", title: "Another project's idea" })]);
		await act(async () => switchTo("p2"));
		expect(await screen.findByText("Another project's idea")).toBeInTheDocument();
		expect(screen.queryByRole("complementary")).toBeNull();
	});
});

describe("the dialogs of the page", () => {
	it("adds the types not generated yet", async () => {
		setApi(IDEAS);
		renderPage();
		await screen.findByText("Reuse the retry helper");
		fireEvent.click(screen.getByRole("button", { name: "Add More" }));
		const dialog = screen.getByRole("dialog", { name: "Add More Ideas" });
		expect(within(dialog).queryByRole("button", { name: /^UI\/UX Improvements/ })).toBeNull();
		fireEvent.click(within(dialog).getByRole("button", { name: /^Security/ }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Generate 1 Type" }));
		expect(api.generateIdeation).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({ enabledTypes: ["security_hardening"], append: true }),
		);
	});

	it("closes the add-more dialog and the configuration", async () => {
		setApi(IDEAS);
		renderPage();
		await screen.findByText("Reuse the retry helper");
		fireEvent.click(screen.getByRole("button", { name: "Add More" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		fireEvent.click(screen.getByRole("button", { name: "Configure" }));
		const config = screen.getByRole("dialog", { name: "Ideation Configuration" });
		fireEvent.click(within(config).getAllByRole("button", { name: "Close" })[0]);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("regenerates the ideas", async () => {
		setApi(IDEAS);
		renderPage();
		await screen.findByText("Reuse the retry helper");
		fireEvent.click(screen.getByRole("button", { name: "Regenerate ideas" }));
		await waitFor(() => expect(api.refreshIdeation).toHaveBeenCalled());
		expect(screen.getByTestId("ideation-generation")).toBeInTheDocument();
	});
});
