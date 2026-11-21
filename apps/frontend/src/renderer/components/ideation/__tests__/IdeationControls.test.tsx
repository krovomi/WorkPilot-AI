/**
 * The controls around the ideas: the band and its actions, the type tabs,
 * the first-run screen, and the two dialogs (configuration, add more).
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { IdeationConfig, IdeationType } from "../../../../shared/types";
import { IdeationDialogs } from "../IdeationDialogs";
import { IdeationEmptyState } from "../IdeationEmptyState";
import { type IdeationTab, IdeationFilters } from "../IdeationFilters";
import { IdeationHeader } from "../IdeationHeader";

const CONFIG: IdeationConfig = {
	enabledTypes: ["code_improvements", "security_hardening"],
	includeRoadmapContext: true,
	includeKanbanContext: false,
	maxIdeasPerType: 5,
};

beforeEach(async () => {
	await i18n.changeLanguage("en");
});
afterEach(() => cleanup());

function renderHeader(over: Partial<Parameters<typeof IdeationHeader>[0]> = {}) {
	const props = {
		totalIdeas: 1,
		ideaCountByType: { code_improvements: 1 } as Record<string, number>,
		showDismissed: false,
		selectedCount: 0,
		onToggleShowDismissed: vi.fn(),
		onOpenConfig: vi.fn(),
		onOpenAddMore: vi.fn(),
		onDismissAll: vi.fn(),
		onDeleteSelected: vi.fn(),
		onConvertSelected: vi.fn(),
		onSelectAll: vi.fn(),
		onClearSelection: vi.fn(),
		onRefresh: vi.fn(),
		hasActiveIdeas: true,
		canAddMore: true,
		...over,
	};
	render(<IdeationHeader {...props} />);
	return props;
}

describe("the ideation band", () => {
	it("counts one idea in the singular and offers every action without a selection", () => {
		const props = renderHeader();
		expect(screen.getByText("1 idea")).toBeInTheDocument();
		expect(screen.getByTitle("Code Improvements")).toHaveTextContent("1");

		fireEvent.click(screen.getByRole("button", { name: "Select all" }));
		expect(props.onSelectAll).toHaveBeenCalled();
		const dismissed = screen.getByRole("button", { name: "Show dismissed" });
		expect(dismissed).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(dismissed);
		expect(props.onToggleShowDismissed).toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Configure" }));
		expect(props.onOpenConfig).toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Dismiss all ideas" }));
		expect(props.onDismissAll).toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Regenerate ideas" }));
		expect(props.onRefresh).toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Add More" }));
		expect(props.onOpenAddMore).toHaveBeenCalled();
	});

	it("acts on a selection: convert, delete, clear", () => {
		const props = renderHeader({ selectedCount: 3, totalIdeas: 4, showDismissed: true });
		expect(screen.getByText("4 ideas")).toBeInTheDocument();
		expect(screen.getByText("3 selected")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Dismiss all ideas" })).toBeNull();
		expect(screen.getByRole("button", { name: "Hide dismissed" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);

		fireEvent.click(screen.getByRole("button", { name: "Add to Kanban" }));
		expect(props.onConvertSelected).toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(props.onDeleteSelected).toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
		expect(props.onClearSelection).toHaveBeenCalled();
	});

	it("hides the actions that have nothing to act on", () => {
		renderHeader({ hasActiveIdeas: false, canAddMore: false });
		expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Dismiss all ideas" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Add More" })).toBeNull();
	});
});

describe("the type tabs", () => {
	it("shows each type with its count and reports the tab picked", () => {
		const onTabChange = vi.fn();
		const counts = {
			all: 3,
			code_improvements: 2,
			ui_ux_improvements: 0,
			documentation_gaps: 0,
			security_hardening: 1,
			performance_optimizations: 0,
			code_quality: 0,
		} satisfies Record<IdeationTab, number>;
		render(<IdeationFilters activeTab="all" onTabChange={onTabChange} counts={counts} />);
		const tabs = screen.getByRole("tablist", { name: "Idea types" });
		expect(within(tabs).getByRole("tab", { name: "All3" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		fireEvent.click(within(tabs).getByRole("tab", { name: "Security1" }));
		expect(onTabChange).toHaveBeenCalledWith("security_hardening");
	});
});

describe("the first-run screen", () => {
	function renderEmpty(over: Partial<Parameters<typeof IdeationEmptyState>[0]> = {}) {
		const props = {
			config: CONFIG,
			hasToken: true as boolean | null,
			isCheckingToken: false,
			onGenerate: vi.fn(),
			onOpenConfig: vi.fn(),
			onToggleIdeationType: vi.fn(),
			...over,
		};
		render(<IdeationEmptyState {...props} />);
		return props;
	}

	it("generates, opens the configuration and toggles a type", () => {
		const props = renderEmpty();
		expect(screen.getByText("2 of 6 enabled")).toBeInTheDocument();
		expect(screen.queryByText(/Claude token not configured/)).toBeNull();
		expect(screen.getByRole("switch", { name: "Security" })).toBeChecked();
		expect(screen.getByRole("switch", { name: "Performance" })).not.toBeChecked();

		fireEvent.click(screen.getByRole("button", { name: "Generate Ideas" }));
		expect(props.onGenerate).toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Configure" }));
		expect(props.onOpenConfig).toHaveBeenCalled();
		fireEvent.click(screen.getByRole("switch", { name: "Performance" }));
		expect(props.onToggleIdeationType).toHaveBeenCalledWith("performance_optimizations");
	});

	it("warns when no Claude token is set, once the check is over", () => {
		renderEmpty({ hasToken: false });
		expect(screen.getByText(/Claude token not configured/)).toBeInTheDocument();
		cleanup();
		renderEmpty({ hasToken: false, isCheckingToken: true });
		expect(screen.queryByText(/Claude token not configured/)).toBeNull();
		expect(screen.getByRole("button", { name: "Generate Ideas" })).toBeDisabled();
	});
});

describe("the dialogs", () => {
	function renderDialogs(over: Partial<Parameters<typeof IdeationDialogs>[0]> = {}) {
		const props = {
			showConfigDialog: false,
			showAddMoreDialog: false,
			config: CONFIG,
			typesToAdd: [] as IdeationType[],
			availableTypesToAdd: [] as IdeationType[],
			onToggleIdeationType: vi.fn(),
			onToggleTypeToAdd: vi.fn(),
			onSetConfig: vi.fn(),
			onCloseConfigDialog: vi.fn(),
			onCloseAddMoreDialog: vi.fn(),
			onConfirmAddMore: vi.fn(),
			...over,
		};
		render(<IdeationDialogs {...props} />);
		return props;
	}

	it("configures the types and the context sources by their names", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const props = renderDialogs({ showConfigDialog: true });
		const dialog = screen.getByRole("dialog", { name: "Ideation Configuration" });
		const keyWarnings = errors.mock.calls.filter((call) =>
			call.join(" ").includes('unique "key"'),
		);
		errors.mockRestore();
		expect(keyWarnings).toEqual([]);

		fireEvent.click(within(dialog).getByRole("switch", { name: "Code Quality" }));
		expect(props.onToggleIdeationType).toHaveBeenCalledWith("code_quality");
		const roadmap = within(dialog).getByRole("switch", { name: "Include Roadmap Context" });
		expect(roadmap).toBeChecked();
		fireEvent.click(roadmap);
		expect(props.onSetConfig).toHaveBeenCalledWith({ includeRoadmapContext: false });
		fireEvent.click(within(dialog).getByRole("switch", { name: "Include Kanban Context" }));
		expect(props.onSetConfig).toHaveBeenCalledWith({ includeKanbanContext: true });
		// The footer button and the corner cross both close it.
		for (const close of within(dialog).getAllByRole("button", { name: "Close" })) {
			fireEvent.click(close);
		}
		expect(props.onCloseConfigDialog).toHaveBeenCalledTimes(2);
	});

	it("picks the types to add with buttons and generates them", () => {
		const props = renderDialogs({
			showAddMoreDialog: true,
			availableTypesToAdd: ["documentation_gaps", "code_quality"],
			typesToAdd: ["code_quality"],
		});
		const dialog = screen.getByRole("dialog", { name: "Add More Ideas" });
		const picked = within(dialog).getByRole("button", { name: /^Code Quality/ });
		expect(picked).toHaveAttribute("aria-pressed", "true");
		const docs = within(dialog).getByRole("button", { name: /^Documentation/ });
		expect(docs).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(docs);
		expect(props.onToggleTypeToAdd).toHaveBeenCalledWith("documentation_gaps");

		expect(within(dialog).getByText("1 selected")).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole("button", { name: "Generate 1 Type" }));
		expect(props.onConfirmAddMore).toHaveBeenCalled();
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(props.onCloseAddMoreDialog).toHaveBeenCalled();
	});

	it("says every type is generated and cannot generate nothing", () => {
		renderDialogs({ showAddMoreDialog: true });
		const dialog = screen.getByRole("dialog", { name: "Add More Ideas" });
		expect(within(dialog).getByText("You've already generated all ideation types!")).toBeInTheDocument();
		expect(within(dialog).getByRole("button", { name: "Generate" })).toBeDisabled();
	});

	it("counts several types to add in the plural", () => {
		renderDialogs({
			showAddMoreDialog: true,
			availableTypesToAdd: ["documentation_gaps", "code_quality"],
			typesToAdd: ["documentation_gaps", "code_quality"],
		});
		expect(screen.getByRole("button", { name: "Generate 2 Types" })).toBeEnabled();
	});
});
