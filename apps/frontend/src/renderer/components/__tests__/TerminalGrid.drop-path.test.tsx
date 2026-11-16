/**
 * A file dragged from the explorer onto a terminal of the grid is typed in
 * quoted the same way as a file dropped on the terminal itself
 * (useTerminalFileDrop): one shell word, whatever its characters.
 */
import { act, render } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { escapeShellArg } from "../../../shared/utils/shell-escape";
import { useTerminalStore } from "../../stores/terminal-store";
import { TerminalGrid } from "../TerminalGrid";

const seen = vi.hoisted(() => ({
	onDragEnd: undefined as ((event: unknown) => void) | undefined,
}));

vi.mock("@dnd-kit/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dnd-kit/core")>()),
	DndContext: (props: { children: React.ReactNode; onDragEnd: never }) => {
		seen.onDragEnd = props.onDragEnd;
		return <>{props.children}</>;
	},
}));
vi.mock("react-resizable-panels", () => ({
	Group: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	Panel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	Separator: () => null,
}));
vi.mock("../SortableTerminalWrapper", () => ({ SortableTerminalWrapper: () => null }));
vi.mock("../FileExplorerPanel", () => ({ FileExplorerPanel: () => null }));

const sendTerminalInput = vi.fn();

describe("TerminalGrid file drop", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		Object.assign(globalThis.electronAPI, {
			sendTerminalInput,
			getTerminalSessionDates: vi.fn().mockResolvedValue({ success: true, data: [] }),
		});
		useTerminalStore.setState({
			terminals: [
				{
					id: "a",
					title: "A",
					status: "running",
					cwd: "/p",
					createdAt: new Date(0),
					isClaudeMode: false,
					projectPath: "/p",
				},
			],
		});
	});

	it.each([
		"src/a.ts",
		"my docs/a b.md",
		"it's.txt",
		'say "hi".txt',
		"$(touch x).txt",
		"`id`.txt",
		"a\nb.txt",
	])("types %j as one quoted word", (path) => {
		render(<TerminalGrid projectPath="/p" />);

		act(() =>
			seen.onDragEnd?.({
				active: { id: "f", data: { current: { type: "file", path } } },
				over: { id: "terminal-a" },
			}),
		);

		expect(sendTerminalInput).toHaveBeenCalledWith("a", `${escapeShellArg(path)} `);
	});
});
