/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TFunction } from "i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

// The key, then the interpolated values, so a test sees what reached the text.
const translate = (key: string, options?: Record<string, unknown>) =>
	options ? `${key} ${JSON.stringify(options)}` : key;

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: translate, i18n: { language: "fr" } }),
}));

const { createTask, runPipeline, writeFiles } = vi.hoisted(() => ({
	createTask: vi.fn(),
	runPipeline: vi.fn(),
	writeFiles: vi.fn(),
}));

vi.mock("../../../../stores/task-store", () => ({ createTask }));
vi.mock("../../../../stores/design-to-code-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../stores/design-to-code-store")>()),
	runDesignToCodePipeline: runPipeline,
	writeDesignFilesToProject: writeFiles,
}));
vi.mock("../../../generated-review/GeneratedReviewBanner", () => ({
	GeneratedReviewBanner: ({ review, projectId }: { review: { taskId: string }; projectId?: string }) => (
		<span data-testid="review-banner">{`${review.taskId}@${projectId ?? "none"}`}</span>
	),
}));

import type {
	DesignRenderLoop,
	DesignToCodeResult,
	DesignWriteOutcome,
} from "../../../../../shared/types/design-to-code";
import type { GeneratedReview } from "../../../../../shared/types/generated-review";
import { useDesignToCodeStore } from "../../../../stores/design-to-code-store";
import { useProjectStore } from "../../../../stores/project-store";
import { DesignComposer } from "../DesignComposer";
import { buildDesignTaskDescription } from "../design-task";
import { PipelineGraph } from "../PipelineGraph";
import { ResultInspector } from "../ResultInspector";
import { SourceColumn } from "../SourceColumn";

function result(overrides: Partial<DesignToCodeResult> = {}): DesignToCodeResult {
	return {
		success: true,
		phase: "complete",
		design_spec: {
			components: [
				{
					name: "Header",
					type: "navigation",
					description: "Top bar",
					bounds: { x: 0, y: 0, w: 1, h: 0.1 },
					children: [
						{ name: "Logo", type: "image" },
						{ name: "Menu", type: "list" },
					],
				},
				{ name: "Footer", type: "footer", description: "", children: [] },
			],
			color_palette: { primary: "#112233", surface: "var(--surface)" },
			typography: { body: { family: "Inter", size: "14px", weight: "400", line: "1.5" } },
		},
		generated_files: [
			{ path: "src/Header.tsx", content: "header code", language: "tsx", description: "", exists: true },
			{ path: "App.tsx", content: "app code", language: "tsx", description: "" },
		],
		visual_tests: [
			{ name: "header.spec.ts", path: "e2e/header.spec.ts", test_code: "test header", threshold: 0.9, description: "" },
			{ name: "footer.spec.ts", test_code: "test footer", threshold: 0.9, description: "", exists: true },
		],
		design_tokens_used: [
			{ name: "color-primary", value: "#112233", category: "color" },
			{ name: "space-2", value: "8px", category: "spacing" },
		],
		figma_sync_status: null,
		errors: [],
		warnings: [],
		duration_seconds: 12.4,
		tokens_used: 0,
		...overrides,
	};
}

function loop(overrides: Partial<DesignRenderLoop> = {}): DesignRenderLoop {
	const shot = { pixel_match: 1, ssim: 1, render_image: "", diff_image: "", regions: [], refused_edits: [], notes: [], duration_seconds: 1 };
	return {
		status: "converged",
		threshold: 0.95,
		mirror: false,
		best_iteration: 1,
		iterations: [
			{ ...shot, index: 0, score: 0.8, applied_edits: 0 },
			{ ...shot, index: 1, score: 0.96, applied_edits: 1 },
		],
		issues: [],
		...overrides,
	};
}

const review: GeneratedReview = {
	taskId: "042-design",
	specId: "042-design",
	title: "Design",
	branch: "workpilot/042-design",
	baseBranch: "develop",
	files: ["src/Header.tsx"],
} as unknown as GeneratedReview;

const store = () => useDesignToCodeStore.getState();
const setStore = (patch: Partial<ReturnType<typeof store>>) => act(() => useDesignToCodeStore.setState(patch));

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe = vi.fn();
		disconnect = vi.fn();
		unobserve = vi.fn();
	} as unknown as typeof ResizeObserver;
});

beforeEach(() => {
	vi.resetAllMocks();
	useDesignToCodeStore.setState({ ...useDesignToCodeStore.getInitialState(), notes: {} });
	useProjectStore.setState({ selectedProjectId: null });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("buildDesignTaskDescription", () => {
	const t = translate as unknown as TFunction;

	it("is empty without a result", () => {
		expect(
			buildDesignTaskDescription({ framework: "react", style: null, customInstructions: "", result: null }, t),
		).toBe("");
	});

	it("lists the style, the instructions, the components, the palette and every file", () => {
		const text = buildDesignTaskDescription(
			{ framework: "vue", style: "tailwind", customInstructions: "  Keep the header sticky  ", result: result() },
			t,
		);
		expect(text).toContain('designToCode:kanban.intro {"stack":"designToCode:stacks.vue"}');
		expect(text).toContain('designToCode:kanban.style {"style":"designToCode:styles.tailwind"}');
		expect(text).toContain("## designToCode:kanban.instructions\nKeep the header sticky\n");
		expect(text).toContain("- Header (navigation): Logo, Menu");
		expect(text).toContain("- Footer (footer)\n");
		expect(text).toContain("primary: #112233, surface: var(--surface)");
		expect(text).toContain("### src/Header.tsx\n```\nheader code\n```");
		expect(text).toContain("### e2e/header.spec.ts\n```\ntest header\n```");
		// A test without a path is named by its file name.
		expect(text).toContain("### footer.spec.ts\n```\ntest footer\n```");
	});

	it("leaves out what the run did not produce", () => {
		const text = buildDesignTaskDescription(
			{
				framework: "react",
				style: null,
				customInstructions: "   ",
				result: result({ design_spec: null, visual_tests: [] }),
			},
			t,
		);
		expect(text).not.toContain("kanban.style");
		expect(text).not.toContain("kanban.instructions");
		expect(text).not.toContain("kanban.components");
		expect(text).not.toContain("kanban.palette");
		expect(text).toContain("## designToCode:kanban.files");
	});

	it("only names the files once the code budget is spent", () => {
		const big = "x".repeat(40_000);
		const text = buildDesignTaskDescription(
			{
				framework: "react",
				style: null,
				customInstructions: "",
				result: result({
					generated_files: [
						{ path: "src/Big.tsx", content: `${big}tail`, language: "tsx", description: "" },
						{ path: "src/Small.tsx", content: "small", language: "tsx", description: "" },
					],
					visual_tests: [],
				}),
			},
			t,
		);
		expect(text).toContain(`### src/Big.tsx\n\`\`\`\n${big}\n\`\`\``);
		expect(text).not.toContain("tail");
		expect(text).toContain("\n- src/Small.tsx");
		expect(text).not.toContain("### src/Small.tsx");
	});
});

describe("DesignComposer", () => {
	it("generates only once there is a design, from the button or Ctrl+Enter", () => {
		render(<DesignComposer />);
		const generateButton = screen.getByTestId("design-generate-button");
		expect(generateButton).toBeDisabled();
		const instructions = screen.getByLabelText("composer.instructions");
		fireEvent.keyDown(instructions, { key: "Enter", ctrlKey: true });
		expect(runPipeline).not.toHaveBeenCalled();

		setStore({ imageData: "data:image/png;base64,AA" });
		expect(generateButton).toBeEnabled();
		fireEvent.click(generateButton);
		fireEvent.keyDown(instructions, { key: "Enter", metaKey: true });
		fireEvent.keyDown(instructions, { key: "Enter" });
		fireEvent.keyDown(instructions, { key: "a", ctrlKey: true });
		expect(runPipeline).toHaveBeenCalledTimes(2);
		expect(screen.getByText("footer.shortcut")).toBeInTheDocument();
	});

	it("starts from a Figma link as well as from a picture", () => {
		render(<DesignComposer />);
		fireEvent.change(screen.getByPlaceholderText("composer.figmaPlaceholder"), {
			target: { value: "https://figma.example/file/abc" },
		});
		expect(store().figmaUrl).toBe("https://figma.example/file/abc");
		fireEvent.click(screen.getByTestId("design-generate-button"));
		expect(runPipeline).toHaveBeenCalledTimes(1);
	});

	it("edits the instructions, the source and the design system", () => {
		render(<DesignComposer />);
		fireEvent.change(screen.getByLabelText("composer.instructions"), { target: { value: "Dark theme" } });
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "wireframe" } });
		fireEvent.change(screen.getByPlaceholderText("composer.designSystemPlaceholder"), {
			target: { value: "src/design" },
		});
		expect(store().customInstructions).toBe("Dark theme");
		expect(store().sourceType).toBe("wireframe");
		expect(store().designSystemPath).toBe("src/design");
	});

	it("locks the fields and shows the spinner while the run goes on", () => {
		setStore({ phase: "analyzing", imageData: "data:image/png;base64,AA" });
		render(<DesignComposer />);
		expect(screen.getByLabelText("composer.instructions")).toBeDisabled();
		expect(screen.getByTestId("design-stack-button")).toBeDisabled();
		expect(screen.getByTestId("design-generate-button")).toHaveTextContent("footer.processing");
		expect(screen.getByTestId("design-generate-button")).toBeDisabled();
		expect(screen.queryByText("footer.reset")).not.toBeInTheDocument();
		expect(screen.queryByText("footer.shortcut")).not.toBeInTheDocument();
	});

	it("picks a stack and a style, and closes on a click outside", () => {
		render(<DesignComposer />);
		const stackButton = screen.getByTestId("design-stack-button");
		fireEvent.click(stackButton);
		const picker = screen.getByRole("dialog", { name: "composer.target" });
		expect(stackButton).toHaveAttribute("aria-expanded", "true");
		fireEvent.click(within(picker).getByRole("button", { name: "stacks.vue" }));
		fireEvent.click(within(picker).getByRole("button", { name: "styles.scss" }));
		expect(store().framework).toBe("vue");
		expect(store().style).toBe("scss");
		expect(stackButton).toHaveTextContent("stacks.vue · styles.scss");
		fireEvent.click(within(picker).getByRole("button", { name: "styles.auto" }));
		expect(store().style).toBeNull();

		// A click inside keeps it open, a click elsewhere closes it.
		fireEvent.mouseDown(picker);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		fireEvent.click(stackButton);
		fireEvent.click(stackButton);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("disables the styles of a stack that has none", () => {
		setStore({ framework: "flutter" });
		render(<DesignComposer />);
		fireEvent.click(screen.getByTestId("design-stack-button"));
		expect(screen.getByRole("button", { name: "styles.tailwind" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "styles.auto" })).toBeEnabled();
	});

	it("applies the stack found in the project", () => {
		setStore({
			detection: { stack: "angular", style: "scss", evidence: ["angular.json", "package.json"], designSystemPath: null },
		});
		render(<DesignComposer />);
		fireEvent.click(screen.getByTestId("design-stack-button"));
		const detected = screen.getByRole("button", { name: /composer\.detected/ });
		expect(detected).toHaveTextContent('{"stack":"stacks.angular","style":" + styles.scss"}');
		expect(detected).toHaveTextContent("angular.json, package.json");
		fireEvent.click(detected);
		expect(store().framework).toBe("angular");
		expect(store().style).toBe("scss");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("applies a detected stack without a style", () => {
		setStore({ style: "tailwind", detection: { stack: "svelte", style: null, evidence: [], designSystemPath: null } });
		render(<DesignComposer />);
		fireEvent.click(screen.getByTestId("design-stack-button"));
		const detected = screen.getByRole("button", { name: /composer\.detected/ });
		expect(detected).toHaveTextContent('"style":""');
		fireEvent.click(detected);
		expect(store().framework).toBe("svelte");
		expect(store().style).toBeNull();
	});

	it("offers nothing when the project gave no stack away", () => {
		setStore({ detection: { stack: null, style: null, evidence: [], designSystemPath: null } });
		render(<DesignComposer />);
		fireEvent.click(screen.getByTestId("design-stack-button"));
		expect(screen.queryByRole("button", { name: /composer\.detected/ })).not.toBeInTheDocument();
	});

	it("starts over after a failed run", () => {
		setStore({ phase: "error", error: "boom" });
		render(<DesignComposer />);
		fireEvent.click(screen.getByRole("button", { name: "footer.reset" }));
		expect(store().phase).toBe("idle");
		expect(screen.queryByRole("button", { name: "footer.reset" })).not.toBeInTheDocument();
	});

	it("regenerates a finished run, but writes only into a selected project", () => {
		setStore({ phase: "complete", result: result(), imageData: "data:image/png;base64,AA" });
		render(<DesignComposer />);
		expect(screen.queryByTestId("design-generate-button")).not.toBeInTheDocument();
		expect(screen.queryByTestId("design-write-button")).not.toBeInTheDocument();
		expect(screen.queryByText("footer.createTask")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "footer.regenerate" }));
		expect(runPipeline).toHaveBeenCalledTimes(1);
	});

	it("writes the files to a review branch of the project", () => {
		useProjectStore.setState({ selectedProjectId: "proj-1" });
		setStore({ phase: "complete", result: result() });
		render(<DesignComposer />);
		const write = screen.getByTestId("design-write-button");
		expect(write).toHaveTextContent('footer.write {"count":4}');
		fireEvent.click(write);
		expect(writeFiles).toHaveBeenCalledTimes(1);

		setStore({ writing: true });
		expect(write).toBeDisabled();
		const outcome: DesignWriteOutcome = { written: [{ path: "src/Header.tsx", created: false }], refused: [] };
		setStore({ writing: false, writeOutcome: outcome });
		expect(write).toBeDisabled();
		expect(write).toHaveTextContent('footer.written {"count":4}');
	});

	it("counts no file when the run produced none", () => {
		useProjectStore.setState({ selectedProjectId: "proj-1" });
		setStore({ phase: "complete", result: result({ generated_files: [], visual_tests: [] }) });
		render(<DesignComposer />);
		expect(screen.getByTestId("design-write-button")).toHaveTextContent('footer.write {"count":0}');
	});

	it("keeps generating when the run finished without success", () => {
		setStore({ phase: "complete", result: result({ success: false }), imageData: "data:image/png;base64,AA" });
		render(<DesignComposer />);
		expect(screen.getByTestId("design-generate-button")).toBeEnabled();
		expect(screen.queryByRole("button", { name: "footer.regenerate" })).not.toBeInTheDocument();
	});

	it("creates a Kanban task from the result, then forgets it on the next run", async () => {
		useProjectStore.setState({ selectedProjectId: "proj-1" });
		setStore({ phase: "complete", result: result(), imageName: "home.png", customInstructions: "Sticky" });
		let finish: (task: unknown) => void = () => undefined;
		createTask.mockReturnValue(new Promise((resolve) => (finish = resolve)));
		render(<DesignComposer />);

		fireEvent.click(screen.getByRole("button", { name: "footer.createTask" }));
		const creating = screen.getByRole("button", { name: "footer.creatingTask" });
		expect(creating).toBeDisabled();
		expect(createTask).toHaveBeenCalledWith(
			"proj-1",
			'kanban.title {"name":"home.png"}',
			expect.stringContaining("Sticky"),
		);
		await act(async () => finish({ id: "task-1" }));
		expect(screen.getByRole("button", { name: "footer.taskCreated" })).toBeDisabled();

		setStore({ phase: "analyzing" });
		setStore({ phase: "complete" });
		expect(screen.getByRole("button", { name: "footer.createTask" })).toBeEnabled();
	});

	it("says so when the task could not be created, and lets the person retry", async () => {
		useProjectStore.setState({ selectedProjectId: "proj-1" });
		setStore({ phase: "complete", result: result() });
		createTask.mockResolvedValue(null);
		render(<DesignComposer />);

		fireEvent.click(screen.getByRole("button", { name: "footer.createTask" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("footer.taskFailed");
		expect(createTask).toHaveBeenCalledWith("proj-1", 'kanban.title {"name":"kanban.untitled"}', expect.any(String));

		createTask.mockResolvedValue({ id: "task-1" });
		fireEvent.click(screen.getByRole("button", { name: "footer.createTask" }));
		expect(await screen.findByRole("button", { name: "footer.taskCreated" })).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});

describe("ResultInspector", () => {
	it("invites a first run before there is anything", () => {
		render(<ResultInspector />);
		expect(screen.getByText("inspector.emptyTitle")).toBeInTheDocument();
		expect(screen.getByText("inspector.kicker")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("names a missing design, and shows other errors as they came", () => {
		setStore({ phase: "error", error: "missing_input" });
		const { unmount } = render(<ResultInspector />);
		expect(screen.getByRole("alert")).toHaveTextContent("errors.missingInput");
		expect(screen.getByText("inspector.waitingVision")).toBeInTheDocument();
		unmount();

		setStore({ phase: "idle", error: "Rate limited" });
		render(<ResultInspector />);
		expect(screen.getByRole("alert")).toHaveTextContent("Rate limited");
	});

	it("shows the live tree, the loop and the journal while the run goes on", () => {
		setStore({
			phase: "render_loop",
			startedAt: 1_000,
			journal: [
				{ phase: "analyzing", at: 500 },
				{ phase: "code_generation", at: 4_400 },
			],
			live: {
				...store().live,
				spec: {
					components: [
						{ name: "Header", type: "navigation", children: ["Logo", "Menu"] },
						{ name: "Footer", type: "footer", children: [] },
					],
					palette: {},
					typography: {},
				},
				loop: { stage: "correct", iteration: 2, max_iterations: 4, score: 0.91, best: 0.91 },
			},
		});
		render(<ResultInspector />);
		const tree = screen.getByTestId("design-live-tree");
		expect(tree).toHaveTextContent("Header navigation · Logo, Menu");
		expect(within(tree).getAllByRole("listitem")[1]).not.toHaveTextContent("·");
		expect(screen.getByTestId("design-loop-live")).toHaveTextContent(
			'loop.live {"iteration":2,"max":4,"stage":"loop.stage.correct"}',
		);
		expect(screen.getByTestId("design-loop-live")).toHaveTextContent("loop.score");
		// An entry logged before the start counts as 0 s.
		expect(screen.getByText('inspector.elapsed {"seconds":0}')).toBeInTheDocument();
		expect(screen.getByText('inspector.elapsed {"seconds":3}')).toBeInTheDocument();
	});

	it("leaves the score out before the loop measured one, and the times before the start", () => {
		setStore({
			phase: "render_loop",
			journal: [{ phase: "analyzing", at: 500 }],
			live: { ...store().live, loop: { stage: "render", iteration: 1, max_iterations: 3, score: null, best: null } },
		});
		render(<ResultInspector />);
		expect(screen.getByTestId("design-loop-live")).not.toHaveTextContent("loop.score");
		expect(screen.getByText("phases.analyzing")).toBeInTheDocument();
		expect(screen.queryByText(/inspector\.elapsed/)).not.toBeInTheDocument();
	});

	it("reports the accessibility of the generated markup", () => {
		setStore({
			phase: "complete",
			result: result({
				accessibility: {
					score: 72,
					count: 3,
					targetLevel: "AA",
					violations: ["image-alt", "label", "image-alt", "color-contrast", "list", "region"].map((ruleId) => ({
						ruleId,
						description: "",
						severity: "serious",
						wcagCriteria: "",
						file: "src/Header.tsx",
						line: 1,
					})),
				},
			}),
		});
		const { unmount } = render(<ResultInspector />);
		const banner = screen.getByTestId("design-accessibility");
		expect(banner).toHaveAttribute("data-kind", "error");
		expect(banner).toHaveTextContent('"rules":"image-alt, label, color-contrast, list"');
		unmount();

		setStore({
			result: result({ accessibility: { score: 100, count: 0, targetLevel: "AAA", violations: [] } }),
		});
		render(<ResultInspector />);
		expect(screen.getByTestId("design-accessibility")).not.toHaveAttribute("data-kind");
		expect(screen.getByTestId("design-accessibility")).toHaveTextContent('inspector.accessibilityClean {"level":"AAA"}');
	});

	it("shows the spec of the vision and spec steps", () => {
		setStore({ phase: "complete", result: result(), selectedStep: "vision" });
		render(<ResultInspector />);
		expect(screen.getByText('inspector.specTitle {"count":2}')).toBeInTheDocument();
		expect(screen.getByText("Top bar")).toBeInTheDocument();
		expect(screen.getByText("Logo, Menu")).toBeInTheDocument();
		expect(screen.getByText("steps.vision.kicker")).toBeInTheDocument();
		expect(screen.getByText('inspector.duration {"seconds":"12"}')).toBeInTheDocument();
	});

	it("shows an empty spec when the run has none", () => {
		setStore({ phase: "complete", result: result({ design_spec: null }), selectedStep: "spec" });
		render(<ResultInspector />);
		expect(screen.getByText('inspector.specTitle {"count":0}')).toBeInTheDocument();
	});

	it("lists the tokens, with a swatch for the colors", () => {
		setStore({ phase: "complete", result: result(), selectedStep: "tokens" });
		const { container, unmount } = render(<ResultInspector />);
		expect(screen.getByText('inspector.tokensTitle {"count":2}')).toBeInTheDocument();
		expect(screen.getByText("space-2")).toBeInTheDocument();
		expect(container.querySelectorAll("li i")).toHaveLength(1);
		unmount();

		setStore({ result: result({ design_tokens_used: [] }) });
		render(<ResultInspector />);
		expect(screen.getByText("inspector.noTokens")).toBeInTheDocument();
	});

	it("shows the visual tests, or why there are none", () => {
		setStore({ phase: "complete", result: result(), selectedStep: "tests" });
		const { unmount } = render(<ResultInspector />);
		expect(screen.getByTestId("design-code-view")).toHaveTextContent("test header");
		fireEvent.click(screen.getByRole("button", { name: /footer\.spec\.ts/ }));
		expect(store().selectedFilePath).toBe("tests/visual/footer.spec.ts");
		expect(screen.getByTestId("design-code-view")).toHaveTextContent("test footer");
		unmount();

		setStore({ result: result({ visual_tests: [], warnings: ["visual_tests_unsupported"] }) });
		const second = render(<ResultInspector />);
		expect(screen.getByText("pipeline.testsUnsupported")).toBeInTheDocument();
		second.unmount();

		setStore({ result: result({ visual_tests: [] }) });
		render(<ResultInspector />);
		expect(screen.getByText("inspector.noTests")).toBeInTheDocument();
	});

	it("explains the project step, then lists what was written and refused", () => {
		useProjectStore.setState({ selectedProjectId: "proj-1" });
		setStore({ phase: "complete", result: result(), selectedStep: "project" });
		render(<ResultInspector />);
		expect(screen.getByText("inspector.projectTitle")).toBeInTheDocument();
		expect(screen.getByText("inspector.projectBody")).toBeInTheDocument();

		setStore({
			writeOutcome: {
				written: [
					{ path: "src/Header.tsx", created: false },
					{ path: "App.tsx", created: true },
				],
				refused: [{ path: "../etc/hosts", reason: "outside" }],
				review,
			},
		});
		expect(screen.getByText("inspector.writtenTitle")).toBeInTheDocument();
		expect(screen.getByTestId("review-banner")).toHaveTextContent("042-design@proj-1");
		expect(screen.getByText("inspector.updated")).toBeInTheDocument();
		expect(screen.getByText("inspector.created")).toBeInTheDocument();
		expect(screen.getByText("inspector.refused.outside")).toBeInTheDocument();
	});

	it("writes without a review card and without a selected project", () => {
		setStore({
			phase: "complete",
			result: result(),
			selectedStep: "project",
			writeOutcome: { written: [], refused: [], review: { ...review, taskId: "043" } as GeneratedReview },
		});
		const { unmount } = render(<ResultInspector />);
		expect(screen.getByTestId("review-banner")).toHaveTextContent("043@none");
		unmount();

		setStore({ writeOutcome: { written: [], refused: [] } });
		render(<ResultInspector />);
		expect(screen.queryByTestId("review-banner")).not.toBeInTheDocument();
	});

	it("groups the code by folder and copies the shown file", async () => {
		vi.useFakeTimers();
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		setStore({ phase: "complete", result: result({ render_loop: loop() }) });
		render(<ResultInspector />);
		expect(screen.getByText("src")).toBeInTheDocument();
		expect(screen.getByText(".")).toBeInTheDocument();
		expect(screen.getByText("inspector.fileExists")).toBeInTheDocument();
		expect(screen.getByText("inspector.fileNew")).toBeInTheDocument();
		expect(screen.getByText('inspector.codeTitle {"count":2}')).toBeInTheDocument();

		await act(async () => fireEvent.click(screen.getByRole("button", { name: "code.copy" })));
		expect(writeText).toHaveBeenCalledWith("header code");
		expect(screen.getByRole("button", { name: "code.copied" })).toBeInTheDocument();

		// Another file shows its own copy button, not the last copy's state.
		fireEvent.click(screen.getByRole("button", { name: /App\.tsx/ }));
		expect(screen.getByRole("button", { name: "code.copy" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Header\.tsx/ }));
		expect(screen.getByRole("button", { name: "code.copied" })).toBeInTheDocument();

		act(() => vi.advanceTimersByTime(1600));
		expect(screen.getByRole("button", { name: "code.copy" })).toBeInTheDocument();
	});

	it("says so when the clipboard refuses the copy", async () => {
		const writeText = vi.fn().mockRejectedValue(new Error("denied"));
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		setStore({ phase: "complete", result: result() });
		render(<ResultInspector />);
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "code.copy" })));
		expect(screen.getByRole("button", { name: "code.copyFailed" })).toBeInTheDocument();
	});

	it("shows no code pane when the run wrote no file", () => {
		setStore({ phase: "complete", result: result({ generated_files: [] }) });
		render(<ResultInspector />);
		expect(screen.queryByTestId("design-code-view")).not.toBeInTheDocument();
	});
});

describe("SourceColumn", () => {
	function file(name: string, type: string, size = 10) {
		const f = new File(["x"], name, { type });
		Object.defineProperty(f, "size", { value: size });
		return f;
	}

	it("reads a picture chosen in the file dialog", async () => {
		render(<SourceColumn />);
		const input = screen.getByTestId("design-file-input") as HTMLInputElement;
		const click = vi.spyOn(input, "click");
		fireEvent.click(screen.getByRole("button", { name: /upload\.dropDesign/ }));
		expect(click).toHaveBeenCalled();

		fireEvent.change(input, { target: { files: [file("home.png", "image/png")] } });
		await waitFor(() => expect(store().imageName).toBe("home.png"));
		expect(store().imageData).toMatch(/^data:image\/png;base64,/);
		expect(input.value).toBe("");
	});

	it("ignores an empty file selection", () => {
		render(<SourceColumn />);
		fireEvent.change(screen.getByTestId("design-file-input"), { target: { files: [] } });
		expect(store().imageName).toBeNull();
	});

	it("refuses a picture over 20 MB", () => {
		render(<SourceColumn />);
		fireEvent.change(screen.getByTestId("design-file-input"), {
			target: { files: [file("huge.png", "image/png", 21 * 1024 * 1024)] },
		});
		expect(screen.getByRole("alert")).toHaveTextContent("upload.rejectedSize");
		expect(store().imageName).toBeNull();
	});

	it("takes a dropped picture and shows the drag state", async () => {
		render(<SourceColumn />);
		const zone = screen.getByRole("button", { name: /upload\.dropDesign/ });
		fireEvent.dragOver(zone);
		expect(zone).toHaveAttribute("data-dragging", "true");
		fireEvent.dragLeave(zone);
		expect(zone).toHaveAttribute("data-dragging", "false");

		fireEvent.dragOver(zone);
		fireEvent.drop(zone, { dataTransfer: { files: [] } });
		expect(zone).toHaveAttribute("data-dragging", "false");
		fireEvent.drop(zone, { dataTransfer: { files: [file("drop.webp", "image/webp")] } });
		await waitFor(() => expect(store().imageName).toBe("drop.webp"));
	});

	it("takes a screenshot pasted anywhere, and ignores other pastes", async () => {
		const { unmount } = render(<SourceColumn />);
		const paste = (items: { type: string; getAsFile: () => File | null }[] | undefined) => {
			const event = new Event("paste") as Event & { clipboardData?: unknown };
			event.clipboardData = items ? { items } : undefined;
			globalThis.dispatchEvent(event);
		};
		paste(undefined);
		paste([{ type: "text/plain", getAsFile: () => null }]);
		paste([{ type: "image/png", getAsFile: () => null }]);
		expect(store().imageName).toBeNull();

		paste([{ type: "image/png", getAsFile: () => file("pasted.png", "image/png") }]);
		await waitFor(() => expect(store().imageName).toBe("pasted.png"));

		unmount();
		act(() => store().clearImage());
		paste([{ type: "image/png", getAsFile: () => file("late.png", "image/png") }]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(store().imageName).toBeNull();
	});

	it("shows the live zones and the reading state while the vision step runs", () => {
		setStore({ imagePreview: "data:image/png;base64,AA", imageName: "home.png", phase: "analyzing" });
		const { container } = render(<SourceColumn />);
		expect(screen.getByText("source.reading")).toBeInTheDocument();
		expect(container.querySelector(".di-scan")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "source.remove" })).toBeDisabled();

		setStore({
			live: {
				...store().live,
				spec: {
					components: [
						{ name: "Hero", type: "section", children: [], bounds: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 } },
						{ name: "Nav", type: "navigation", children: [] },
					],
					palette: { brand: "#ff0000", ink: "var(--ink)" },
					typography: {},
				},
			},
		});
		expect(screen.getByText('source.zones {"count":2}')).toBeInTheDocument();
		expect(container.querySelector(".di-scan")).not.toBeInTheDocument();
		const region = screen.getByText("Hero").parentElement as HTMLElement;
		expect(region.style.left).toBe("10%");
		expect(region.style.height).toBe("25%");
		expect(region).toHaveAttribute("data-hot", "false");
		const swatches = container.querySelectorAll(".di-swatches i");
		expect(swatches).toHaveLength(2);
		expect((swatches[0] as HTMLElement).style.background).toBe("rgb(255, 0, 0)");
		// A CSS variable cannot be drawn outside its theme: it only keeps its title.
		expect((swatches[1] as HTMLElement).style.background).toBe("");
		expect(swatches[1]).toHaveAttribute("title", "ink var(--ink)");
	});

	it("shows the result's fonts and removes the picture once the run is over", () => {
		setStore({
			imagePreview: "data:image/png;base64,AA",
			imageData: "data:image/png;base64,AA",
			imageName: "home.png",
			phase: "complete",
			result: result({ design_spec: { ...(result().design_spec as NonNullable<DesignToCodeResult["design_spec"]>), color_palette: {} } }),
			selectedFilePath: "src/Header.tsx",
		});
		render(<SourceColumn />);
		expect(screen.getByText("Inter · 14px · 400")).toBeInTheDocument();
		expect(screen.getByText("Header").parentElement).toHaveAttribute("data-hot", "true");
		expect(screen.queryByText("source.reading")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "source.remove" }));
		expect(store().imagePreview).toBeNull();
	});

	it("shows the palette alone when the design has no font", () => {
		setStore({
			live: { ...store().live, spec: { components: [], palette: { brand: "#00ff00" }, typography: {} } },
		});
		const { container } = render(<SourceColumn />);
		expect(container.querySelectorAll(".di-swatches i")).toHaveLength(1);
		expect(container.querySelector(".di-facts .di-mono")).not.toBeInTheDocument();
	});
});

describe("PipelineGraph", () => {
	it("draws a wire between every pair of steps, lit once the first is done", () => {
		setStore({ phase: "spec_generation" });
		const { container, unmount } = render(<PipelineGraph />);
		const wires = container.querySelectorAll("path.di-wire");
		expect(wires).toHaveLength(5);
		expect(wires[0]).toHaveAttribute("data-state", "live");
		expect(wires[1]).toHaveAttribute("data-state", "live");
		expect(wires[2]).toHaveAttribute("data-state", "idle");
		expect(container.querySelectorAll("path.di-wire-spark")).toHaveLength(2);
		unmount();
	});

	it("reads the vision and spec counts, and the tokens or their folder", () => {
		setStore({
			phase: "code_generation",
			designSystemPath: "src/design",
			live: {
				...store().live,
				spec: { components: [{ name: "Hero", type: "section", children: [] }], palette: { a: "#000" }, typography: {} },
				tokens: 7,
				files: ["src/Hero.tsx"],
			},
		});
		const { unmount } = render(<PipelineGraph />);
		expect(screen.getByText('pipeline.meta.visionDone {"count":1,"colors":1}')).toBeInTheDocument();
		expect(screen.getByText('pipeline.meta.tokensDone {"count":7}')).toBeInTheDocument();
		expect(screen.getByText('pipeline.meta.specDone {"count":1}')).toBeInTheDocument();
		expect(screen.getByText('pipeline.meta.code {"stack":"stacks.react"}')).toBeInTheDocument();
		unmount();

		setStore({ phase: "analyzing", live: { ...store().live, spec: null, tokens: null } });
		render(<PipelineGraph />);
		expect(screen.getByText("pipeline.meta.vision")).toBeInTheDocument();
		expect(screen.getByText("src/design")).toBeInTheDocument();
		expect(screen.getByText("pipeline.meta.spec")).toBeInTheDocument();
		expect(screen.getByText("pipeline.running")).toBeInTheDocument();
	});

	it("marks the tests a stack cannot have, and the steps switched off", () => {
		setStore({ framework: "wpf", useDesignTokens: false });
		const { unmount } = render(<PipelineGraph />);
		expect(screen.getByText("pipeline.testsUnsupported")).toBeInTheDocument();
		expect(screen.getByText("pipeline.off")).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: "steps.tokens.toggle" })).toHaveAttribute("aria-checked", "false");
		expect(screen.queryByRole("switch", { name: "steps.tests.toggle" })).not.toBeInTheDocument();
		expect(screen.getByText('pipeline.stepCount {"count":6}')).toBeInTheDocument();
		unmount();
	});

	it("sums up a finished run, then what was written", () => {
		setStore({ phase: "complete", result: result({ render_loop: loop({ status: "skipped" }) }) });
		render(<PipelineGraph />);
		expect(screen.getByText('pipeline.doneIn {"seconds":"12"}')).toBeInTheDocument();
		expect(screen.getByText('pipeline.meta.codeDone {"count":2}')).toBeInTheDocument();
		expect(screen.getByText('pipeline.meta.testsDone {"count":2}')).toBeInTheDocument();
		expect(screen.getByText('pipeline.meta.projectReady {"count":4}')).toBeInTheDocument();
		expect(screen.getByText("pipeline.legendDone")).toBeInTheDocument();

		setStore({ writeOutcome: { written: [{ path: "App.tsx", created: true }], refused: [] } });
		expect(screen.getByText('pipeline.meta.projectWritten {"count":1}')).toBeInTheDocument();
	});

	it("marks the step that failed", () => {
		setStore({ phase: "error", failedStep: "spec" });
		const { container } = render(<PipelineGraph />);
		expect(container.querySelector('[data-state="error"] .di-node-title')).toHaveTextContent("steps.spec.title");
		expect(screen.getByText("pipeline.meta.project")).toBeInTheDocument();
	});

	it("keeps the default sentence on Escape and saves an edited one on Enter", () => {
		render(<PipelineGraph />);
		const [first] = screen.getAllByRole("button", { name: "notes.visionToTokens" });
		fireEvent.click(first);
		const box = screen.getByLabelText("pipeline.editNote");
		fireEvent.change(box, { target: { value: "Changed" } });
		fireEvent.keyDown(box, { key: "Escape" });
		expect(screen.queryByLabelText("pipeline.editNote")).not.toBeInTheDocument();
		expect(store().notes[0]).toBeUndefined();

		fireEvent.click(screen.getAllByRole("button", { name: "notes.visionToTokens" })[0]);
		const again = screen.getByLabelText("pipeline.editNote");
		fireEvent.keyDown(again, { key: "Enter", shiftKey: true });
		expect(screen.getByLabelText("pipeline.editNote")).toBeInTheDocument();
		fireEvent.change(again, { target: { value: "Ma phrase" } });
		fireEvent.keyDown(again, { key: "Enter" });
		expect(store().notes[0]).toBe("Ma phrase");
		expect(screen.getByRole("button", { name: "Ma phrase" })).toBeInTheDocument();

		// Putting the default sentence back forgets the custom one.
		fireEvent.click(screen.getByRole("button", { name: "Ma phrase" }));
		const last = screen.getByLabelText("pipeline.editNote");
		fireEvent.change(last, { target: { value: "notes.visionToTokens" } });
		fireEvent.blur(last);
		expect(store().notes[0]).toBeUndefined();
	});

	it("opens a step's result and closes it on a second click", () => {
		render(<PipelineGraph />);
		const vision = screen.getByTestId("design-step-vision");
		fireEvent.click(vision);
		expect(store().selectedStep).toBe("vision");
		expect(vision).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(vision);
		expect(store().selectedStep).toBeNull();
	});
});
