/**
 * FileTree — the virtualised file explorer over the real file-explorer store;
 * only `listDirectory` of the IPC bridge is a stand-in.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
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
import { FileTree, parentFolder } from "../FileTree";

type Listing = { success: boolean; data?: FileNode[]; error?: string };

const ROOT = "/work/demo";
const TREE: Record<string, FileNode[]> = {
	[ROOT]: [
		{ name: "src", path: `${ROOT}/src`, isDirectory: true },
		{ name: "README.md", path: `${ROOT}/README.md`, isDirectory: false },
	],
	[`${ROOT}/src`]: [
		{ name: "main.ts", path: `${ROOT}/src/main.ts`, isDirectory: false },
	],
};

let listDirectory: ReturnType<typeof vi.fn<(path: string) => Promise<Listing>>>;

// jsdom lays nothing out: give the scroll container a height so the
// virtualiser has rows to show.
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
	useFileExplorerStore.setState({
		files: new Map(),
		expandedFolders: new Set(),
		isLoading: new Map(),
		error: null,
	});
	listDirectory = vi.fn(async (path: string) =>
		TREE[path]
			? { success: true, data: TREE[path] }
			: { success: false, error: `ENOENT: ${path}` },
	);
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
		listDirectory,
	};
});

describe("FileTree — listing", () => {
	it("loads the root once, spinning meanwhile, then lists it", async () => {
		let answer: (value: Listing) => void = () => undefined;
		listDirectory.mockImplementationOnce(
			() => new Promise<Listing>((resolve) => (answer = resolve)),
		);
		render(<FileTree rootPath={ROOT} />);
		expect(screen.getByLabelText("Loading...")).toBeInTheDocument();
		await act(async () => answer({ success: true, data: TREE[ROOT] }));
		expect(
			screen.getByRole("button", { name: "Toggle src folder" }),
		).toBeInTheDocument();
		expect(screen.getByText("README.md")).toBeInTheDocument();
		expect(listDirectory).toHaveBeenCalledTimes(1);
		// A project's tree has no "parent" button: nothing would pick it.
		expect(
			screen.queryByRole("button", { name: "⬆ Parent" }),
		).not.toBeInTheDocument();
	});

	it("opens a folder, loading it once, and closes it", async () => {
		render(<FileTree rootPath={ROOT} />);
		const src = await screen.findByRole("button", { name: "Toggle src folder" });
		fireEvent.click(src);
		expect(await screen.findByText("main.ts")).toBeInTheDocument();
		expect(listDirectory).toHaveBeenLastCalledWith(`${ROOT}/src`);
		fireEvent.click(src);
		expect(screen.queryByText("main.ts")).not.toBeInTheDocument();
		fireEvent.click(src);
		expect(screen.getByText("main.ts")).toBeInTheDocument();
		expect(listDirectory).toHaveBeenCalledTimes(2);
	});

	it("says when a folder is empty", async () => {
		listDirectory.mockResolvedValueOnce({ success: true, data: [] });
		render(<FileTree rootPath={ROOT} />);
		expect(await screen.findByText(/No folder found\./)).toHaveTextContent(
			"Check the path or your access rights.",
		);
		expect(screen.getByText(/Current root: \/work\/demo/)).toBeInTheDocument();
	});

	it("loads the new root when the path changes", async () => {
		const { rerender } = render(<FileTree rootPath={ROOT} />);
		await screen.findByText("README.md");
		rerender(<FileTree rootPath={`${ROOT}/src`} />);
		expect(await screen.findByText("main.ts")).toBeInTheDocument();
		expect(screen.queryByText("README.md")).not.toBeInTheDocument();
	});
});

describe("FileTree — failures", () => {
	it("shows why the root could not be opened, and does not ask again and again", async () => {
		listDirectory.mockResolvedValue({
			success: false,
			error: "EACCES: permission denied",
		});
		render(<FileTree rootPath={ROOT} />);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Could not open this folder.");
		expect(alert).toHaveTextContent("EACCES: permission denied");
		// Give a retry loop every chance to show itself.
		for (let i = 0; i < 5; i++) await act(async () => undefined);
		expect(listDirectory).toHaveBeenCalledTimes(1);
	});

	it("keeps the tree when one of its folders cannot be opened", async () => {
		const tree: Record<string, FileNode[]> = { ...TREE, [ROOT]: [...TREE[ROOT], { name: "locked", path: `${ROOT}/locked`, isDirectory: true }] };
		listDirectory.mockImplementation(async (path: string) =>
			tree[path]
				? { success: true, data: tree[path] }
				: { success: false, error: "EACCES: permission denied" },
		);
		render(<FileTree rootPath={ROOT} />);
		fireEvent.click(
			await screen.findByRole("button", { name: "Toggle locked folder" }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not open this folder. EACCES: permission denied",
		);
		expect(screen.getByText("README.md")).toBeInTheDocument();
	});
});

describe("FileTree — folder picker", () => {
	it("picks a folder of the tree, highlighted, or its parent", async () => {
		const onSelectFolder = vi.fn();
		const { rerender } = render(
			<FileTree rootPath={ROOT} onSelectFolder={onSelectFolder} />,
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Toggle src folder" }),
		);
		expect(onSelectFolder).toHaveBeenCalledWith(`${ROOT}/src`);
		rerender(
			<FileTree
				rootPath={ROOT}
				onSelectFolder={onSelectFolder}
				selectedFolder={`${ROOT}/src`}
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Toggle src folder" }),
		).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(screen.getByRole("button", { name: "⬆ Parent" }));
		expect(onSelectFolder).toHaveBeenLastCalledWith("/work");
	});

	it("offers no parent at the root of the disk", async () => {
		listDirectory.mockResolvedValue({ success: true, data: [] });
		render(<FileTree rootPath="/" onSelectFolder={vi.fn()} />);
		await screen.findByText(/No folder found\./);
		expect(
			screen.queryByRole("button", { name: "⬆ Parent" }),
		).not.toBeInTheDocument();
	});
});

describe("parentFolder", () => {
	it.each([
		["/work/demo", "/work"],
		["/work/demo/", "/work"],
		["/work", "/"],
		["/", null],
		["C:\\Users\\me", "C:\\Users"],
		["C:\\Users\\me\\", "C:\\Users"],
		["C:\\Users", "C:\\"],
		["C:\\", null],
		["demo", null],
	])("goes from %s to %s", (path, parent) => {
		expect(parentFolder(path)).toBe(parent);
	});
});
