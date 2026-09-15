/**
 * @vitest-environment jsdom
 */

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import type { Project } from "../../../shared/types";
import { useAppEmulatorStore } from "../../stores/app-emulator-store";
import { TaskEmulator } from "./TaskEmulator";

const project: Project = {
	id: "project-1",
	name: "Demo project",
	path: "C:\\Repos\\Demo",
	autoBuildPath: ".workpilot",
	settings: {
		model: "claude",
		memoryBackend: "file",
		linearSync: false,
		notifications: {
			onTaskComplete: false,
			onTaskFailed: false,
			onReviewNeeded: false,
			sound: false,
		},
		graphitiMcpEnabled: false,
	},
	createdAt: new Date("2026-06-05T08:00:00.000Z"),
	updatedAt: new Date("2026-06-05T08:00:00.000Z"),
};

const noopUnsubscribe = () => {
	/* noop */
};

const mockDetectAppProject = vi.fn();
const mockStartAppEmulator = vi.fn();
const mockStopAppEmulator = vi.fn();
const mockGetWorktreeStatus = vi.fn();

Object.defineProperty(window, "electronAPI", {
	value: {
		getAppEmulatorStatus: vi.fn().mockResolvedValue({
			success: true,
			data: { running: false },
		}),
		getWorktreeStatus: mockGetWorktreeStatus,
		detectAppProject: mockDetectAppProject,
		startAppEmulator: mockStartAppEmulator,
		stopAppEmulator: mockStopAppEmulator,
		openExternal: vi.fn(),
		onAppEmulatorStatus: vi.fn(() => noopUnsubscribe),
		onAppEmulatorReady: vi.fn(() => noopUnsubscribe),
		onAppEmulatorOutput: vi.fn(() => noopUnsubscribe),
		onAppEmulatorError: vi.fn(() => noopUnsubscribe),
		onAppEmulatorStopped: vi.fn(() => noopUnsubscribe),
		onAppEmulatorConfig: vi.fn(() => noopUnsubscribe),
	},
	writable: true,
});

describe("TaskEmulator", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useAppEmulatorStore.getState().reset();
		mockGetWorktreeStatus.mockResolvedValue({
			success: true,
			data: { exists: false },
		});
		mockDetectAppProject.mockResolvedValue({
			success: true,
			data: {
				type: "web",
				framework: "vite",
				startCommand: "pnpm dev",
				port: 5173,
				isWeb: true,
				projectDir: project.path,
			},
		});
		mockStartAppEmulator.mockResolvedValue({ success: true });
	});

	it("starts the emulator for the task project", async () => {
		render(<TaskEmulator taskId="task-1" project={project} />);

		fireEvent.click(screen.getByRole("button", { name: /start server/i }));

		await waitFor(() => {
			expect(mockDetectAppProject).toHaveBeenCalledWith(project.path);
			expect(mockStartAppEmulator).toHaveBeenCalledWith(
				expect.objectContaining({
					framework: "vite",
					projectDir: project.path,
				}),
			);
		});
	});

	it("prefers the task worktree path when it exists", async () => {
		const worktreePath = "C:\\Repos\\Demo\\.worktrees\\spec-1";
		mockGetWorktreeStatus.mockResolvedValue({
			success: true,
			data: { exists: true, worktreePath },
		});
		render(<TaskEmulator taskId="task-1" project={project} />);

		await screen.findByText(new RegExp(worktreePath.replaceAll("\\", "\\\\")));
		fireEvent.click(screen.getByRole("button", { name: /start server/i }));

		await waitFor(() => {
			expect(mockDetectAppProject).toHaveBeenCalledWith(worktreePath);
		});
	});

	it("shows an empty state when the task project cannot be resolved", () => {
		render(<TaskEmulator taskId="task-1" />);

		expect(screen.getByText("Project not found")).toBeInTheDocument();
	});
});

describe("TaskEmulator preview", () => {
	beforeEach(() => {
		useAppEmulatorStore.setState({
			phase: "running",
			url: "http://localhost:5000",
			output: "Server listening",
			config: {
				type: "web",
				framework: "dotnet",
				startCommand: "dotnet run",
				port: 5000,
				isWeb: true,
				projectDir: project.path,
			},
		});
	});
	it("resizes the page and rotates without remounting it", () => {
		const { container } = render(
			<TaskEmulator taskId="task-1" project={project} />,
		);
		const view = container.querySelector("webview");
		fireEvent.change(screen.getByLabelText("Screen format"), {
			target: { value: "phone" },
		});
		expect(view).toHaveStyle({
			width: "390px",
			height: "844px",
			display: "flex",
		});
		fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
		expect(view).toHaveStyle({ width: "844px", height: "390px" });
		expect(container.querySelector("webview")).toBe(view);
	});
	it("reports main frame load failure and keeps server logs accessible", () => {
		const { container } = render(
			<TaskEmulator taskId="task-1" project={project} />,
		);
		const view = container.querySelector("webview");
		if (!view) throw new Error("Missing preview");
		fireEvent(
			view,
			Object.assign(new Event("did-fail-load"), {
				errorCode: -102,
				errorDescription: "ERR_CONNECTION_REFUSED",
				isMainFrame: true,
			}),
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"ERR_CONNECTION_REFUSED",
		);
		fireEvent.click(screen.getByText("Server Output"));
		expect(screen.getByText("Server listening")).toBeVisible();
	});
	it("ignores aborted navigations and subframe errors", () => {
		const { container } = render(
			<TaskEmulator taskId="task-1" project={project} />,
		);
		const view = container.querySelector("webview");
		if (!view) throw new Error("Missing preview");
		fireEvent(
			view,
			Object.assign(new Event("did-fail-load"), {
				errorCode: -3,
				isMainFrame: true,
			}),
		);
		fireEvent(
			view,
			Object.assign(new Event("did-fail-load"), {
				errorCode: -102,
				isMainFrame: false,
			}),
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});

it("explains an HTTP 404 instead of leaving an empty preview", () => {
	useAppEmulatorStore.setState({
		phase: "running",
		url: "http://localhost:5000",
		config: {
			type: "web",
			framework: "dotnet",
			startCommand: "dotnet run",
			port: 5000,
			isWeb: true,
			projectDir: project.path,
		},
	});
	const { container } = render(
		<TaskEmulator taskId="task-1" project={project} />,
	);
	const view = container.querySelector("webview");
	if (!view) throw new Error("Missing preview");
	fireEvent(
		view,
		Object.assign(new Event("did-navigate"), { httpResponseCode: 404 }),
	);
	expect(screen.getByRole("alert")).toHaveTextContent("404");
	expect(screen.getByRole("alert")).toHaveTextContent("API");
});

it("clears a loading timeout after a successful main-frame navigation", async () => {
	vi.useFakeTimers();
	try {
		useAppEmulatorStore.setState({
			phase: "running",
			url: "http://localhost:5000",
			config: {
				type: "web",
				framework: "dotnet",
				startCommand: "dotnet run",
				port: 5000,
				isWeb: true,
				projectDir: project.path,
			},
		});
		const { container, unmount } = render(
			<TaskEmulator taskId="task-1" project={project} />,
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30001);
		});
		expect(screen.getByRole("alert")).toBeInTheDocument();
		const view = container.querySelector("webview");
		if (!view) throw new Error("Missing preview");
		fireEvent(
			view,
			Object.assign(new Event("did-navigate"), { httpResponseCode: 200 }),
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		unmount();
	} finally {
		vi.useRealTimers();
	}
});

it("allows typing a custom width without applying incomplete values", () => {
	useAppEmulatorStore.setState({
		phase: "running",
		url: "http://localhost:5000",
		config: {
			type: "web",
			framework: "dotnet",
			startCommand: "dotnet run",
			port: 5000,
			isWeb: true,
			projectDir: project.path,
		},
	});
	const { container } = render(
		<TaskEmulator taskId="task-1" project={project} />,
	);
	fireEvent.change(screen.getByLabelText("Screen format"), {
		target: { value: "phone" },
	});
	const width = screen.getByLabelText("Width");
	fireEvent.change(width, { target: { value: "" } });
	expect(width).toHaveValue(null);
	fireEvent.change(width, { target: { value: "1" } });
	expect(container.querySelector("webview")).toHaveStyle({ width: "390px" });
	fireEvent.change(width, { target: { value: "1200" } });
	fireEvent.blur(width);
	expect(container.querySelector("webview")).toHaveStyle({ width: "1200px" });
});
