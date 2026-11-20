/** @vitest-environment jsdom */
/**
 * The line a terminal writes when its process ends is in the app's language.
 * xterm and the PTY are replaced by their hooks' doubles; the exit handler
 * the terminal gives to useTerminalEvents is the one under test.
 */
import "@testing-library/jest-dom/vitest";
import { DndContext } from "@dnd-kit/core";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";

const writeln = vi.fn();
let onExit: ((code: number) => void) | undefined;

vi.mock("../terminal/useXterm", () => ({
	useXterm: () => ({
		terminalRef: { current: null },
		xtermRef: { current: null },
		fit: vi.fn(),
		writeln,
		focus: vi.fn(),
		dispose: vi.fn(),
		cols: 80,
		rows: 24,
	}),
}));
vi.mock("../terminal/usePtyProcess", () => ({
	usePtyProcess: () => ({ prepareForRecreate: vi.fn(), resetForRecreate: vi.fn() }),
}));
vi.mock("../terminal/useTerminalEvents", () => ({
	useTerminalEvents: (options: { onExit?: (code: number) => void }) => {
		onExit = options.onExit;
	},
}));

import { Terminal } from "../Terminal";

beforeEach(() => {
	writeln.mockClear();
	onExit = undefined;
	(globalThis as { electronAPI?: unknown }).electronAPI = new Proxy(
		{},
		{ get: () => vi.fn(() => () => undefined) },
	);
});

afterEach(cleanup);

describe("Terminal exit line", () => {
	it.each([
		["en", "Process exited with code 3"],
		["fr", "Processus terminé avec le code 3"],
	])("is written in %s", async (lng, text) => {
		await i18n.changeLanguage(lng);
		render(
			<DndContext>
				<Terminal id="t-exit" isActive={false} onClose={vi.fn()} onActivate={vi.fn()} />
			</DndContext>,
		);
		act(() => onExit?.(3));
		expect(writeln).toHaveBeenCalledWith(`\r\n\x1b[90m${text}\x1b[0m`);
	});
});
