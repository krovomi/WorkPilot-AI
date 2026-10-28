/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import type { McpAppViewSummary, Task } from "../../../shared/types";
import { McpAppsCard } from "./McpAppsCard";

const task: Task = {
	id: "task-1",
	specId: "spec-1",
	projectId: "project-1",
	title: "Task with a view",
	description: "",
	status: "in_progress",
	subtasks: [],
	logs: [],
	createdAt: new Date("2026-10-26T08:00:00.000Z"),
	updatedAt: new Date("2026-10-26T09:00:00.000Z"),
};

const summary: McpAppViewSummary = {
	viewId: "0123456789abcdef",
	server: "weather",
	tool: "forecast",
	createdAt: 1_790_000_000,
};

let onView: ((taskId: string, view: McpAppViewSummary) => void) | undefined;
const api = {
	listMcpAppViews: vi.fn(),
	openMcpAppView: vi.fn(),
	closeMcpAppView: vi.fn(),
	onMcpAppView: vi.fn(),
	getAppVersion: vi.fn(),
};
Object.defineProperty(window, "electronAPI", { value: api, writable: true });

describe("McpAppsCard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.listMcpAppViews.mockResolvedValue({ success: true, data: [summary] });
		api.openMcpAppView.mockResolvedValue({
			success: true,
			data: {
				...summary,
				url: "workpilot-mcp-app://aaaa/",
				token: "aaaa",
				toolInput: { city: "Paris" },
				toolResult: { content: [] },
				prefersBorder: true,
			},
		});
		api.closeMcpAppView.mockResolvedValue({ success: true });
		api.getAppVersion.mockResolvedValue("3.0.0");
		api.onMcpAppView.mockImplementation((callback) => {
			onView = callback;
			return () => {
				onView = undefined;
			};
		});
	});

	it("shows nothing without a kept view", async () => {
		api.listMcpAppViews.mockResolvedValue({ success: true, data: [] });
		const { container } = render(<McpAppsCard task={task} />);
		await waitFor(() => expect(api.listMcpAppViews).toHaveBeenCalledWith("task-1"));
		expect(container).toBeEmptyDOMElement();
	});

	it("opens a view in a frame sandboxed without allow-same-origin", async () => {
		render(<McpAppsCard task={task} />);
		fireEvent.click(await screen.findByText(/weather · forecast/));
		const frame = await screen.findByTestId("mcp-app-frame");
		expect(api.openMcpAppView).toHaveBeenCalledWith("task-1", summary.viewId);
		expect(frame).toHaveAttribute("sandbox", "allow-scripts");
		expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
		expect(frame).toHaveAttribute("src", "workpilot-mcp-app://aaaa/");
		expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
	});

	it("closes the view's token when the frame goes away", async () => {
		render(<McpAppsCard task={task} />);
		const row = await screen.findByText(/weather · forecast/);
		fireEvent.click(row);
		await screen.findByTestId("mcp-app-frame");
		fireEvent.click(row);
		await waitFor(() => expect(api.closeMcpAppView).toHaveBeenCalledWith("aaaa"));
	});

	it("answers only its own frame's window", async () => {
		render(<McpAppsCard task={task} />);
		fireEvent.click(await screen.findByText(/weather · forecast/));
		const ask = { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} };
		// The frame is read again on each try: on a slow runner it can be
		// mounted a second time (the view reopened), with a new window.
		const currentWindow = () => (screen.getByTestId("mcp-app-frame") as HTMLIFrameElement).contentWindow as Window;
		await screen.findByTestId("mcp-app-frame");
		const first = vi.spyOn(currentWindow(), "postMessage");
		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: ask, source: window }));
		});
		expect(first).not.toHaveBeenCalled();
		await waitFor(() => {
			const target = currentWindow();
			const posted = vi.spyOn(target, "postMessage");
			act(() => {
				window.dispatchEvent(new MessageEvent("message", { data: ask, source: target }));
			});
			expect(posted).toHaveBeenCalledWith(
				expect.objectContaining({ id: 1, result: expect.objectContaining({ protocolVersion: "2026-01-26" }) }),
				"*",
			);
		});
	});

	it("reloads the list when the build keeps a new view", async () => {
		render(<McpAppsCard task={task} />);
		await screen.findByText(/weather · forecast/);
		api.listMcpAppViews.mockResolvedValue({
			success: true,
			data: [{ ...summary, viewId: "fedcba9876543210", tool: "radar", createdAt: summary.createdAt + 1 }, summary],
		});
		act(() => onView?.("another-task", summary));
		expect(api.listMcpAppViews).toHaveBeenCalledTimes(1);
		act(() => onView?.("task-1", summary));
		expect(await screen.findByText(/weather · radar/)).toBeInTheDocument();
	});
});
