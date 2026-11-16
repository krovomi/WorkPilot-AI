/**
 * Analyze & Group Issues, driven by the hook the view uses: the analysis
 * runs in the main process, its events come back, the person picks batches
 * and single issues, and approving creates one task per pick.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AnalyzePreviewResult,
	ProposedBatch,
} from "../../../../../preload/api/modules/github-api";
import { useAnalyzePreview } from "../../hooks/useAnalyzePreview";
import { BatchReviewWizard } from "../BatchReviewWizard";

const createTask = vi.hoisted(() => vi.fn());
vi.mock("../../../../stores/task-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../stores/task-store")>()),
	createTask,
}));

type Listener = (...args: unknown[]) => void;
let listeners: Record<string, Listener[]>;
const on = (name: string) =>
	vi.fn((cb: Listener) => {
		listeners[name] = [...(listeners[name] ?? []), cb];
		return () => {
			listeners[name] = (listeners[name] ?? []).filter((l) => l !== cb);
		};
	});
const emit = (name: string, ...args: unknown[]) =>
	act(() => {
		for (const cb of listeners[name] ?? []) cb(...args);
	});

function batch(theme: string, numbers: number[], overrides: Partial<ProposedBatch> = {}): ProposedBatch {
	return {
		primaryIssue: numbers[0],
		issues: numbers.map((n, i) => ({
			issueNumber: n,
			title: `Issue ${n}`,
			labels: [],
			similarityToPrimary: i === 0 ? 1 : 0.8,
		})),
		issueCount: numbers.length,
		commonThemes: ["login"],
		validated: true,
		confidence: 0.9,
		reasoning: `Why ${theme}`,
		theme,
		...overrides,
	};
}

function result(overrides: Partial<AnalyzePreviewResult> = {}): AnalyzePreviewResult {
	return {
		success: true,
		totalIssues: 20,
		analyzedIssues: 20,
		alreadyBatched: 0,
		// The first one is not validated: only the second starts selected.
		proposedBatches: [
			batch("Auth flow", [5, 6], { validated: false, confidence: 0.5 }),
			batch("Crash on save", [7, 8, 9], { confidence: 0.7, commonThemes: [] }),
		],
		singleIssues: Array.from({ length: 12 }, (_, i) => ({
			issueNumber: 100 + i,
			title: `Alone ${100 + i}`,
			labels: ["bug"],
		})),
		message: "",
		...overrides,
	};
}

function Harness() {
	const preview = useAnalyzePreview({ projectId: "p1" });
	return (
		<>
			<button type="button" onClick={preview.openWizard}>
				open
			</button>
			<BatchReviewWizard
				isOpen={preview.isWizardOpen}
				onClose={preview.closeWizard}
				projectId="p1"
				onStartAnalysis={preview.startAnalysis}
				onApproveBatches={preview.approveBatches}
				analysisProgress={preview.analysisProgress}
				analysisResult={preview.analysisResult}
				analysisError={preview.analysisError}
				isAnalyzing={preview.isAnalyzing}
				isApproving={preview.isApproving}
			/>
		</>
	);
}

let github: Record<string, ReturnType<typeof vi.fn>>;

async function openAndAnalyze(analysis = result()) {
	render(<Harness />);
	await userEvent.click(screen.getByRole("button", { name: "open" }));
	await userEvent.click(screen.getByRole("button", { name: "Start Analysis" }));
	emit("complete", "p1", analysis);
}

describe("BatchReviewWizard", () => {
	beforeEach(() => {
		listeners = {};
		createTask.mockReset();
		createTask.mockResolvedValue({ id: "t" });
		github = {
			analyzeIssuesPreview: vi.fn(),
			approveBatches: vi.fn().mockResolvedValue({ success: true }),
			onAnalyzePreviewProgress: on("progress"),
			onAnalyzePreviewComplete: on("complete"),
			onAnalyzePreviewError: on("error"),
		};
		Object.assign(globalThis.electronAPI, { github });
	});

	it("runs the analysis and follows its progress", async () => {
		render(<Harness />);
		await userEvent.click(screen.getByRole("button", { name: "open" }));
		expect(screen.getByText("Analyze open issues and group similar ones for batch processing.")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Start Analysis" }));
		expect(github.analyzeIssuesPreview).toHaveBeenCalledWith("p1", undefined, 200);
		expect(screen.getByText("Computing similarity and validating batches...")).toBeInTheDocument();

		// Another project's events are not this one's.
		emit("progress", "p2", { phase: "analyzing", progress: 90, message: "elsewhere" });
		expect(screen.queryByText("elsewhere")).not.toBeInTheDocument();

		emit("progress", "p1", { phase: "analyzing", progress: 40, message: "Embedding issues" });
		expect(screen.getByText("Embedding issues")).toBeInTheDocument();
		expect(screen.getByText("40% complete")).toBeInTheDocument();
	});

	it("shows why an analysis failed and lets it run again", async () => {
		render(<Harness />);
		await userEvent.click(screen.getByRole("button", { name: "open" }));
		await userEvent.click(screen.getByRole("button", { name: "Start Analysis" }));

		emit("error", "p2", { error: "not mine" });
		expect(screen.queryByText("not mine")).not.toBeInTheDocument();
		emit("error", "p1", { error: "Rate limited" });

		expect(screen.getByText("Rate limited")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Start Analysis" }));
		expect(github.analyzeIssuesPreview).toHaveBeenCalledTimes(2);
		expect(screen.queryByText("Rate limited")).not.toBeInTheDocument();
	});

	it("selects the validated batches, whatever their place in the list", async () => {
		await openAndAnalyze();

		expect(screen.getByText("Review and approve the proposed issue batches.")).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: "Crash on save" })).toBeChecked();
		expect(screen.getByRole("checkbox", { name: "Auth flow" })).not.toBeChecked();
		expect(screen.getByText("1 batch selected (3 issues)")).toBeInTheDocument();
		expect(screen.getByText("2 issues")).toBeInTheDocument();
		expect(screen.getByText("...and 2 more")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Approve & Create (1 batch)" })).toBeEnabled();
	});

	it("shows what a batch holds when it is opened", async () => {
		await openAndAnalyze();

		expect(screen.queryByText("Why Auth flow")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Auth flow" }));
		expect(screen.getByText("Why Auth flow")).toBeInTheDocument();
		expect(screen.getByText("80% similar")).toBeInTheDocument();
		expect(screen.getByText("login")).toBeInTheDocument();
		expect(screen.getByText("50%")).toHaveClass("text-destructive");

		await userEvent.click(screen.getByRole("button", { name: "Auth flow" }));
		expect(screen.queryByText("Why Auth flow")).not.toBeInTheDocument();
	});

	it("names a batch without a theme by its place", async () => {
		await openAndAnalyze(result({ proposedBatches: [batch("", [1, 2], { confidence: 0.95 })] }));
		expect(screen.getByRole("checkbox", { name: "Batch 1" })).toBeChecked();
		expect(screen.getByText("95%")).toHaveClass("text-success");
	});

	it("selects every single issue when nothing was grouped", async () => {
		await openAndAnalyze(
			result({ proposedBatches: [], singleIssues: [{ issueNumber: 3, title: "Typo", labels: [] }] }),
		);
		expect(screen.getByRole("checkbox", { name: "#3 Typo" })).toBeChecked();
		expect(screen.getByText(/\+ 1 single issue/)).toBeInTheDocument();
	});

	it("selects and clears everything, and toggles one pick at a time", async () => {
		await openAndAnalyze();
		const approve = () => screen.getByRole("button", { name: /^Approve & Create/ });

		await userEvent.click(screen.getByRole("button", { name: "Deselect All" }));
		expect(approve()).toBeDisabled();

		await userEvent.click(screen.getByRole("checkbox", { name: "Auth flow" }));
		await userEvent.click(screen.getByText("Alone 100"));
		expect(screen.getByRole("checkbox", { name: "#100 Alone 100" })).toBeChecked();
		expect(approve()).toHaveTextContent("Approve & Create (2 batches)");
		await userEvent.click(screen.getByRole("checkbox", { name: "#100 Alone 100" }));
		await userEvent.click(screen.getByRole("checkbox", { name: "Auth flow" }));
		expect(approve()).toBeDisabled();

		await userEvent.click(screen.getByRole("button", { name: "Select All" }));
		expect(approve()).toHaveTextContent("Approve & Create (14 batches)");
	});

	it("creates one task per batch and per single issue picked", async () => {
		await openAndAnalyze();
		await userEvent.click(screen.getByText("Alone 101"));

		await userEvent.click(screen.getByRole("button", { name: "Approve & Create (2 batches)" }));

		expect(await screen.findByText("Batches Created")).toBeInTheDocument();
		const [projectId, approved] = github.approveBatches.mock.calls[0];
		expect(projectId).toBe("p1");
		expect((approved as ProposedBatch[]).map((b) => b.primaryIssue)).toEqual([7, 101]);
		expect(createTask).toHaveBeenCalledTimes(2);
		const [, title, description, metadata] = createTask.mock.calls[0];
		expect(title).toBe("Crash on save");
		expect(description).toContain("- #8: Issue 8");
		expect(description).toContain("**Common themes:** N/A");
		expect(metadata).toMatchObject({ githubIssueNumbers: [7, 8, 9], githubIssueNumber: undefined });
		expect(createTask.mock.calls[1].slice(1)).toEqual([
			"Alone 101",
			"Alone 101",
			expect.objectContaining({ githubIssueNumber: 101, githubIssueNumbers: [101] }),
		]);

		// The step's own Close, not the dialog's corner X.
		const close = screen.getAllByRole("button", { name: "Close" }).find((b) => b.textContent?.trim());
		await userEvent.click(close as HTMLElement);
		expect(screen.queryByText("Batches Created")).not.toBeInTheDocument();
	});

	it("keeps the selection and says why when the tasks cannot be created", async () => {
		github.approveBatches.mockResolvedValue({ success: false, error: "Disk full" });
		await openAndAnalyze();
		await userEvent.click(screen.getByText("Alone 102"));

		await userEvent.click(screen.getByRole("button", { name: "Approve & Create (2 batches)" }));

		expect(await screen.findByText("Disk full")).toBeInTheDocument();
		expect(screen.queryByText("Creating Batches...")).not.toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: "#102 Alone 102" })).toBeChecked();
		expect(screen.getByRole("checkbox", { name: "Crash on save" })).toBeChecked();
		expect(createTask).not.toHaveBeenCalled();
	});

	it("falls back to its own words when the failure has none", async () => {
		github.approveBatches.mockResolvedValue({ success: false });
		await openAndAnalyze();
		await userEvent.click(screen.getByRole("button", { name: "Approve & Create (1 batch)" }));
		expect(await screen.findByText("Could not create the tasks of these batches")).toBeInTheDocument();

		createTask.mockRejectedValueOnce("no reason");
		github.approveBatches.mockResolvedValue({ success: true });
		await userEvent.click(screen.getByRole("button", { name: "Approve & Create (1 batch)" }));
		await waitFor(() => expect(createTask).toHaveBeenCalled());
		expect(screen.getByText("Could not create the tasks of these batches")).toBeInTheDocument();
	});

	it("starts again from the beginning once closed", async () => {
		await openAndAnalyze();
		const dialog = screen.getByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "open" }));
		expect(screen.getByRole("button", { name: "Start Analysis" })).toBeInTheDocument();
	});
});
