/**
 * A model's summary of a replay's steps (#347, lot 2): offered only for a
 * session without a thinking trace, asked of the default provider, shown as
 * text with the model that wrote it. And the video button of the share
 * dialog, with the same masking options as the page.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplaySessionFull, ReplayStep } from "../../../stores/agent-replay-store";
import { useReplayShareStore } from "../../../stores/replay-share-store";
import { useSettingsStore } from "../../../stores/settings-store";
import { ProviderContext } from "../../ProviderContext";
import { ReplayShareButton, ReplayShareNotice } from "../ReplaySharing";
import { ReplayStepsSummary, hasThinking } from "../ReplayStepsSummary";

const api = {
	summarizeReplaySession: vi.fn(),
	exportReplayVideo: vi.fn(),
};

const step = (extra: Partial<ReplayStep> = {}) =>
	({ step_index: 0, step_type: "tool_call", reasoning: "", ...extra }) as ReplayStep;

const session = (extra: Partial<ReplaySessionFull> = {}) =>
	({
		session_id: "s1",
		status: "completed",
		steps: [step()],
		...extra,
	}) as ReplaySessionFull;

const withProvider = (provider: string, node: React.ReactNode) => (
	<ProviderContext.Provider
		value={{
			selectedProvider: provider,
			setSelectedProvider: () => undefined,
			usageProvider: provider,
			usageProviderChoice: null,
			setUsageProviderChoice: () => undefined,
			runningProviders: [],
		}}
	>
		{node}
	</ProviderContext.Provider>
);

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
	useReplayShareStore.setState({ summarizing: false, recordingVideo: false, notice: null });
	useSettingsStore.setState({ settings: {} as never });
});

afterEach(cleanup);

describe("hasThinking", () => {
	it("is a thinking step or a step's reasoning", () => {
		expect(hasThinking(session())).toBe(false);
		expect(hasThinking(session({ steps: [step({ step_type: "agent_thinking" })] }))).toBe(true);
		expect(hasThinking(session({ steps: [step({ reasoning: " why " })] }))).toBe(true);
		expect(hasThinking(session({ steps: [step({ reasoning: undefined as never })] }))).toBe(
			false,
		);
	});
});

describe("ReplayStepsSummary", () => {
	it("is not offered when the model left its reasoning", () => {
		const { container } = render(
			withProvider("claude", <ReplayStepsSummary session={session({ steps: [step({ reasoning: "x" })] })} />),
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("asks the default provider for a summary", async () => {
		api.summarizeReplaySession.mockResolvedValueOnce({ success: false, error: "x" });
		render(withProvider("openai", <ReplayStepsSummary session={session()} />));
		expect(screen.getByText(/left no reasoning/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Summarize with openai" }));
		await waitFor(() =>
			expect(api.summarizeReplaySession).toHaveBeenCalledWith("s1", {
				provider: "openai",
				language: "en",
			}),
		);
	});

	it("shows a summary as text, with the model that wrote it", () => {
		render(
			withProvider(
				"claude",
				<ReplayStepsSummary
					session={session({
						summary: {
							text: "- <b>fixed</b>",
							provider: "claude",
							model: "haiku",
							language: "en",
							created_at: 1,
						},
					})}
				/>,
			),
		);
		expect(screen.getByText("- <b>fixed</b>")).toBeInTheDocument();
		expect(screen.getByText(/Written by a model \(claude · haiku\)/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Summarize again with claude" })).toBeInTheDocument();
	});

	it("says a model wrote it even when it is not named", () => {
		render(
			withProvider(
				"claude",
				<ReplayStepsSummary
					session={session({
						summary: { text: "- x", provider: "", model: "", language: "en", created_at: 1 },
					})}
				/>,
			),
		);
		expect(screen.getByText(/Written by a model \(\?\)/)).toBeInTheDocument();
	});

	it("shows that it is working", () => {
		useReplayShareStore.setState({ summarizing: true });
		render(withProvider("claude", <ReplayStepsSummary session={session()} />));
		expect(screen.getByRole("button", { name: "Summarizing…" })).toBeDisabled();
	});

	it("falls back on the provider saved in the settings, outside the context", () => {
		useSettingsStore.setState({ settings: { selectedProvider: "ollama" } as never });
		render(<ReplayStepsSummary session={session()} />);
		expect(screen.getByRole("button", { name: "Summarize with ollama" })).toBeInTheDocument();
	});

	it("says what is missing: a provider, or the end of the recording", () => {
		const { unmount } = render(<ReplayStepsSummary session={session()} />);
		expect(screen.getByText(/Choose a default provider/)).toBeInTheDocument();
		unmount();
		render(withProvider("claude", <ReplayStepsSummary session={session({ status: "recording" })} />));
		expect(screen.getByText(/once the session has finished recording/)).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("the video button", () => {
	it("records with the masking options of the page", async () => {
		api.exportReplayVideo.mockResolvedValueOnce({ success: true, refused: "no_encoder" });
		render(
			<>
				<ReplayShareButton sessionId="s1" />
				<ReplayShareNotice />
			</>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Share" }));
		expect(screen.getByText(/played step by step in a headless browser/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("switch", { name: "Remove tokens and costs" }));
		fireEvent.click(screen.getByRole("button", { name: "Export a video (WebM)" }));
		await waitFor(() =>
			expect(api.exportReplayVideo).toHaveBeenCalledWith("s1", {
				stripReasoning: false,
				stripTokens: true,
				language: "en",
			}),
		);
		expect(await screen.findByText(/playwright install ffmpeg/)).toBeInTheDocument();
	});

	it("is busy while a video records", () => {
		useReplayShareStore.setState({ recordingVideo: true });
		render(<ReplayShareButton sessionId="s1" />);
		fireEvent.click(screen.getByRole("button", { name: "Share" }));
		expect(screen.getByRole("button", { name: "Recording the video…" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Export a page (HTML)" })).toBeDisabled();
	});
});
