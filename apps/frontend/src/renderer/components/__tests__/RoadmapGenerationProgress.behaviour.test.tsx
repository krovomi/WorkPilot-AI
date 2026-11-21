/** @vitest-environment jsdom */
/**
 * The roadmap generation progress, as the person sees it: the phase and its
 * steps, the progress bar, the elapsed time and the last activity in the
 * app's language, the stop button, and the reduced motion preference.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { RoadmapGenerationStatus } from "../../../shared/types/roadmap";
import { RoadmapGenerationProgress } from "../RoadmapGenerationProgress";
import { TooltipProvider } from "../ui/tooltip";

const NOW = new Date("2026-11-16T12:00:00Z").getTime();
let mediaListeners: Array<(event: { matches: boolean }) => void> = [];
let prefersReduced = false;

beforeEach(async () => {
	mediaListeners = [];
	prefersReduced = false;
	globalThis.matchMedia = vi.fn(() => ({
		get matches() {
			return prefersReduced;
		},
		addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => mediaListeners.push(fn),
		removeEventListener: (_: string, fn: (event: { matches: boolean }) => void) => {
			mediaListeners = mediaListeners.filter((l) => l !== fn);
		},
	})) as never;
	await i18n.changeLanguage("en");
	vi.useFakeTimers({ now: NOW, toFake: ["setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const view = (status: Partial<RoadmapGenerationStatus>, onStop?: () => void | Promise<void>) =>
	render(
		<TooltipProvider>
			<RoadmapGenerationProgress
				generationStatus={{ phase: "analyzing", progress: 0, message: "", ...status }}
				onStop={onStop}
			/>
		</TooltipProvider>,
	);

describe("RoadmapGenerationProgress", () => {
	it("shows nothing while idle", () => {
		const { container } = view({ phase: "idle" });
		expect(container).toBeEmptyDOMElement();
	});

	it.each([
		["analyzing", "Analyzing", "Analyzing project structure and codebase..."],
		["discovering", "Discovering", "Discovering target audience and user needs..."],
		["generating", "Generating", "Generating feature roadmap..."],
	] as const)("names the %s phase, its progress and its steps", (phase, label, description) => {
		view({ phase, progress: 40, message: "Reading 12 files" });
		expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
		expect(screen.getByText(description)).toBeInTheDocument();
		expect(screen.getByText("Reading 12 files")).toBeInTheDocument();
		expect(screen.getByText("40%")).toBeInTheDocument();
		expect(screen.getByText("Processing")).toBeInTheDocument();
		expect(screen.getByText("Analyze")).toBeInTheDocument();
	});

	it("hides a message that only repeats the description, and shows an error", () => {
		view({ phase: "error", message: "Generation failed", error: "model refused" });
		expect(screen.getAllByText("Generation failed")).toHaveLength(1);
		expect(screen.getByText("model refused")).toBeInTheDocument();
		expect(screen.queryByText("Progress")).not.toBeInTheDocument();
		expect(screen.getByText("Analyze")).toHaveClass("text-destructive");
	});

	it("marks every step done once complete, without a progress bar or stop button", () => {
		view({ phase: "complete", progress: 100 }, vi.fn());
		expect(screen.getByRole("heading", { name: "Complete" })).toBeInTheDocument();
		for (const step of ["Analyze", "Discover", "Generate"]) expect(screen.getByText(step)).toHaveClass("text-success");
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("marks the steps before the current one done and those after it pending", () => {
		view({ phase: "discovering" });
		expect(screen.getByText("Analyze")).toHaveClass("text-success");
		expect(screen.getByText("Discover")).toHaveClass("text-primary");
		expect(screen.getByText("Generate")).toHaveClass("text-muted-foreground");
	});

	it("counts the elapsed time every second, in minutes then hours, from a date or a string", () => {
		const { rerender } = view({ startedAt: new Date(NOW - 65_000) });
		expect(screen.getByText("1:05")).toBeInTheDocument();
		act(() => vi.advanceTimersByTime(2000));
		expect(screen.getByText("1:07")).toBeInTheDocument();

		rerender(
			<TooltipProvider>
				<RoadmapGenerationProgress
					generationStatus={{
						phase: "generating",
						progress: 10,
						message: "",
						startedAt: new Date(NOW - 3_725_000).toISOString() as never,
					}}
				/>
			</TooltipProvider>,
		);
		expect(screen.getByText("1:02:07")).toBeInTheDocument();
	});

	it("shows 0:00 for a start time ahead of the clock, and resets when idle", () => {
		const status = (phase: RoadmapGenerationStatus["phase"]): RoadmapGenerationStatus => ({
			phase,
			progress: 0,
			message: "",
			startedAt: new Date(NOW + 10_000),
		});
		const { rerender } = render(
			<TooltipProvider>
				<RoadmapGenerationProgress generationStatus={status("analyzing")} />
			</TooltipProvider>,
		);
		expect(screen.getByText("0:00")).toBeInTheDocument();
		rerender(
			<TooltipProvider>
				<RoadmapGenerationProgress generationStatus={status("idle")} />
			</TooltipProvider>,
		);
		rerender(
			<TooltipProvider>
				<RoadmapGenerationProgress generationStatus={{ ...status("analyzing"), startedAt: undefined }} />
			</TooltipProvider>,
		);
		expect(screen.queryByText(/\d:\d\d/)).not.toBeInTheDocument();
	});

	it.each([
		[2, "en", "just now"],
		[30, "en", "30s ago"],
		[300, "en", "5m ago"],
		[7200, "en", "2h ago"],
		[3 * 86400, "en", "3d ago"],
		[2, "fr", "à l'instant"],
		[300, "fr", "il y a 5 min"],
	] as const)("says the last activity %is ago in %s as %s", async (seconds, lng, text) => {
		await act(() => i18n.changeLanguage(lng));
		view({ lastActivityAt: new Date(NOW - seconds * 1000) });
		expect(screen.getByText(new RegExp(text))).toBeInTheDocument();
	});

	it("keeps the last activity current, and drops it once the generation ends", () => {
		const { rerender } = view({ lastActivityAt: new Date(NOW - 40_000).toISOString() as never });
		expect(screen.getByText(/40s ago/)).toBeInTheDocument();
		act(() => vi.advanceTimersByTime(25_000));
		expect(screen.getByText(/1m ago/)).toBeInTheDocument();
		rerender(
			<TooltipProvider>
				<RoadmapGenerationProgress generationStatus={{ phase: "complete", progress: 100, message: "" }} />
			</TooltipProvider>,
		);
		expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
	});

	it("stops once, says it is stopping, and frees the button even when stopping fails", async () => {
		let finish!: () => void;
		const onStop = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
		view({}, onStop);
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(screen.getByRole("button", { name: "Stopping..." })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Stopping..." }));
		expect(onStop).toHaveBeenCalledTimes(1);
		await act(async () => finish());
		expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();

		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		onStop.mockRejectedValueOnce(new Error("already gone"));
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
		expect(error).toHaveBeenCalledWith("Failed to stop generation:", expect.any(Error));
		expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
		error.mockRestore();
	});

	it("follows the reduced motion preference, from the start and when it changes", () => {
		prefersReduced = true;
		const { unmount } = view({ progress: 0, startedAt: new Date(NOW) });
		expect(screen.getByRole("heading", { name: "Analyzing" })).toBeInTheDocument();
		act(() => {
			for (const listener of mediaListeners) listener({ matches: false });
		});
		expect(screen.getByRole("heading", { name: "Analyzing" })).toBeInTheDocument();
		unmount();
		expect(mediaListeners).toHaveLength(0);

		prefersReduced = true;
		view({ phase: "complete", progress: 100 });
		expect(screen.getByRole("heading", { name: "Complete" })).toBeInTheDocument();
	});
});
