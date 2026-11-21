/**
 * An idea as the person reads it: its card, the panel that opens from it and
 * the details each type carries, in words of the locale rather than the codes
 * the generator writes.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { Idea, IdeationStatus } from "../../../../shared/types";
import { IdeaCard } from "../IdeaCard";
import { IdeaDetailPanel } from "../IdeaDetailPanel";
import {
	codeImprovement,
	codeQuality,
	docGap,
	perf,
	security,
	uiux,
} from "./fixtures";

beforeEach(async () => {
	await i18n.changeLanguage("en");
});
afterEach(() => cleanup());

function renderCard(idea: Idea, onGoToTask?: (taskId: string) => void) {
	const props = {
		onClick: vi.fn(),
		onConvert: vi.fn(),
		onDismiss: vi.fn(),
		onToggleSelect: vi.fn(),
	};
	render(
		<IdeaCard idea={idea} isSelected={false} onGoToTask={onGoToTask} {...props} />,
	);
	return props;
}

function renderPanel(
	idea: Idea,
	extra: { onGoToTask?: (taskId: string) => void; isConverting?: boolean } = {},
) {
	const props = { onClose: vi.fn(), onConvert: vi.fn(), onDismiss: vi.fn() };
	render(<IdeaDetailPanel idea={idea} {...props} {...extra} />);
	return props;
}

describe("an idea card", () => {
	it("shows the type, the level in words, and opens, converts, dismisses and selects", () => {
		const idea = codeImprovement();
		const props = renderCard(idea);

		expect(screen.getByText("Code Improvements")).toBeInTheDocument();
		expect(screen.getByText("Large")).toBeInTheDocument();
		expect(screen.queryByText("large")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /Reuse the retry helper/ }));
		expect(props.onClick).toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Convert to task" }));
		expect(props.onConvert).toHaveBeenCalledWith(idea);
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(props.onDismiss).toHaveBeenCalledWith(idea);
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Select idea: Reuse the retry helper" }),
		);
		expect(props.onToggleSelect).toHaveBeenCalledWith("ci-1");
	});

	it.each<[Idea, string]>([
		[uiux(), "Accessibility"],
		[docGap(), "API Documentation"],
		[security(), "Critical"],
		[perf(), "Impact: High"],
		[codeQuality(), "Major"],
	])("names the level or category of a %s idea in words", (idea, label) => {
		renderCard(idea);
		expect(screen.getByText(label)).toBeInTheDocument();
	});

	it("shows a code the locale does not know as written", () => {
		renderCard(codeImprovement({ estimatedEffort: "huge" as "large" }));
		expect(screen.getByText("huge")).toBeInTheDocument();
	});

	it.each<[IdeationStatus, string]>([
		["selected", "Selected"],
		["converted", "Converted"],
		["dismissed", "Dismissed"],
		["archived", "Archived"],
	])("names the %s status in words", (status, label) => {
		renderCard(codeImprovement({ status }));
		expect(screen.getByText(label)).toBeInTheDocument();
		expect(screen.queryByText(status)).not.toBeInTheDocument();
	});

	it("offers no action on a dismissed idea", () => {
		renderCard(codeImprovement({ status: "dismissed" }), vi.fn());
		expect(screen.queryByRole("button", { name: "Convert to task" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Go to task" })).toBeNull();
	});

	it("leads a converted idea to its task", () => {
		const onGoToTask = vi.fn();
		renderCard(codeImprovement({ status: "archived", taskId: "t-9" }), onGoToTask);
		expect(screen.queryByRole("button", { name: "Convert to task" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Go to task" }));
		expect(onGoToTask).toHaveBeenCalledWith("t-9");
	});

	it("has no task link without a task or without somewhere to go", () => {
		renderCard(codeImprovement({ status: "converted" }), vi.fn());
		expect(screen.queryByRole("button", { name: "Go to task" })).toBeNull();
		cleanup();
		renderCard(codeImprovement({ status: "converted", taskId: "t-9" }));
		expect(screen.queryByRole("button", { name: "Go to task" })).toBeNull();
	});
});

describe("the idea panel", () => {
	it("converts, dismisses and closes a draft idea", () => {
		const idea = codeImprovement();
		const props = renderPanel(idea);
		const panel = screen.getByRole("complementary", { name: "Reuse the retry helper" });
		expect(within(panel).getByText("Why it is worth it")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Convert to WorkPilot AI Task" }));
		expect(props.onConvert).toHaveBeenCalledWith(idea);
		fireEvent.click(screen.getByRole("button", { name: "Dismiss Idea" }));
		expect(props.onDismiss).toHaveBeenCalledWith(idea);
		expect(props.onClose).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
		expect(props.onClose).toHaveBeenCalledTimes(2);
	});

	it("says it is converting and blocks a second conversion", () => {
		renderPanel(codeImprovement(), { isConverting: true });
		expect(screen.getByRole("button", { name: "Converting..." })).toBeDisabled();
	});

	it("offers no conversion for a dismissed idea", () => {
		renderPanel(codeImprovement({ status: "dismissed" }), { onGoToTask: vi.fn() });
		expect(screen.queryByRole("button", { name: /Convert/ })).toBeNull();
		expect(screen.queryByRole("button", { name: "Go to Task" })).toBeNull();
	});

	it("leads an idea converted then archived to its task instead of converting it again", () => {
		const onGoToTask = vi.fn();
		renderPanel(codeImprovement({ status: "archived", taskId: "t-3" }), { onGoToTask });
		expect(screen.queryByRole("button", { name: "Convert to WorkPilot AI Task" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Go to Task" }));
		expect(onGoToTask).toHaveBeenCalledWith("t-3");
	});

	it("has no task button without a task id", () => {
		renderPanel(codeImprovement({ status: "converted" }), { onGoToTask: vi.fn() });
		expect(screen.queryByRole("button", { name: "Go to Task" })).toBeNull();
	});
});

describe("the details of each type", () => {
	it("code improvement: effort, files, foundations, approach and patterns", () => {
		renderPanel(codeImprovement());
		expect(screen.getAllByText("Large")).toHaveLength(2);
		expect(screen.getByText("Builds Upon")).toBeInTheDocument();
		expect(screen.getByText("retry helper")).toBeInTheDocument();
		expect(screen.getByText("Wrap each call in withRetry")).toBeInTheDocument();
		expect(screen.getByText("src/net/fetch.ts")).toBeInTheDocument();
		expect(screen.getByText("withRetry wrapper")).toBeInTheDocument();
	});

	it("code improvement: leaves out the sections it has nothing for", () => {
		renderPanel(
			codeImprovement({
				buildsUpon: [],
				affectedFiles: [],
				existingPatterns: [],
				implementationApproach: "",
			}),
		);
		expect(screen.getByText("0")).toBeInTheDocument();
		expect(screen.queryByText("Builds Upon")).toBeNull();
		expect(screen.queryByText("Implementation Approach")).toBeNull();
		expect(screen.queryByText("Affected files")).toBeNull();
		expect(screen.queryByText("Patterns to Follow")).toBeNull();
	});

	it("UI/UX: category, current state, change, benefit and components", () => {
		renderPanel(uiux());
		expect(screen.getAllByText("Accessibility")).toHaveLength(2);
		expect(screen.getByText("Buttons have no name")).toBeInTheDocument();
		expect(screen.getByText("Give each an aria-label")).toBeInTheDocument();
		expect(screen.getByText("Screen readers announce them")).toBeInTheDocument();
		expect(screen.getByText("Toolbar")).toBeInTheDocument();
		cleanup();
		renderPanel(uiux({ affectedComponents: [] }));
		expect(screen.queryByText("Affected Components")).toBeNull();
	});

	it("documentation: category, effort, audience, content, areas and priority in words", () => {
		renderPanel(docGap());
		expect(screen.getAllByText("API Documentation")).toHaveLength(2);
		expect(screen.getByText("Trivial")).toBeInTheDocument();
		expect(screen.getByText("Maintainers")).toBeInTheDocument();
		expect(screen.getByText("Only a stub")).toBeInTheDocument();
		expect(screen.getByText("Every key with an example")).toBeInTheDocument();
		expect(screen.getByText("config/")).toBeInTheDocument();
		expect(screen.getByText("High")).toBeInTheDocument();
		cleanup();
		renderPanel(docGap({ currentDocumentation: "", affectedAreas: [] }));
		expect(screen.queryByText("Current Documentation")).toBeNull();
		expect(screen.queryByText("Affected Areas")).toBeNull();
	});

	it("security: a web reference is a link, anything else stays text", () => {
		renderPanel(security());
		expect(screen.getAllByText("Critical")).toHaveLength(2);
		expect(screen.getByText("Input Validation")).toBeInTheDocument();
		expect(screen.getByText("A query can inject markup")).toBeInTheDocument();
		expect(screen.getByText("Escape before rendering")).toBeInTheDocument();
		expect(screen.getByText("src/search.ts")).toBeInTheDocument();
		expect(screen.getByText("SOC2")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "https://owasp.org/xss" })).toHaveAttribute(
			"href",
			"https://owasp.org/xss",
		);
		expect(screen.queryByRole("link", { name: "CWE-79" })).toBeNull();
		expect(screen.getAllByText("CWE-79")).toHaveLength(2);
	});

	it("security: leaves out the sections it has nothing for", () => {
		renderPanel(
			security({
				vulnerability: "",
				affectedFiles: [],
				references: undefined,
				compliance: undefined,
			}),
		);
		expect(screen.queryByText("Vulnerability")).toBeNull();
		expect(screen.queryByText("References")).toBeNull();
		expect(screen.queryByText("Compliance")).toBeNull();
		cleanup();
		renderPanel(security({ references: [], compliance: [] }));
		expect(screen.queryByText("References")).toBeNull();
		expect(screen.queryByText("Compliance")).toBeNull();
	});

	it("performance: impact, effort, measures, implementation, areas and tradeoffs", () => {
		renderPanel(perf());
		expect(screen.getByText("High")).toBeInTheDocument();
		expect(screen.getByText("Small")).toBeInTheDocument();
		expect(screen.getByText("Caching")).toBeInTheDocument();
		expect(screen.getByText("300 ms per open")).toBeInTheDocument();
		expect(screen.getByText("10 ms per open")).toBeInTheDocument();
		expect(screen.getByText("Memoise the read")).toBeInTheDocument();
		expect(screen.getByText("stores/project-store.ts")).toBeInTheDocument();
		expect(screen.getByText("Stale for one second")).toBeInTheDocument();
		cleanup();
		renderPanel(perf({ currentMetric: "", tradeoffs: "", affectedAreas: [] }));
		expect(screen.queryByText("Current State")).toBeNull();
		expect(screen.queryByText("Tradeoffs")).toBeNull();
		expect(screen.queryByText("Affected Areas")).toBeNull();
	});

	it.each<[PerformanceCategory, string]>([
		["bundle_size", "Bundle Size"],
		["database", "Database Queries"],
		["network", "Network Requests"],
		["memory", "Memory Usage"],
		["runtime", "Runtime Performance"],
	])("performance: names the %s category", (category, label) => {
		renderPanel(perf({ category }));
		expect(screen.getByText(label)).toBeInTheDocument();
	});

	it("code quality: every metric, a zero line count included, and the breaking-change warning", () => {
		renderPanel(codeQuality());
		expect(screen.getAllByText("Major")).toHaveLength(2);
		expect(screen.getByText("Medium")).toBeInTheDocument();
		expect(screen.getByText("Large Files")).toBeInTheDocument();
		expect(screen.getByText("Breaking Change")).toBeInTheDocument();
		expect(screen.getByText("export const useTaskStore = create(...)")).toBeInTheDocument();
		expect(screen.getByText("Lines").previousSibling).toHaveTextContent("0");
		expect(screen.getByText("Complexity").previousSibling).toHaveTextContent("12");
		expect(screen.getByText("Duplicate Lines").previousSibling).toHaveTextContent("40");
		expect(screen.getByText("55%")).toBeInTheDocument();
		expect(screen.getByText("stores/task-store.ts")).toBeInTheDocument();
		expect(screen.getByText("Small modules")).toBeInTheDocument();
		expect(screen.getByText("Freeze the API")).toBeInTheDocument();
	});

	it("code quality: no empty metrics block when the idea carries none", () => {
		renderPanel(
			codeQuality({
				metrics: {},
				breakingChange: false,
				codeExample: "",
				bestPractice: "",
				affectedFiles: [],
				prerequisites: undefined,
			}),
		);
		expect(screen.queryByText("Metrics")).toBeNull();
		expect(screen.queryByText("Breaking Change")).toBeNull();
		expect(screen.queryByText("Code Example")).toBeNull();
		expect(screen.queryByText("Best Practice")).toBeNull();
		expect(screen.queryByText("Affected files")).toBeNull();
		expect(screen.queryByText("Prerequisites")).toBeNull();
		cleanup();
		renderPanel(codeQuality({ metrics: undefined, prerequisites: [] }));
		expect(screen.queryByText("Metrics")).toBeNull();
		expect(screen.queryByText("Prerequisites")).toBeNull();
	});

	it("code quality: shows only the metrics it has", () => {
		renderPanel(codeQuality({ metrics: { testCoverage: 80 } }));
		expect(screen.getByText("Metrics")).toBeInTheDocument();
		expect(screen.getByText("80%")).toBeInTheDocument();
		expect(screen.queryByText("Lines")).toBeNull();
		expect(screen.queryByText("Complexity")).toBeNull();
		expect(screen.queryByText("Duplicate Lines")).toBeNull();
	});
});

type PerformanceCategory = ReturnType<typeof perf>["category"];
