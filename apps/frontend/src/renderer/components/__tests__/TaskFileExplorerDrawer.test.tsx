/**
 * TaskFileExplorerDrawer — the project's files beside the task wizard, to drag
 * in as references. Real store and tree; only `listDirectory` is a stand-in.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import i18n from "../../../shared/i18n";
import type { FileNode } from "../../../shared/types";
import { useFileExplorerStore } from "../../stores/file-explorer-store";
import { TaskFileExplorerDrawer } from "../TaskFileExplorerDrawer";

const ROOT = "/work/demo";
let entries: FileNode[];
const listDirectory = vi.fn(async () => ({ success: true, data: entries }));

const clientHeight = Object.getOwnPropertyDescriptor(
	HTMLElement.prototype,
	"clientHeight",
);
beforeAll(() => {
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get: () => 600,
	});
});
afterAll(() => {
	if (clientHeight) {
		Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
	}
});

beforeEach(async () => {
	await i18n.changeLanguage("en");
	entries = [{ name: "README.md", path: `${ROOT}/README.md`, isDirectory: false }];
	listDirectory.mockClear();
	useFileExplorerStore.setState({
		files: new Map(),
		expandedFolders: new Set(),
		isLoading: new Map(),
		error: null,
	});
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
		listDirectory,
	};
});

describe("TaskFileExplorerDrawer", () => {
	it("shows nothing while closed", () => {
		render(
			<TaskFileExplorerDrawer isOpen={false} onClose={vi.fn()} projectPath={ROOT} />,
		);
		expect(screen.queryByText("Project Files")).not.toBeInTheDocument();
		expect(listDirectory).not.toHaveBeenCalled();
	});

	it("lists the project's files with the drag hint", async () => {
		render(<TaskFileExplorerDrawer isOpen onClose={vi.fn()} projectPath={ROOT} />);
		expect(screen.getByText("Project Files")).toBeInTheDocument();
		expect(
			screen.getByText("Drag files to add as references"),
		).toBeInTheDocument();
		expect(await screen.findByText("README.md")).toBeInTheDocument();
		expect(listDirectory).toHaveBeenCalledWith(ROOT);
	});

	it("reads the folder again on refresh", async () => {
		render(<TaskFileExplorerDrawer isOpen onClose={vi.fn()} projectPath={ROOT} />);
		await screen.findByText("README.md");
		entries = [
			...entries,
			{ name: "CHANGELOG.md", path: `${ROOT}/CHANGELOG.md`, isDirectory: false },
		];
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("CHANGELOG.md")).toBeInTheDocument();
		expect(listDirectory).toHaveBeenCalledTimes(2);
	});

	it("closes from its button", () => {
		const onClose = vi.fn();
		render(<TaskFileExplorerDrawer isOpen onClose={onClose} projectPath={ROOT} />);
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
