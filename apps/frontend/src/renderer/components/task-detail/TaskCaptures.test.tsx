/**
 * @vitest-environment jsdom
 *
 * The Captures tab: the task's screens before and after as the PR shows
 * them, where they stand, the buttons that publish, withdraw or update the
 * PR (review mode), and the visual proof when the task has no captures.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import i18n from "../../../shared/i18n";
import type { Task, TaskCapturesSummary } from "../../../shared/types";
import { clearCaptureImageCache } from "../task-captures/useCaptureImage";
import { TaskCaptures } from "./TaskCaptures";

vi.mock("./TaskVisualProof", () => ({
	TaskVisualProof: () => <div data-testid="visual-proof" />,
}));
const persist = vi.fn(async () => true);
vi.mock("../../stores/task-store", () => ({
	persistUpdateTask: (...args: unknown[]) => persist(...(args as [])),
}));

const summary = (patch: Partial<TaskCapturesSummary> = {}): TaskCapturesSummary => ({
	needed: true,
	reason: "ui-files",
	decidedBy: "default",
	uiFiles: ["src/Orders.tsx"],
	publish: "review",
	generatedAt: "2026-11-28T16:00:00+00:00",
	items: [
		{
			key: "web|orders|fr",
			label: "Orders",
			platform: "web",
			variant: "",
			route: "/orders",
			locale: "fr",
			before: { available: true, status: "clean", kinds: [], passes: ["page"], replaced: 0, file: "captures/published/base/a.png" },
			after: {
				available: true,
				status: "pseudonymized",
				kinds: ["email"],
				passes: ["page"],
				replaced: 2,
				file: "captures/published/task/a.png",
			},
			publishable: true,
		},
	],
	publishable: 1,
	withheld: 0,
	approved: false,
	...patch,
});

const task = (captures?: TaskCapturesSummary, metadata: Task["metadata"] = {}): Task => ({
	id: "task-1",
	specId: "001-orders",
	projectId: "p1",
	title: "Orders page",
	description: "",
	status: "human_review",
	subtasks: [],
	logs: [],
	createdAt: new Date(),
	updatedAt: new Date(),
	metadata,
	captures,
});

const api = {
	getTaskCaptures: vi.fn(),
	getTaskCaptureImage: vi.fn(),
	runTaskCapturesAction: vi.fn(),
	openExternal: vi.fn(),
};
Object.defineProperty(window, "electronAPI", { value: api, writable: true });

beforeEach(async () => {
	await i18n.changeLanguage("en");
	clearCaptureImageCache();
	for (const fn of Object.values(api)) fn.mockReset();
	persist.mockClear();
	api.getTaskCaptures.mockResolvedValue({ success: false, error: "Task not found" });
	api.getTaskCaptureImage.mockResolvedValue({ success: true, data: { base64: "AAAA", mimeType: "image/png" } });
});

describe("TaskCaptures", () => {
	it("shows the before and after of each screen and what was replaced by fakes", async () => {
		api.getTaskCaptures.mockResolvedValue({ success: true, data: summary() });
		render(<TaskCaptures task={task(summary())} />);
		expect(screen.getByTestId("captures-state")).toHaveTextContent("Waiting for Publish");
		expect(screen.getByText("Orders")).toBeInTheDocument();
		expect(await screen.findAllByRole("img")).toHaveLength(2);
		expect(api.getTaskCaptureImage).toHaveBeenCalledWith("task-1", "captures/published/task/a.png");
		expect(screen.getByText("2 values replaced by fakes (email).")).toBeInTheDocument();
	});

	it("publishes in review mode, then offers to withdraw", async () => {
		api.getTaskCaptures.mockResolvedValue({ success: true, data: summary() });
		api.runTaskCapturesAction.mockResolvedValue({
			success: true,
			data: { captures: summary({ approved: true }), noPr: false },
		});
		render(<TaskCaptures task={task(summary())} />);
		fireEvent.click(screen.getByRole("button", { name: /Publish in the PR/ }));
		await waitFor(() => expect(api.runTaskCapturesAction).toHaveBeenCalledWith("task-1", "approve"));
		expect(await screen.findByRole("button", { name: /Withdraw from the PR/ })).toBeInTheDocument();
		expect(screen.getByText("Published: the PR shows the captures.")).toBeInTheDocument();
	});

	it("says so when no PR exists yet, and shows a refusal as an error", async () => {
		api.getTaskCaptures.mockResolvedValue({ success: true, data: summary({ publish: "auto" }) });
		api.runTaskCapturesAction.mockResolvedValueOnce({ success: true, data: { noPr: true } });
		render(<TaskCaptures task={task(summary({ publish: "auto" }))} />);
		expect(screen.queryByRole("button", { name: /Publish in the PR/ })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Update the PR/ }));
		expect(await screen.findByText(/No pull request is open/)).toBeInTheDocument();
		api.runTaskCapturesAction.mockResolvedValueOnce({ success: false, error: "timeout" });
		fireEvent.click(screen.getByRole("button", { name: /Update the PR/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The forge took too long to answer.");
	});

	it("offers no action on a server card nor when the project keeps captures on the task", () => {
		render(<TaskCaptures task={{ ...task(summary()), id: "server:p:001-orders" }} />);
		expect(screen.queryByRole("button", { name: /Publish in the PR/ })).not.toBeInTheDocument();
		expect(screen.getByText(/A server card/)).toBeInTheDocument();
	});

	it("shows the visual proof when the task has no captures, and the reason", async () => {
		api.getTaskCaptures.mockResolvedValue({
			success: true,
			data: summary({ needed: false, reason: "no-ui-files", items: [] }),
		});
		render(<TaskCaptures task={task()} />);
		expect(screen.getByTestId("visual-proof")).toBeInTheDocument();
		expect(await screen.findByText(/changes no screen/)).toBeInTheDocument();
	});

	it("opens the visual proof from the captures and comes back", () => {
		render(<TaskCaptures task={task(summary())} />);
		fireEvent.click(screen.getByRole("button", { name: /Visual proof/ }));
		expect(screen.getByTestId("visual-proof")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Back to the captures/ }));
		expect(screen.queryByTestId("visual-proof")).not.toBeInTheDocument();
	});
});
