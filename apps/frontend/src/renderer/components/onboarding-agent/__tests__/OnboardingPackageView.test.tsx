/**
 * The onboarding page used to render a single tab with a single quiz question.
 * These tests cover the shell: every section of the generated package gets a
 * tab, the quiz keeps its answers attached to the right question when the
 * category filter narrows the list, and the tour tracks what has been read.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingPackage } from "../../../../preload/api/modules/onboarding-agent-api";
import { useOnboardingAgentStore } from "../../../stores/onboarding-agent-store";
import { OnboardingPackageView } from "../OnboardingPackageView";

// Echo the key back, namespace included, so an assertion names the key the
// component actually asked for.
vi.mock("react-i18next", () => ({
	useTranslation: (namespace?: string | string[]) => ({
		t: (key: string, options?: Record<string, unknown>) => {
			const ns = Array.isArray(namespace) ? namespace[0] : namespace;
			const name = key.includes(":") || !ns ? key : `${ns}:${key}`;
			return options && typeof options.count === "number"
				? `${name} (${options.count})`
				: name;
		},
	}),
}));

const PACKAGE: OnboardingPackage = {
	guide: {
		project_name: "Shop",
		tech_stack: ["C# / .NET", "Entity Framework Core"],
		key_files: [
			{
				path: "README.md",
				reason: "Project documentation entry point",
				category: "docs",
				lines: 12,
			},
		],
		entry_points: [
			{
				path: "src/Shop.Api/Program.cs",
				reason: "Application entry point",
				category: "entrypoint",
				lines: 3,
			},
		],
		conventions: [
			{
				name: "EditorConfig",
				description: "Editor-level formatting rules",
				examples: [".editorconfig"],
			},
		],
		commands: [
			{
				label: "Run the tests",
				command: "dotnet test",
				category: "test",
				source: ".NET project",
			},
		],
		architecture: [
			{
				path: "src/Shop.Domain",
				role: "Domain layer",
				file_count: 3,
				languages: ["C#"],
			},
		],
		sections: { getting_started: "## Getting Started\n\n1. dotnet restore" },
		stats: { code_files: 12, test_files: 3, directories: 6, languages: 1 },
		estimated_reading_time_min: 12,
	},
	tour: [
		{
			order: 1,
			title: "README.md",
			file_path: "README.md",
			reason: "Start here",
			suggested_questions: ["What is this project for?"],
			category: "doc",
		},
		{
			order: 2,
			title: "src/Shop.Api/Program.cs",
			file_path: "src/Shop.Api/Program.cs",
			reason: "Where it boots",
			suggested_questions: [],
			category: "entrypoint",
		},
	],
	quiz: [
		{
			question: "What is the primary technology?",
			choices: ["Rust", "C# / .NET", "Ruby"],
			correct_index: 1,
			rationale: "Detected from the project files",
			category: "stack",
			difficulty: "easy",
		},
		{
			question: "Which command runs the test suite?",
			choices: ["dotnet test", "make ship", "npm start"],
			correct_index: 0,
			rationale: "From the .NET project",
			category: "commands",
			difficulty: "easy",
		},
	],
	first_tasks: [
		{
			title: "TODO: validate the basket",
			file_path: "src/Shop.Application/Handler.cs",
			line: 4,
			source_comment: "// TODO: validate the basket",
			category: "todo",
			difficulty: "medium",
			why: "Left in the code by the team.",
		},
	],
	glossary: [
		{
			term: "Shop.Domain",
			occurrences: 5,
			sources: ["src/Shop.Domain/Order.cs"],
			kind: "directory",
			definition: "Domain layer",
		},
	],
};

function renderWithPackage(): void {
	useOnboardingAgentStore.setState({
		phase: "complete",
		pkg: PACKAGE,
		guide: null,
		activeTab: "overview",
		currentTourStep: 0,
		completedTourSteps: [],
		quizAnswers: {},
		error: null,
		status: "",
	});
	render(<OnboardingPackageView projectPath="/repo" />);
}

describe("OnboardingPackageView", () => {
	beforeEach(() => {
		// Each listener registration hands back its unsubscribe function.
		const noop = () => vi.fn();
		Object.defineProperty(globalThis, "electronAPI", {
			value: {
				runOnboardingAgentScan: vi.fn(),
				cancelOnboardingAgentScan: vi.fn(),
				onOnboardingAgentEvent: noop,
				onOnboardingAgentResult: noop,
				onOnboardingAgentError: noop,
			},
			writable: true,
			configurable: true,
		});
		useOnboardingAgentStore.getState().reset();
	});

	it("offers a tab for every section of the package", () => {
		renderWithPackage();

		for (const tab of [
			"onboardingAgent:tabs.overview",
			"onboardingAgent:tabs.tour",
			"onboardingAgent:tabs.architecture",
			"onboardingAgent:tabs.quiz",
			"onboardingAgent:tabs.firstTasks",
			"onboardingAgent:tabs.glossary",
		]) {
			expect(screen.getByText(tab)).toBeTruthy();
		}
	});

	it("shows the stack and the detected commands on the overview", () => {
		renderWithPackage();

		expect(screen.getAllByText("C# / .NET").length).toBeGreaterThan(0);
		expect(screen.getByText(/dotnet test/)).toBeTruthy();
	});

	it("scores a quiz answer against the question it belongs to", () => {
		renderWithPackage();
		fireEvent.click(screen.getByText("onboardingAgent:tabs.quiz"));

		fireEvent.click(screen.getByRole("button", { name: "C# / .NET" }));

		expect(useOnboardingAgentStore.getState().quizAnswers).toEqual({ 0: 1 });
	});

	it("keeps answer indexes aligned when the category filter hides questions", () => {
		renderWithPackage();
		fireEvent.click(screen.getByText("onboardingAgent:tabs.quiz"));

		// Filtering to "commands" leaves only the second question on screen.
		fireEvent.click(
			screen.getByRole("button", {
				name: "onboardingAgent:quizCategories.commands",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "dotnet test" }));

		expect(useOnboardingAgentStore.getState().quizAnswers).toEqual({ 1: 0 });
	});

	it("lets the quiz be retaken", () => {
		renderWithPackage();
		fireEvent.click(screen.getByText("onboardingAgent:tabs.quiz"));
		fireEvent.click(screen.getByRole("button", { name: "C# / .NET" }));

		fireEvent.click(screen.getByText("onboardingAgent:actions.retryQuiz"));

		expect(useOnboardingAgentStore.getState().quizAnswers).toEqual({});
	});

	it("tracks the tour steps that have been read", () => {
		renderWithPackage();
		fireEvent.click(screen.getByText("onboardingAgent:tabs.tour"));

		fireEvent.click(screen.getByText("onboardingAgent:actions.markDone"));

		expect(useOnboardingAgentStore.getState().completedTourSteps).toEqual([1]);
	});

	it("renders the architecture roles", () => {
		renderWithPackage();
		fireEvent.click(screen.getByText("onboardingAgent:tabs.architecture"));

		expect(screen.getByText("src/Shop.Domain/")).toBeTruthy();
		expect(screen.getByText("Domain layer")).toBeTruthy();
	});

	it("filters the glossary on the search box", () => {
		renderWithPackage();
		fireEvent.click(screen.getByText("onboardingAgent:tabs.glossary"));

		const search = screen.getByPlaceholderText("onboardingAgent:glossarySearch");
		fireEvent.change(search, { target: { value: "nothing-matches" } });

		expect(screen.queryByText("Shop.Domain")).toBeNull();
	});

	it("invites a scan when no package has been generated yet", () => {
		render(<OnboardingPackageView projectPath="/repo" />);

		const button = screen.getByText("onboardingAgent:actions.runScan");
		expect(within(button.parentElement as HTMLElement).queryByText(/tabs/)).toBeNull();
	});
});
