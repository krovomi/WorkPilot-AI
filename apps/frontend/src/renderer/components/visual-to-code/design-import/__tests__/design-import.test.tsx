/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
		i18n: { language: "en" },
	}),
}));

import type { DesignRenderLoop, DesignToCodeResult } from "../../../../../shared/types/design-to-code";
import { useDesignToCodeStore } from "../../../../stores/design-to-code-store";
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
					description: "",
					bounds: { x: 0, y: 0, w: 1, h: 0.1 },
					children: [],
				},
				{ name: "Footer", type: "footer", description: "", children: [] },
			],
			color_palette: {},
			typography: {},
		},
		generated_files: [
			{ path: "src/Header.tsx", content: "header code", language: "tsx", description: "", exists: true },
			{ path: "src/Footer.tsx", content: "footer code", language: "tsx", description: "" },
		],
		visual_tests: [],
		design_tokens_used: [],
		figma_sync_status: null,
		errors: [],
		warnings: [],
		duration_seconds: 2,
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

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe = vi.fn();
		disconnect = vi.fn();
		unobserve = vi.fn();
	} as unknown as typeof ResizeObserver;
});

beforeEach(() => {
	useDesignToCodeStore.setState({ ...useDesignToCodeStore.getInitialState(), notes: {} });
});

describe("PipelineGraph", () => {
	it("opens a step's result and switches the optional steps", () => {
		render(<PipelineGraph />);
		fireEvent.click(screen.getByTestId("design-step-spec"));
		expect(useDesignToCodeStore.getState().selectedStep).toBe("spec");

		const switches = screen.getAllByRole("switch");
		expect(switches).toHaveLength(3);
		fireEvent.click(switches[0]);
		fireEvent.click(switches[1]);
		fireEvent.click(switches[2]);
		expect(useDesignToCodeStore.getState()).toMatchObject({
			useDesignTokens: false,
			renderLoop: false,
			generateTests: false,
		});
	});

	it("follows the render loop on the code step", () => {
		useDesignToCodeStore.setState({
			phase: "render_loop",
			live: {
				...useDesignToCodeStore.getInitialState().live,
				loop: { stage: "correct", iteration: 1, max_iterations: 5, score: 0.8, best: 0 },
			},
		});
		const { rerender } = render(<PipelineGraph />);
		expect(screen.getByText("pipeline.meta.codeLoop")).toBeInTheDocument();

		useDesignToCodeStore.setState({
			phase: "complete",
			result: result({ render_loop: loop() }),
		});
		rerender(<PipelineGraph />);
		expect(screen.getByText("pipeline.meta.codeLoopDone")).toBeInTheDocument();

		useDesignToCodeStore.setState({ result: result({ render_loop: loop({ status: "skipped", iterations: [] }) }) });
		rerender(<PipelineGraph />);
		expect(screen.queryByText("pipeline.meta.codeLoopDone")).toBeNull();
		expect(screen.getByText("pipeline.meta.codeDone")).toBeInTheDocument();
	});

	it("lets the person rewrite the sentence between two steps", () => {
		render(<PipelineGraph />);
		fireEvent.click(screen.getByText("notes.specToCode"));
		const box = screen.getByLabelText("pipeline.editNote");
		fireEvent.change(box, { target: { value: "use our Card component" } });
		fireEvent.keyDown(box, { key: "Enter" });
		expect(useDesignToCodeStore.getState().notes).toEqual({ 2: "use our Card component" });
		expect(screen.getByText("use our Card component")).toBeInTheDocument();
	});
});

describe("ResultInspector", () => {
	it("shows the generated files and tells a canned result apart", () => {
		useDesignToCodeStore.setState({
			phase: "complete",
			result: result({ simulated: true }),
			selectedFilePath: "src/Footer.tsx",
		});
		render(<ResultInspector />);
		expect(screen.getByTestId("design-simulated")).toBeInTheDocument();
		expect(screen.getByTestId("design-code-view")).toHaveTextContent("footer code");
		expect(screen.getByText("inspector.fileExists")).toBeInTheDocument();
	});

	it("shows the loop's step while it runs, then its report above the files", () => {
		const progress = { stage: "render" as const, iteration: 0, max_iterations: 5, score: null, best: null };
		useDesignToCodeStore.setState({
			phase: "render_loop",
			live: { ...useDesignToCodeStore.getInitialState().live, loop: progress },
		});
		const { rerender } = render(<ResultInspector />);
		expect(screen.getByTestId("design-loop-live")).toHaveTextContent("loop.live");
		expect(screen.queryByText("loop.score")).toBeNull();

		useDesignToCodeStore.setState({
			live: { ...useDesignToCodeStore.getInitialState().live, loop: { ...progress, score: 0.9 } },
		});
		rerender(<ResultInspector />);
		expect(screen.getByText("loop.score")).toBeInTheDocument();

		useDesignToCodeStore.setState({ phase: "complete", result: result({ render_loop: loop() }) });
		rerender(<ResultInspector />);
		expect(screen.getByTestId("design-loop")).toBeInTheDocument();
		expect(screen.getByTestId("design-code-view")).toBeInTheDocument();
	});

	it("explains that a stack has no visual tests", () => {
		useDesignToCodeStore.setState({
			phase: "complete",
			selectedStep: "tests",
			result: result({ warnings: ["visual_tests_unsupported"] }),
		});
		render(<ResultInspector />);
		expect(screen.getByText("pipeline.testsUnsupported")).toBeInTheDocument();
	});
});

describe("SourceColumn", () => {
	it("draws the zones that have a position and lights the selected file's", () => {
		useDesignToCodeStore.setState({
			phase: "complete",
			imagePreview: "data:image/png;base64,AAAA",
			imageName: "pricing.png",
			result: result(),
			selectedFilePath: "src/Header.tsx",
		});
		const { container } = render(<SourceColumn />);
		const regions = container.querySelectorAll(".di-region");
		expect(regions).toHaveLength(1);
		expect(regions[0]).toHaveAttribute("data-hot", "true");
		expect(regions[0]).toHaveStyle({ height: "10%" });
	});

	it("refuses a file that is not an image", () => {
		render(<SourceColumn />);
		const input = screen.getByTestId("design-file-input");
		fireEvent.change(input, {
			target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] },
		});
		expect(screen.getByRole("alert")).toHaveTextContent("upload.rejectedType");
	});
});
