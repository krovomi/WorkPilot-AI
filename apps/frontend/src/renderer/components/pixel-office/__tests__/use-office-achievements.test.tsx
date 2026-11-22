import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../../shared/types/task";
import { usePixelOfficeAchievementsStore } from "../../../stores/pixel-office-achievements-store";
import { useOfficeAchievements } from "../use-office-achievements";

function task(overrides: Partial<Task>): Task {
	return {
		id: "t",
		specId: "t",
		projectId: "p",
		title: "t",
		description: "",
		status: "in_progress",
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

const getIncidents = vi.fn();
const api = globalThis as unknown as { electronAPI?: unknown };
const saved = api.electronAPI;

describe("useOfficeAchievements", () => {
	beforeEach(() => {
		usePixelOfficeAchievementsStore.setState({ unlocked: {} });
		getIncidents.mockReset();
		api.electronAPI = { selfHealing: { getIncidents } };
	});

	afterEach(() => {
		api.electronAPI = saved;
	});

	it("records what the project already earned quietly, then toasts what is new", async () => {
		getIncidents.mockResolvedValue({ success: true, data: [{ status: "resolved" }] });
		const shipped = task({ id: "a", status: "done" });
		const other = task({ id: "b", projectId: "elsewhere", qaSignoff: { status: "approved", session: 1 } });
		const { result, rerender } = renderHook((props) => useOfficeAchievements(props), {
			initialProps: { projectId: "p", projectPath: "/p", tasks: [shipped, other], ready: true },
		});

		await waitFor(() =>
			expect(Object.keys(result.current.unlocked)).toEqual(["first-ship", "incident-resolved"]),
		);
		expect(getIncidents).toHaveBeenCalledWith("/p");
		expect(result.current.toast).toBeUndefined();

		rerender({
			projectId: "p",
			projectPath: "/p",
			tasks: [shipped, task({ id: "c", qaSignoff: { status: "approved", session: 1 } })],
			ready: true,
		});
		await waitFor(() => expect(result.current.toast).toBe("qa-first-try"));

		act(() => result.current.dismissToast());
		expect(result.current.toast).toBeUndefined();
	});

	it("reads no incident on a server project's mirror", async () => {
		const { result } = renderHook(() =>
			useOfficeAchievements({
				projectId: "p",
				projectPath: "/mirror",
				tasks: [task({ status: "done" })],
				ready: true,
				remote: true,
			}),
		);
		await waitFor(() => expect(Object.keys(result.current.unlocked)).toEqual(["first-ship"]));
		expect(result.current.incidents).toEqual([]);
		expect(getIncidents).not.toHaveBeenCalled();
	});

	it("waits for the task list before recording anything", async () => {
		getIncidents.mockResolvedValue({ success: true, data: [] });
		const { result, rerender } = renderHook((props) => useOfficeAchievements(props), {
			initialProps: { projectId: "p", projectPath: "/p", tasks: [] as Task[], ready: false },
		});
		await waitFor(() => expect(getIncidents).toHaveBeenCalled());
		expect(usePixelOfficeAchievementsStore.getState().unlocked.p).toBeUndefined();

		rerender({ projectId: "p", projectPath: "/p", tasks: [task({ status: "done" })], ready: true });
		await waitFor(() => expect(result.current.unlocked["first-ship"]).toBeDefined());
		expect(result.current.toast).toBeUndefined();
	});

	it("counts no incident when the runner fails, refuses or is missing", async () => {
		getIncidents.mockRejectedValueOnce(new Error("runner"));
		const { result } = renderHook(() =>
			useOfficeAchievements({ projectId: "p", projectPath: "/p", tasks: [], ready: true }),
		);
		await waitFor(() => expect(usePixelOfficeAchievementsStore.getState().unlocked.p).toEqual({}));

		getIncidents.mockResolvedValueOnce({ success: false });
		act(() => result.current.refresh());
		await waitFor(() => expect(getIncidents).toHaveBeenCalledTimes(2));

		usePixelOfficeAchievementsStore.setState({ unlocked: {} });
		api.electronAPI = {};
		renderHook(() =>
			useOfficeAchievements({ projectId: "q", projectPath: "/q", tasks: [], ready: true }),
		);
		await waitFor(() => expect(usePixelOfficeAchievementsStore.getState().unlocked.q).toEqual({}));
	});

	it("refresh reads the incidents again and toasts one resolved since", async () => {
		getIncidents.mockResolvedValueOnce({ success: true, data: [] });
		const { result } = renderHook(() =>
			useOfficeAchievements({ projectId: "p", projectPath: "/p", tasks: [], ready: true }),
		);
		await waitFor(() => expect(usePixelOfficeAchievementsStore.getState().unlocked.p).toEqual({}));

		getIncidents.mockResolvedValueOnce({
			success: true,
			data: [{ status: "resolved", fix_pr_url: "https://forge/pr/9" }],
		});
		act(() => result.current.refresh());
		await waitFor(() => expect(result.current.toast).toBe("incident-resolved"));
		act(() => result.current.dismissToast());
		expect(result.current.toast).toBe("incident-fixed-by-agent");
	});

	it("drops an answer that arrives for a project no longer shown", async () => {
		let answer: (value: unknown) => void = () => undefined;
		getIncidents.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		getIncidents.mockResolvedValue({ success: true, data: [] });
		const { rerender } = renderHook((props) => useOfficeAchievements(props), {
			initialProps: { projectId: "p", projectPath: "/p", tasks: [] as Task[], ready: true },
		});
		rerender({ projectId: "q", projectPath: "/q", tasks: [], ready: true });
		await waitFor(() => expect(usePixelOfficeAchievementsStore.getState().unlocked.q).toEqual({}));

		await act(async () => answer({ success: true, data: [{ status: "resolved" }] }));
		expect(usePixelOfficeAchievementsStore.getState().unlocked.q).toEqual({});
		expect(usePixelOfficeAchievementsStore.getState().unlocked.p).toBeUndefined();
	});
});
