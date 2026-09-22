import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ReviewWorkspace } from "../ReviewWorkspace";
const { translate } = vi.hoisted(() => ({ translate: (key: string) => key }));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: translate, i18n: { language: "en" } }),
}));
vi.mock("../../ui/code-editor", () => ({
	CodeEditor: ({
		value,
		onSelectionChange,
	}: {
		value: string;
		onSelectionChange: (s: { start: number; end: number }) => void;
	}) => (
		<button
			type="button"
			onClick={() => onSelectionChange({ start: 2, end: 2 })}
		>
			{value}
		</button>
	),
}));
vi.mock("../../ui/resizable-panels", () => ({
	ResizablePanels: ({
		leftPanel,
		rightPanel,
	}: {
		leftPanel: React.ReactNode;
		rightPanel: React.ReactNode;
	}) => (
		<div>
			{leftPanel}
			{rightPanel}
		</div>
	),
}));
beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {
				/* No layout in jsdom. */
			}
			disconnect() {
				/* No layout in jsdom. */
			}
		},
	);
	Object.assign(window.electronAPI, {
		listReviewFiles: vi.fn().mockResolvedValue({
			success: true,
			data: [{ path: "src/example.ts", status: " M" }],
		}),
		readReviewFile: vi.fn().mockResolvedValue({
			success: true,
			data: {
				path: "src/example.ts",
				content: "first\nsecond\nthird\n",
				patch:
					"diff --git a/src/example.ts b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
			},
		}),
	});
});
it("opens a project file and sends an exact selected line with its original location", async () => {
	const review = vi.fn();
	render(
		<ReviewWorkspace
			projectId="p1"
			onReview={review}
			loading={false}
			result={null}
			error={null}
		/>,
	);
	fireEvent.click(
		await screen.findByRole("button", { name: "src/example.ts" }),
	);
	fireEvent.click(await screen.findByText("first second third"));
	fireEvent.click(
		screen.getByRole("button", { name: "workspace.addSelection" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "actions.runReview" }));
	expect(review).toHaveBeenCalledWith(
		expect.stringContaining("@@ -0,0 +2,1 @@\n+second"),
	);
	expect(review).toHaveBeenCalledWith(
		expect.stringContaining("+++ b/src/example.ts"),
	);
});
it("does not show a previous project response after switching projects", async () => {
	let resolve!: (
		value: Awaited<ReturnType<typeof window.electronAPI.listReviewFiles>>,
	) => void;
	vi.mocked(window.electronAPI.listReviewFiles).mockImplementationOnce(
		() =>
			new Promise((r) => {
				resolve = r;
			}),
	);
	const view = render(
		<ReviewWorkspace
			projectId="p1"
			onReview={vi.fn()}
			loading={false}
			result={null}
			error={null}
		/>,
	);
	view.rerender(
		<ReviewWorkspace
			projectId="p2"
			onReview={vi.fn()}
			loading={false}
			result={null}
			error={null}
		/>,
	);
	await screen.findByRole("button", { name: "src/example.ts" });
	resolve({ success: true, data: [{ path: "stale.ts", status: " M" }] });
	await waitFor(() => expect(screen.queryByText("stale.ts")).toBeNull());
});

it("opens the analyzed snapshot even after the comparison scope changes", async () => {
	const review = vi.fn();
	const props = {
		projectId: "p1",
		onReview: review,
		loading: false,
		error: null,
	};
	const screenView = render(<ReviewWorkspace {...props} result={null} />);
	fireEvent.click(
		await screen.findByRole("button", { name: "src/example.ts" }),
	);
	fireEvent.click(await screen.findByText("first second third"));
	fireEvent.click(
		screen.getByRole("button", { name: "workspace.addSelection" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "actions.runReview" }));
	const result = {
		score: 80,
		passed: false,
		issues: [
			{
				file: "src/example.ts",
				line: 2,
				severity: "critical",
				rule: "test",
				message: "Finding",
			},
		],
	};
	screenView.rerender(<ReviewWorkspace {...props} result={result} />);
	vi.mocked(window.electronAPI.readReviewFile).mockResolvedValue({
		success: true,
		data: { path: "src/example.ts", content: "another revision", patch: "" },
	});
	fireEvent.change(
		screen.getByRole("combobox", { name: "workspace.comparison" }),
		{ target: { value: "staged" } },
	);
	await screen.findByText("another revision");
	fireEvent.click(screen.getByRole("button", { name: "src/example.ts:2" }));
	await screen.findByText("first second third");
});
