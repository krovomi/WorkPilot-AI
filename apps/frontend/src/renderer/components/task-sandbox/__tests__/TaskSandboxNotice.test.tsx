/**
 * @vitest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskSandboxStatus } from "../../../../shared/types/task-sandbox";
import { useTaskSandboxStore } from "../../../stores/task-sandbox-store";
import { TaskSandboxNotice } from "../TaskSandboxNotice";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) => (values ? `${key}${JSON.stringify(values)}` : key),
	}),
}));

function status(overrides: Partial<TaskSandboxStatus>): TaskSandboxStatus {
	return {
		taskId: "task-1",
		provider: "openai",
		state: "unavailable",
		backend: "bubblewrap",
		reason: "bwrap is not installed",
		network: [],
		...overrides,
	};
}

afterEach(() => {
	act(() => useTaskSandboxStore.getState().replaceAll([]));
});

describe("TaskSandboxNotice", () => {
	it("shows nothing before the build reports its sandbox", () => {
		render(<TaskSandboxNotice taskId="task-1" />);
		expect(screen.queryByTestId("task-sandbox-notice")).toBeNull();
	});

	it("shows nothing while commands are isolated or delegated to the CLI's own sandbox", () => {
		act(() => {
			useTaskSandboxStore.getState().set(status({ state: "isolated", reason: null }));
			useTaskSandboxStore
				.getState()
				.set(status({ provider: "claude", state: "delegated", backend: "Claude Code", reason: null }));
		});
		render(<TaskSandboxNotice taskId="task-1" />);
		expect(screen.queryByTestId("task-sandbox-notice")).toBeNull();
	});

	it("says the commands are not isolated, with each reason in the tooltip", () => {
		act(() => {
			useTaskSandboxStore.getState().set(status({}));
			useTaskSandboxStore.getState().set(status({ provider: "pi", state: "off", backend: null, reason: null }));
		});
		render(<TaskSandboxNotice taskId="task-1" />);
		const notice = screen.getByTestId("task-sandbox-notice");
		expect(notice.textContent).toContain("tasks:sandbox.notIsolated");
		const title = notice.getAttribute("title") ?? "";
		expect(title).toContain("bwrap is not installed");
		expect(title).toContain('tasks:sandbox.off{"provider":"pi"}');
	});

	it("finds a build reported under its spec id", () => {
		act(() => useTaskSandboxStore.getState().set(status({ taskId: "001-feature" })));
		render(<TaskSandboxNotice taskId="uuid-123" specId="001-feature" />);
		expect(screen.getByTestId("task-sandbox-notice")).toBeTruthy();
	});
});
