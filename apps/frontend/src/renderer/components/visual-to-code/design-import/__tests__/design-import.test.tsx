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

import type { DesignToCodeResult } from "../../../../../shared/types/design-to-code";
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
		expect(switches).toHaveLength(2);
		fireEvent.click(switches[0]);
		fireEvent.click(switches[1]);
		expect(useDesignToCodeStore.getState()).toMatchObject({ useDesignTokens: false, generateTests: false });
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
