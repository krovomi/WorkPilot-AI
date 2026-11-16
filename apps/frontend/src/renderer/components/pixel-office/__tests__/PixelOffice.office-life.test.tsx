/**
 * The office as a whole: the trophy and its toast, TV mode with its calm
 * switch and minute refresh, and the waiting queue holding still when calm.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../../shared/types/task";
import { usePixelOfficeAchievementsStore } from "../../../stores/pixel-office-achievements-store";
import { usePixelOfficeStore } from "../../../stores/pixel-office-store";
import { useTaskStore } from "../../../stores/task-store";
import { TooltipProvider } from "../../ui/tooltip";
import { PixelOffice } from "../PixelOffice";
import { KIOSK_REFRESH_MS } from "../use-kiosk-mode";

function task(overrides: Partial<Task>): Task {
	return {
		id: "t",
		specId: "t",
		projectId: "p",
		title: "Task",
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
const getTasks = vi.fn();
let resize: ResizeObserverCallback = () => undefined;
const api = globalThis as unknown as { electronAPI?: unknown };
const saved = api.electronAPI;

function office() {
	return render(
		<TooltipProvider>
			<PixelOffice projectPath="/p" projectId="p" />
		</TooltipProvider>,
	);
}

describe("PixelOffice", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
		getIncidents.mockReset().mockResolvedValue({ success: true, data: [] });
		getTasks.mockReset().mockResolvedValue({ success: true, data: [] });
		api.electronAPI = { selfHealing: { getIncidents }, getTasks };
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(cb: ResizeObserverCallback) {
					resize = cb;
				}
				observe() {
					// Sizes are pushed by the test through `resize`.
				}
				disconnect() {
					// Nothing to stop.
				}
			},
		);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
		usePixelOfficeAchievementsStore.setState({ unlocked: {} });
		usePixelOfficeStore.setState({
			agents: [],
			selectedAgentId: null,
			settings: { ...usePixelOfficeStore.getState().settings, calmMode: false },
		});
		useTaskStore.setState({
			isLoading: false,
			tasks: [
				task({ id: "run", status: "in_progress", executionProgress: { phase: "coding" } as Task["executionProgress"] }),
				task({ id: "ask", status: "human_review" }),
				task({ id: "queued", status: "backlog" }),
				task({ id: "shipped", status: "done" }),
			],
		});
	});

	afterEach(() => {
		api.electronAPI = saved;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("shows the trophy with what the project earned, and toasts a new one", async () => {
		office();
		await waitFor(() =>
			expect(usePixelOfficeAchievementsStore.getState().unlocked.p).toEqual({
				"first-ship": expect.any(String),
			}),
		);
		expect(
			screen.getByRole("button", { name: "Show the project's achievements" }).textContent,
		).toContain("1/");
		expect(screen.queryByTestId("achievement-toast")).toBeNull();

		act(() => {
			useTaskStore.setState({
				tasks: [
					...useTaskStore.getState().tasks,
					task({ id: "clean", status: "done", qaSignoff: { status: "approved", session: 1 } }),
				],
			});
		});
		expect(await screen.findByTestId("achievement-toast")).toBeTruthy();
		expect(screen.getByText("Right the first time")).toBeTruthy();
	});

	it("sizes the canvas from its own area", async () => {
		const { container } = office();
		await waitFor(() => expect(container.querySelector("canvas")).toBeTruthy());
		act(() =>
			resize(
				[{ contentRect: { width: 640.7, height: 480.2 } } as ResizeObserverEntry],
				{} as ResizeObserver,
			),
		);
		const canvas = container.querySelector("canvas") as HTMLCanvasElement;
		expect(canvas.style.width).toBe("640px");
		expect(canvas.style.height).toBe("480px");
	});

	it("TV mode shows the big numbers, refreshes every minute and switches calm", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		office();
		fireEvent.click(screen.getByRole("button", { name: "TV mode" }));

		const overlay = await screen.findByTestId("kiosk-overlay");
		expect(overlay).toBeTruthy();
		expect(screen.getByRole("button", { name: "TV mode" }).closest(".hidden")).toBeTruthy();
		expect(screen.getByTestId("kiosk-active").textContent).toBe("2");
		expect(screen.getByTestId("kiosk-waiting").textContent).toBe("1");
		expect(screen.getByTestId("kiosk-shippedToday").textContent).toBe("1");

		// The queue's header dot, first in the row that holds its title.
		const pulse = () => {
			const row = screen.getByText("Waiting to start").parentElement as HTMLElement;
			return (row.firstElementChild as HTMLElement).style.animation;
		};
		expect(pulse()).toContain("pulse");

		// The refresh reads the same board back.
		getTasks.mockResolvedValue({ success: true, data: useTaskStore.getState().tasks });
		const incidentsBefore = getIncidents.mock.calls.length;
		await act(async () => {
			vi.advanceTimersByTime(KIOSK_REFRESH_MS);
		});
		expect(getTasks).toHaveBeenCalledWith("p", undefined);
		expect(getIncidents.mock.calls.length).toBeGreaterThan(incidentsBefore);

		fireEvent.click(screen.getByRole("button", { name: "Calm mode" }));
		expect(usePixelOfficeStore.getState().settings.calmMode).toBe(true);
		expect(pulse()).toBe("none");

		fireEvent.click(screen.getByRole("button", { name: "Leave TV mode" }));
		expect(screen.queryByTestId("kiosk-overlay")).toBeNull();
	});

	it("TV mode cannot lift the system's reduced motion", async () => {
		vi.stubGlobal("matchMedia", () => ({
			matches: true,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		}));
		office();
		fireEvent.click(screen.getByRole("button", { name: "TV mode" }));
		const button = (await screen.findByRole("button", { name: "Animations" })) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
	});
});
