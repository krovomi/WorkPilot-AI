/**
 * The screen of a running generation: progress per type, the ideas as they
 * stream in, the logs, and the stop button.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { IdeationGenerationStatus, IdeationType } from "../../../../shared/types";
import type { IdeationTypeState } from "../../../stores/ideation-store";
import { Toaster } from "../../ui/toaster";
import { GenerationProgressScreen } from "../GenerationProgressScreen";
import { codeImprovement, security, session } from "./fixtures";

const STATES: Record<IdeationType, IdeationTypeState> = {
	code_improvements: "completed",
	ui_ux_improvements: "generating",
	documentation_gaps: "pending",
	security_hardening: "failed",
	performance_optimizations: "completed",
	code_quality: "failed",
};
const ENABLED: IdeationType[] = [
	"code_improvements",
	"ui_ux_improvements",
	"documentation_gaps",
	"security_hardening",
	"performance_optimizations",
	"code_quality",
];
const STATUS: IdeationGenerationStatus = {
	phase: "generating",
	progress: 41.6,
	message: "Generating 6 ideation types in parallel...",
};

const scrollIntoView = vi.fn();
beforeAll(() => {
	HTMLElement.prototype.scrollIntoView = scrollIntoView;
});
beforeEach(async () => {
	scrollIntoView.mockReset();
	await i18n.changeLanguage("en");
});
afterEach(() => cleanup());

type Props = Parameters<typeof GenerationProgressScreen>[0];

function props(over: Partial<Props> = {}): Props {
	return {
		generationStatus: STATUS,
		logs: [],
		typeStates: STATES,
		enabledTypes: ENABLED,
		session: session([
			codeImprovement(),
			codeImprovement({ id: "ci-2", title: "Gone", status: "dismissed" }),
			codeImprovement({ id: "ci-3", title: "Done", status: "archived" }),
			security({ title: "Escape late" }),
		]),
		onSelectIdea: vi.fn(),
		selectedIdea: null,
		onConvert: vi.fn(),
		onDismiss: vi.fn(),
		onStop: vi.fn(),
		...over,
	};
}

describe("the generation screen", () => {
	it("shows the progress, each type's state and the ideas streamed so far", () => {
		render(<GenerationProgressScreen {...props()} />);
		expect(screen.getByText("Generating 6 ideation types in parallel...")).toBeInTheDocument();
		expect(screen.getByText("42%")).toBeInTheDocument();
		expect(screen.getByText("2/6 complete")).toBeInTheDocument();

		expect(screen.getByText("Reuse the retry helper")).toBeInTheDocument();
		expect(screen.queryByText("Gone")).toBeNull();
		expect(screen.queryByText("Done")).toBeNull();
		expect(screen.getAllByText("1 idea")).toHaveLength(2);
		expect(screen.getByText("Waiting to start...")).toBeInTheDocument();
		// Security failed after an idea: the idea shows, not the failure.
		expect(screen.getByText("Escape late")).toBeInTheDocument();
		expect(screen.getAllByText("Failed to generate ideas for this category")).toHaveLength(1);
		expect(screen.getAllByText("No ideas generated for this category")).toHaveLength(1);
	});

	it("shows no idea count on a type chip before the session exists", () => {
		const { container } = render(<GenerationProgressScreen {...props({ session: null })} />);
		expect(screen.queryByText("Reuse the retry helper")).toBeNull();
		expect(container.querySelector(".font-semibold")).toBeNull();
	});

	it("shows the error the generation reported", () => {
		render(
			<GenerationProgressScreen
				{...props({ generationStatus: { ...STATUS, error: "Generation timed out" } })}
			/>,
		);
		expect(screen.getByRole("alert")).toHaveTextContent("Generation timed out");
	});

	it("opens an idea, closes it from the card or the panel", () => {
		const onSelectIdea = vi.fn();
		const idea = codeImprovement();
		const { rerender } = render(<GenerationProgressScreen {...props({ onSelectIdea })} />);
		fireEvent.click(screen.getByRole("button", { name: /Reuse the retry helper/ }));
		expect(onSelectIdea).toHaveBeenLastCalledWith(idea);

		rerender(<GenerationProgressScreen {...props({ onSelectIdea, selectedIdea: idea })} />);
		fireEvent.click(screen.getByRole("button", { name: /Reuse the retry helper/ }));
		expect(onSelectIdea).toHaveBeenLastCalledWith(null);
		onSelectIdea.mockClear();
		fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
		expect(onSelectIdea).toHaveBeenCalledWith(null);
		// Selecting is off while generating: the checkbox does nothing.
		fireEvent.click(screen.getAllByRole("checkbox")[0]);
	});

	it("shows every log line, the repeated ones too, and follows the newest", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const prefix = "[code_improvements] Reading the project files to find patterns: ";
		const logs = [`${prefix}a.ts`, "Process already stopped", "Process already stopped"];
		const { rerender } = render(<GenerationProgressScreen {...props({ logs })} />);
		expect(screen.queryByText("Process already stopped")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Show Logs" }));
		expect(screen.getByRole("button", { name: "Hide Logs" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(scrollIntoView).toHaveBeenCalledTimes(1);

		const more = [...logs, `${prefix}b.ts`];
		rerender(<GenerationProgressScreen {...props({ logs: more })} />);
		expect(screen.getAllByText("Process already stopped")).toHaveLength(2);
		expect(screen.getByText(`${prefix}a.ts`)).toBeInTheDocument();
		expect(screen.getByText(`${prefix}b.ts`)).toBeInTheDocument();
		expect(screen.getByText("004")).toBeInTheDocument();
		expect(scrollIntoView).toHaveBeenCalledTimes(2);
		const keyWarnings = errors.mock.calls.filter((call) =>
			call.join(" ").includes("same key"),
		);
		errors.mockRestore();
		expect(keyWarnings).toEqual([]);

		fireEvent.click(screen.getByRole("button", { name: "Hide Logs" }));
		expect(screen.queryByText("Process already stopped")).toBeNull();
	});

	it("shows no log block while there is no line", () => {
		const { container } = render(<GenerationProgressScreen {...props()} />);
		fireEvent.click(screen.getByRole("button", { name: "Show Logs" }));
		expect(container.querySelector("pre")).toBeNull();
		expect(scrollIntoView).not.toHaveBeenCalled();
	});

	it("says it is stopping until the stop is done", async () => {
		let finish: () => void = () => undefined;
		const onStop = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		render(<GenerationProgressScreen {...props({ onStop })} />);
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(screen.getByRole("button", { name: "Stopping..." })).toBeDisabled();
		await act(async () => finish());
		expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
		expect(onStop).toHaveBeenCalledTimes(1);
	});

	it("tells the person when the stop failed", async () => {
		const onStop = vi.fn().mockRejectedValue(new Error("No such process"));
		render(
			<>
				<GenerationProgressScreen {...props({ onStop })} />
				<Toaster />
			</>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(await screen.findByText("Could not stop the generation")).toBeInTheDocument();
		expect(screen.getByText("No such process")).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled());
	});

	it("tells the person when the stop failed with something that is not an Error", async () => {
		const onStop = vi.fn().mockRejectedValue("IPC closed");
		render(
			<>
				<GenerationProgressScreen {...props({ onStop })} />
				<Toaster />
			</>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(await screen.findByText("IPC closed")).toBeInTheDocument();
	});
});
