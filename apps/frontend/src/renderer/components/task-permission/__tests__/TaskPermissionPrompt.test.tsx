/**
 * The question an ACP agent waits on, on its card: one button per option the
 * agent offered, and the answer sent with the ids main will check again.
 *
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

import type { TaskPermissionRequest } from "../../../../shared/types/task-permission";
import { useTaskPermissionStore } from "../../../stores/task-permission-store";
import { TaskPermissionPrompt } from "../TaskPermissionPrompt";

const REQUEST: TaskPermissionRequest = {
	requestId: "5f0e6c1a-2b3c-4d5e-8f90-a1b2c3d4e5f6",
	taskId: "task-1",
	agent: "Gemini CLI",
	title: "Shell: npm install",
	kind: "execute",
	options: [
		{ optionId: "cancel", name: "Reject", kind: "reject_once" },
		{ optionId: "proceed_once", name: "Allow", kind: "allow_once" },
	],
	locations: [],
	expiresAt: "2026-10-26T12:30:00+00:00",
};

const answerTaskPermission = vi.fn();

beforeEach(() => {
	answerTaskPermission.mockReset();
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = { answerTaskPermission };
	act(() => useTaskPermissionStore.getState().replaceAll([]));
});

afterEach(() => {
	delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("TaskPermissionPrompt", () => {
	it("shows nothing while the task waits on no question", () => {
		const { container } = render(<TaskPermissionPrompt taskId="task-1" />);
		expect(container.innerHTML).toBe("");
	});

	it("shows the agent's question with its options, allow first", () => {
		act(() => useTaskPermissionStore.getState().add(REQUEST));
		render(<TaskPermissionPrompt taskId="task-1" />);
		expect(screen.getByText("Shell: npm install")).toBeTruthy();
		expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Allow", "Reject"]);
	});

	it("finds the question under the spec id too", () => {
		act(() => useTaskPermissionStore.getState().add({ ...REQUEST, taskId: "001-login" }));
		render(<TaskPermissionPrompt taskId="uuid" specId="001-login" />);
		expect(screen.getByText("Shell: npm install")).toBeTruthy();
	});

	it("sends the chosen option and leaves the question until the build resolves it", async () => {
		answerTaskPermission.mockResolvedValue({ ok: true });
		act(() => useTaskPermissionStore.getState().add(REQUEST));
		render(<TaskPermissionPrompt taskId="task-1" />);
		fireEvent.click(screen.getByText("Allow"));
		await waitFor(() =>
			expect(answerTaskPermission).toHaveBeenCalledWith("task-1", REQUEST.requestId, "proceed_once"),
		);
		expect(useTaskPermissionStore.getState().byTask["task-1"]).toHaveLength(1);
	});

	it("says why an answer was refused, and drops a question nobody waits for", async () => {
		answerTaskPermission.mockResolvedValue({ ok: false, reason: "process_gone" });
		act(() => useTaskPermissionStore.getState().add(REQUEST));
		const { container } = render(<TaskPermissionPrompt taskId="task-1" />);
		fireEvent.click(screen.getByText("Reject"));
		await waitFor(() => expect(useTaskPermissionStore.getState().byTask["task-1"]).toBeUndefined());
		expect(container.innerHTML).toBe("");
	});

	it("keeps the question after an option main refused", async () => {
		answerTaskPermission.mockResolvedValue({ ok: false, reason: "invalid_option" });
		act(() => useTaskPermissionStore.getState().add(REQUEST));
		render(<TaskPermissionPrompt taskId="task-1" />);
		fireEvent.click(screen.getByText("Allow"));
		await waitFor(() => expect(screen.getByText("tasks:permission.failure.invalid_option")).toBeTruthy());
	});

	it("does not open the card when a button is pressed", () => {
		const onCardClick = vi.fn();
		answerTaskPermission.mockResolvedValue({ ok: true });
		act(() => useTaskPermissionStore.getState().add(REQUEST));
		render(<TaskPermissionPrompt taskId="task-1" />);
		// The card listens above the prompt.
		document.body.addEventListener("click", onCardClick);
		fireEvent.click(screen.getByText("Allow"));
		document.body.removeEventListener("click", onCardClick);
		expect(onCardClick).not.toHaveBeenCalled();
	});
});
