/**
 * Import Design: the pipeline steps follow the runner's phases, a detected
 * stack never overrides the person's choice, and only the files they accept
 * are sent to the project, by id.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../project-store", () => ({
	useProjectStore: { getState: () => ({ selectedProjectId: "p1" }) },
}));

import type { DesignStackDetection, DesignToCodeResult } from "../../../shared/types/design-to-code";
import { buildDesignTaskDescription } from "../../components/visual-to-code/design-import/design-task";
import { stepOfPhase, stepStates } from "../../lib/design-import-steps";
import {
	detectDesignStack,
	runDesignToCodePipeline,
	useDesignToCodeStore,
	writeDesignFilesToProject,
} from "../design-to-code-store";

const api = {
	runDesignToCodePipeline: vi.fn(),
	detectDesignStack: vi.fn(),
	writeDesignFiles: vi.fn(),
};

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
					children: [{ name: "Logo", type: "image" }],
				},
			],
			color_palette: { primary: "#6d5efc" },
			typography: {},
		},
		generated_files: [{ path: "src/Header.tsx", content: "export {}", language: "tsx", description: "" }],
		visual_tests: [
			{ name: "header.spec.ts", path: "tests/visual/header.spec.ts", test_code: "test()", description: "", threshold: 0.01 },
			{ name: "pathless", test_code: "x", description: "", threshold: 0.01 },
		],
		design_tokens_used: [],
		figma_sync_status: null,
		errors: [],
		warnings: [],
		duration_seconds: 3,
		tokens_used: 0,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	(globalThis as unknown as { electronAPI: typeof api }).electronAPI = api;
	useDesignToCodeStore.setState({
		...useDesignToCodeStore.getInitialState(),
		notes: {},
	});
});

describe("stepStates", () => {
	const base = { useDesignTokens: true, generateTests: true, testsSupported: true, written: false };

	it("maps every runner phase to a step", () => {
		expect(stepOfPhase("analyzing")).toBe("vision");
		expect(stepOfPhase("code_generation")).toBe("code");
		expect(stepOfPhase("figma_sync")).toBe("project");
		expect(stepOfPhase("unknown")).toBeNull();
	});

	it("marks earlier steps done and the current one running", () => {
		const states = stepStates({ ...base, phase: "spec_generation" });
		expect(states).toMatchObject({ vision: "done", tokens: "done", spec: "running", code: "pending" });
	});

	it("shows switched-off and unsupported steps as such, even when complete", () => {
		const states = stepStates({ ...base, phase: "complete", useDesignTokens: false, testsSupported: false });
		expect(states).toMatchObject({ tokens: "off", tests: "unsupported", code: "done", project: "ready" });
		expect(stepStates({ ...base, phase: "complete", written: true }).project).toBe("done");
	});

	it("puts the error on the step that was running", () => {
		const states = stepStates({ ...base, phase: "error", failedStep: "code" });
		expect(states).toMatchObject({ spec: "done", code: "error", tests: "pending" });
	});
});

describe("design-to-code store", () => {
	it("takes the detected stack unless the person chose one", () => {
		const detection: DesignStackDetection = {
			stack: "flutter",
			style: null,
			evidence: ["pubspec.yaml"],
			designSystemPath: "lib/theme",
		};
		useDesignToCodeStore.getState().applyDetection(detection);
		expect(useDesignToCodeStore.getState()).toMatchObject({ framework: "flutter", designSystemPath: "lib/theme" });

		useDesignToCodeStore.setState({ framework: "vue", stackChosen: true, designSystemPath: "src/ui" });
		useDesignToCodeStore.getState().applyDetection(detection);
		expect(useDesignToCodeStore.getState()).toMatchObject({ framework: "vue", designSystemPath: "src/ui" });
	});

	it("follows progress during a run and ignores it outside one", () => {
		const store = useDesignToCodeStore.getState();
		store.applyProgress({ phase: "code_generation", status: "", detail: {} });
		expect(useDesignToCodeStore.getState().phase).toBe("idle");

		store.startPipeline();
		const spec = { components: [{ name: "Hero", type: "section", children: [] }], palette: {}, typography: {} };
		store.applyProgress({ phase: "design_token_integration", status: "", detail: { spec } });
		store.applyProgress({ phase: "spec_generation", status: "", detail: { tokens: 7 } });
		store.applyProgress({ phase: "spec_generation", status: "", detail: {} });
		store.applyProgress({ phase: "complete", status: "", detail: {} });
		const state = useDesignToCodeStore.getState();
		expect(state.phase).toBe("spec_generation");
		expect(state.live).toMatchObject({ spec, tokens: 7 });
		expect(state.journal.map((j) => j.phase)).toEqual([
			"analyzing",
			"design_token_integration",
			"spec_generation",
			"complete",
		]);
	});

	it("keeps an edited sentence and restores the default when cleared", () => {
		useDesignToCodeStore.getState().setNote(1, "  reuse our tokens  ");
		expect(useDesignToCodeStore.getState().notes).toEqual({ 1: "reuse our tokens" });
		useDesignToCodeStore.getState().setNote(1, "   ");
		expect(useDesignToCodeStore.getState().notes).toEqual({});
	});

	it("refuses to run without an image or a Figma link", async () => {
		await runDesignToCodePipeline();
		expect(api.runDesignToCodePipeline).not.toHaveBeenCalled();
		expect(useDesignToCodeStore.getState().error).toBe("missing_input");
	});

	it("sends the project by id and lands on the code", async () => {
		useDesignToCodeStore.setState({ imageData: "data:image/png;base64,AAAA", framework: "maui" });
		api.runDesignToCodePipeline.mockResolvedValue(result());
		await runDesignToCodePipeline();
		expect(api.runDesignToCodePipeline).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "p1", framework: "maui" }),
		);
		expect(useDesignToCodeStore.getState()).toMatchObject({
			phase: "complete",
			selectedStep: "code",
			selectedFilePath: "src/Header.tsx",
		});
	});

	it("records the failed step when the run fails", async () => {
		useDesignToCodeStore.setState({ imageData: "data:image/png;base64,AAAA" });
		api.runDesignToCodePipeline.mockImplementation(async () => {
			useDesignToCodeStore.getState().applyProgress({ phase: "code_generation", status: "", detail: {} });
			return result({ success: false, errors: ["model refused"] });
		});
		await runDesignToCodePipeline();
		expect(useDesignToCodeStore.getState()).toMatchObject({
			phase: "error",
			failedStep: "code",
			error: "model refused",
		});
	});

	it("writes the files and the tests that have a path", async () => {
		useDesignToCodeStore.setState({ result: result() });
		api.writeDesignFiles.mockResolvedValue({ written: [], refused: [] });
		await writeDesignFilesToProject();
		expect(api.writeDesignFiles).toHaveBeenCalledWith("p1", [
			{ path: "src/Header.tsx", content: "export {}" },
			{ path: "tests/visual/header.spec.ts", content: "test()" },
		]);
		expect(useDesignToCodeStore.getState()).toMatchObject({ selectedStep: "project", writing: false });
	});

	it("survives a project whose stack cannot be read", async () => {
		api.detectDesignStack.mockRejectedValue(new Error("boom"));
		await detectDesignStack("p1");
		expect(useDesignToCodeStore.getState().detection).toBeNull();
	});
});

describe("buildDesignTaskDescription", () => {
	const t = ((key: string, opts?: Record<string, string>) =>
		opts ? `${key} ${JSON.stringify(opts)}` : key) as unknown as Parameters<
		typeof buildDesignTaskDescription
	>[1];

	it("carries the components, the palette and the code", () => {
		const text = buildDesignTaskDescription(
			{ framework: "blazor", style: null, customInstructions: "use MudBlazor", result: result() },
			t,
		);
		expect(text).toContain("use MudBlazor");
		expect(text).toContain("- Header (navigation): Logo");
		expect(text).toContain("primary: #6d5efc");
		expect(text).toContain("### src/Header.tsx");
	});

	it("caps the code and lists the rest by path", () => {
		const big = "x".repeat(50_000);
		const text = buildDesignTaskDescription(
			{
				framework: "react",
				style: "tailwind",
				customInstructions: "",
				result: result({
					generated_files: [
						{ path: "a.tsx", content: big, language: "tsx", description: "" },
						{ path: "b.tsx", content: "b", language: "tsx", description: "" },
					],
				}),
			},
			t,
		);
		expect(text.length).toBeLessThan(42_000);
		expect(text).toContain("- b.tsx");
	});
});
