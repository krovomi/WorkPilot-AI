/**
 * The code's story on the onboarding page (#349): its chapters and hot spots,
 * a tour per role, "I already know this project", regeneration when the
 * project's shape changed, and the export in the reader's language.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingPackage } from "../../../../preload/api/modules/onboarding-agent-api";
import { useOnboardingAgentStore } from "../../../stores/onboarding-agent-store";
import { OnboardingPackageView } from "../OnboardingPackageView";

vi.mock("react-i18next", () => ({
	useTranslation: (namespace?: string | string[]) => ({
		t: (key: string, options?: Record<string, unknown>) => {
			const ns = Array.isArray(namespace) ? namespace[0] : namespace;
			const name = key.includes(":") || !ns ? key : `${ns}:${key}`;
			return options && typeof options.count === "number" ? `${name} (${options.count})` : name;
		},
		i18n: { language: "fr" },
	}),
}));

const text = (key: string, fallback: string, params: Record<string, unknown> = {}) => ({ key, params, fallback });

const PACKAGE: OnboardingPackage = {
	guide: {
		project_name: "Shop",
		tech_stack: ["C# / .NET"],
		key_files: [],
		entry_points: [],
		conventions: [],
		commands: [],
		architecture: [],
		sections: {},
		stats: {},
		estimated_reading_time_min: 5,
	},
	tour: [
		{ order: 1, title: "README.md", file_path: "README.md", reason: "Start", suggested_questions: [], category: "doc" },
		{
			order: 2,
			title: "Cart.tsx",
			file_path: "web/components/Cart.tsx",
			reason: "The cart",
			suggested_questions: [],
			category: "file",
		},
		{
			order: 3,
			title: "OrdersController.cs",
			file_path: "src/Api/OrdersController.cs",
			reason: "Orders",
			suggested_questions: [],
			category: "file",
		},
	],
	quiz: [],
	first_tasks: [],
	glossary: [],
	story: {
		chapters: [
			{
				id: "critical",
				title: text("generated.story.chapter.critical", "Its most critical module"),
				lines: [text("generated.story.line.critical", "TokenService changed 5 times", { path: "src/Auth/TokenService.cs" })],
				files: ["src/Auth/TokenService.cs"],
			},
			{
				id: "decisions",
				title: text("generated.story.chapter.decisions", "What the team decided"),
				lines: [text("generated.story.line.adr", "Use PostgreSQL")],
				files: [],
			},
		],
		hotspots: [
			{
				path: "src/Auth/TokenService.cs",
				churn: 5,
				authors: 2,
				complexity: 14,
				lines: 80,
				danger: ["security"],
				tested: false,
				risk: 90,
				reasons: [text("generated.story.reason.untested", "No test file names it")],
			},
			{
				path: "web/components/Cart.tsx",
				churn: 2,
				authors: 1,
				complexity: 3,
				lines: 20,
				danger: [],
				tested: true,
				risk: 30,
				reasons: [],
			},
		],
		decisions: [{ source: "adr", title: "Use PostgreSQL", path: "docs/adr/0001.md", status: "accepted", date: "2025-03-02", ref: "" }],
		roles: { fullstack: [1, 2, 3], frontend: [1, 2], backend: [1, 3], devops: [1, 2, 3] },
		areas: { "src/Auth/TokenService.cs": "api", "web/components/Cart.tsx": "ui" },
		stacks: {},
		fingerprint: "abc",
		modules: ["src"],
	},
};

const api = {
	runOnboardingAgentScan: vi.fn(),
	cancelOnboardingAgentScan: vi.fn(),
	getOnboardingTourStatus: vi.fn(),
	narrateOnboardingStory: vi.fn(),
	exportOnboardingTour: vi.fn(),
	onOnboardingAgentEvent: () => vi.fn(),
	onOnboardingAgentResult: () => vi.fn(),
	onOnboardingAgentError: () => vi.fn(),
};

function showPackage(): void {
	useOnboardingAgentStore.setState({ phase: "complete", pkg: PACKAGE, activeTab: "overview" });
}

describe("the code's story", () => {
	beforeEach(() => {
		for (const fn of Object.values(api)) if (vi.isMockFunction(fn)) fn.mockReset();
		api.getOnboardingTourStatus.mockResolvedValue({ known: true, stale: false, added: [], removed: [], generatedAt: "" });
		Object.defineProperty(globalThis, "electronAPI", { value: api, writable: true, configurable: true });
		useOnboardingAgentStore.getState().reset();
		useOnboardingAgentStore.setState({ role: "fullstack", skipTour: false });
	});

	it("tells the chapters and lists the hot spots by risk", async () => {
		showPackage();
		render(<OnboardingPackageView projectPath="/repo" />);
		fireEvent.click(screen.getByText("onboardingAgent:tabs.story"));

		expect(screen.getAllByText(/generated\.story\.chapter\.critical/).length).toBeGreaterThan(0);
		expect(screen.getByText("src/Auth/TokenService.cs")).toBeTruthy();
		expect(screen.getByText("onboardingAgent:generated.story.danger.security")).toBeTruthy();
		expect(screen.getByText("Use PostgreSQL")).toBeTruthy();
		await waitFor(() => expect(api.getOnboardingTourStatus).toHaveBeenCalledWith({ projectPath: "/repo" }));
	});

	it("tells the story with the model in the app's language", async () => {
		api.narrateOnboardingStory.mockResolvedValue({
			paragraphs: { critical: "TokenService est le fichier le plus modifié." },
			answered: true,
			missing: ["decisions"],
		});
		showPackage();
		render(<OnboardingPackageView projectPath="/repo" />);
		fireEvent.click(screen.getByText("onboardingAgent:tabs.story"));

		fireEvent.click(screen.getByText("onboardingAgent:storyView.narrate"));

		expect(await screen.findByText("TokenService est le fichier le plus modifié.")).toBeTruthy();
		expect(api.narrateOnboardingStory).toHaveBeenCalledWith({ projectPath: "/repo", language: "fr" });
	});

	it("keeps a frontend tour to the UI and the general steps", () => {
		showPackage();
		render(<OnboardingPackageView projectPath="/repo" />);
		fireEvent.click(screen.getByText("onboardingAgent:tabs.tour"));

		fireEvent.click(screen.getByRole("button", { name: "onboardingAgent:roles.backend" }));

		expect(screen.getAllByText("OrdersController.cs").length).toBeGreaterThan(0);
		expect(screen.queryByText("Cart.tsx")).toBeNull();
		expect(screen.getByText("onboardingAgent:roles.count (2)")).toBeTruthy();
	});

	it("hides the tour and the quiz for someone who knows the project", () => {
		showPackage();
		render(<OnboardingPackageView projectPath="/repo" />);

		fireEvent.click(screen.getByText("onboardingAgent:actions.skipTour"));

		expect(screen.queryByText("onboardingAgent:tabs.tour")).toBeNull();
		expect(screen.queryByText("onboardingAgent:tabs.quiz")).toBeNull();
		expect(screen.getByText("onboardingAgent:tabs.architecture")).toBeTruthy();
		expect(screen.getByText("onboardingAgent:freshness.skipped")).toBeTruthy();
	});

	it("makes the tour again when the project's modules changed", async () => {
		api.getOnboardingTourStatus.mockResolvedValue({
			known: true,
			stale: true,
			added: ["src/Payments"],
			removed: [],
			generatedAt: "",
		});
		api.runOnboardingAgentScan.mockResolvedValue({
			guide: { projectName: "Shop" },
			package: PACKAGE,
			freshness: { known: true, stale: false, added: [], removed: [], generatedAt: "", changed: { added: ["src/Payments"], removed: [] } },
		});
		showPackage();
		render(<OnboardingPackageView projectPath="/repo" />);

		await waitFor(() => expect(api.runOnboardingAgentScan).toHaveBeenCalledWith({ projectPath: "/repo" }));
		expect(await screen.findByText("onboardingAgent:freshness.regenerated")).toBeTruthy();
	});

	it("leaves a fresh tour alone", async () => {
		showPackage();
		render(<OnboardingPackageView projectPath="/repo" />);

		await waitFor(() => expect(api.getOnboardingTourStatus).toHaveBeenCalled());
		expect(api.runOnboardingAgentScan).not.toHaveBeenCalled();
	});

	it("exports the story and the tour for the chosen role", async () => {
		api.exportOnboardingTour.mockResolvedValue({ saved: true, path: "/home/me/Shop-onboarding.html" });
		showPackage();
		useOnboardingAgentStore.setState({ role: "frontend" });
		render(<OnboardingPackageView projectPath="/repo" />);

		await act(async () => {
			fireEvent.click(screen.getByText("onboardingAgent:actions.exportHtml"));
		});

		const [request] = api.exportOnboardingTour.mock.calls[0];
		expect(request.format).toBe("html");
		expect(request.document.lang).toBe("fr");
		const headings = request.document.sections.map((s: { heading: string }) => s.heading);
		expect(headings).toContain("onboardingAgent:generated.story.chapter.critical");
		const tour = request.document.sections.find((s: { heading: string }) => s.heading.includes("tabs.tour"));
		expect(tour.lines).toHaveLength(2);
		expect(await screen.findByText("onboardingAgent:export.saved")).toBeTruthy();
	});
});
