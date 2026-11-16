/**
 * The live log of a task bubble: coloured by level, collapsible to its last
 * line, copyable (and honest when the copy fails), following the tail unless
 * the person scrolled up to read.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PixelAgent } from "../../../stores/pixel-office-store";
import { AgentBubble } from "../AgentBubble";

const logs = vi.hoisted(() => ({
	current: { lines: [] as string[], running: false, loading: false },
}));

vi.mock("../use-agent-log-lines", () => ({
	useAgentLogLines: () => logs.current,
}));

const agent: PixelAgent = {
	id: "task:t1",
	type: "task",
	name: "Cart",
	fullName: "Cart checkout",
	characterIndex: 0,
	activity: "typing",
	seatIndex: 0,
	isClaudeMode: true,
	taskId: "t1",
	phase: "coding",
};

const noop = () => undefined;

function renderBubble() {
	return render(
		<AgentBubble
			agent={agent}
			terminal={undefined}
			anchorX={100}
			anchorY={100}
			onClose={noop}
			onGoToTerminal={noop}
			onGoToTask={noop}
			onKill={noop}
			onInterrupt={noop}
			onResumeClaude={noop}
			onSendCommand={noop}
			onStopTask={noop}
		/>,
	);
}

/** jsdom does no layout: give the log area a scroll geometry of its own. */
function scrollable(el: HTMLElement, scrollHeight: number, clientHeight: number) {
	let top = 0;
	Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
	Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
	Object.defineProperty(el, "scrollTop", {
		configurable: true,
		get: () => top,
		set: (v: number) => {
			top = v;
		},
	});
}

const colourOf = (text: string) => (screen.getByText(text) as HTMLElement).style.color;

beforeEach(async () => {
	await i18n.changeLanguage("en");
	logs.current = { lines: [], running: false, loading: false };
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("AgentBubble log stream", () => {
	it("colours each line by its level and counts them", () => {
		logs.current.lines = [
			"[ERROR] build broke",
			"TypeError: x is undefined",
			"[WARN] slow test",
			"✅ lint passed",
			"[OK] pushed",
			"[INFO] starting",
			"plain line",
		];
		renderBubble();
		expect(screen.getByText("7")).toBeTruthy();
		expect(colourOf("[ERROR] build broke")).toBe("rgb(248, 113, 113)");
		expect(colourOf("TypeError: x is undefined")).toBe("rgb(248, 113, 113)");
		expect(colourOf("[WARN] slow test")).toBe("rgb(252, 211, 77)");
		expect(colourOf("✅ lint passed")).toBe("rgb(110, 231, 183)");
		expect(colourOf("[OK] pushed")).toBe("rgb(110, 231, 183)");
		expect(colourOf("[INFO] starting")).toBe("rgba(255, 255, 255, 0.65)");
		expect(colourOf("plain line")).toBe("rgba(255, 255, 255, 0.42)");
	});

	it("collapses to the last line, and to nothing when there is none", () => {
		logs.current.lines = ["first", "Error in step"];
		const view = renderBubble();
		const toggle = screen.getByRole("button", { name: /Agent logs/ });
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("first")).toBeNull();
		expect(colourOf("Error in step")).toBe("rgb(248, 113, 113)");
		view.unmount();

		logs.current.lines = [];
		renderBubble();
		fireEvent.click(screen.getByRole("button", { name: /Agent logs/ }));
		expect(screen.queryByText("No log was recorded for this task.")).toBeNull();
		expect(screen.queryByTitle("Copy all logs")).toBeNull();
	});

	it("waits for logs while the task is still loading them", () => {
		logs.current.loading = true;
		renderBubble();
		expect(screen.getByText("Waiting for logs…")).toBeTruthy();
	});

	it("copies every line, then says so for two seconds", async () => {
		// user-event replaces the clipboard: install the fake after it.
		userEvent.setup();
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		logs.current.lines = ["one", "two"];
		renderBubble();

		vi.useFakeTimers();
		await act(async () => {
			fireEvent.click(screen.getByTitle("Copy all logs"));
		});
		expect(writeText).toHaveBeenCalledWith("one\ntwo");
		expect(screen.getByText("Copied")).toBeTruthy();
		act(() => vi.advanceTimersByTime(2000));
		expect(screen.getByText("Copy")).toBeTruthy();
	});

	it("says the copy failed instead of claiming it worked", async () => {
		userEvent.setup();
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
		});
		logs.current.lines = ["one"];
		renderBubble();
		await act(async () => {
			fireEvent.click(screen.getByTitle("Copy all logs"));
		});
		expect(screen.getByText("Not copied")).toBeTruthy();
		expect(screen.queryByText("Copied")).toBeNull();
	});

	it("follows new lines, unless the person scrolled up to read", () => {
		logs.current.lines = ["a"];
		const view = renderBubble();
		const area = screen.getByText("a").closest("div.overflow-y-auto") as HTMLElement;
		scrollable(area, 500, 100);

		logs.current = { ...logs.current, lines: ["a", "b"] };
		renderAgain(view);
		expect(area.scrollTop).toBe(500);

		area.scrollTop = 0;
		fireEvent.scroll(area);
		logs.current = { ...logs.current, lines: ["a", "b", "c"] };
		renderAgain(view);
		expect(area.scrollTop).toBe(0);

		area.scrollTop = 390;
		fireEvent.scroll(area);
		logs.current = { ...logs.current, lines: ["a", "b", "c", "d"] };
		renderAgain(view);
		expect(area.scrollTop).toBe(500);
	});

	it("opens again at the newest line", () => {
		logs.current.lines = ["a", "b"];
		renderBubble();
		const toggle = screen.getByRole("button", { name: /Agent logs/ });
		fireEvent.click(toggle);
		vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(700);
		const setTop = vi.spyOn(Element.prototype, "scrollTop", "set");
		fireEvent.click(toggle);
		expect(setTop).toHaveBeenCalledWith(700);
	});
});

function renderAgain(view: ReturnType<typeof renderBubble>) {
	view.rerender(
		<AgentBubble
			agent={{ ...agent }}
			terminal={undefined}
			anchorX={100}
			anchorY={100}
			onClose={noop}
			onGoToTerminal={noop}
			onGoToTask={noop}
			onKill={noop}
			onInterrupt={noop}
			onResumeClaude={noop}
			onSendCommand={noop}
			onStopTask={noop}
		/>,
	);
}
