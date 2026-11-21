/**
 * FileTreeItem — one row of the file explorer: a folder opens and closes (and
 * is picked in a folder picker), any row drags its path as a file reference.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { FileNode } from "../../../shared/types";
import { FileTreeItem } from "../FileTreeItem";

const FOLDER: FileNode = { name: "src", path: "/work/demo/src", isDirectory: true };
const FILE: FileNode = {
	name: "index.ts",
	path: "/work/demo/index.ts",
	isDirectory: false,
};

type ItemProps = Parameters<typeof FileTreeItem>[0];

function renderItem(props: Partial<ItemProps> & { node: FileNode }) {
	const onToggle = vi.fn();
	const utils = render(
		<FileTreeItem
			depth={0}
			isExpanded={false}
			isLoading={false}
			onToggle={onToggle}
			{...props}
		/>,
	);
	return { ...utils, onToggle };
}

function dataTransfer() {
	return { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" };
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

describe("FileTreeItem — folder", () => {
	it("opens on click and on Enter or Space, and offers its chevron", () => {
		const { onToggle } = renderItem({ node: FOLDER, depth: 2 });
		const row = screen.getByRole("button", { name: "Toggle src folder" });
		expect(row).toHaveAttribute("aria-expanded", "false");
		expect(row).toHaveStyle({ paddingLeft: "32px" });
		expect(row).not.toHaveAttribute("aria-pressed");

		fireEvent.click(row);
		fireEvent.keyDown(row, { key: "Enter" });
		fireEvent.keyDown(row, { key: " " });
		fireEvent.keyDown(row, { key: "a" });
		expect(onToggle).toHaveBeenCalledTimes(3);

		fireEvent.click(screen.getByRole("button", { name: "Expand src folder" }));
		expect(onToggle).toHaveBeenCalledTimes(4);
		fireEvent.doubleClick(row);
		expect(onToggle).toHaveBeenCalledTimes(5);
	});

	it("says it can be collapsed once open, and shows a spinner while loading", () => {
		const { rerender, onToggle } = renderItem({ node: FOLDER, isExpanded: true });
		expect(
			screen.getByRole("button", { name: "Collapse src folder" }),
		).toHaveAttribute("aria-expanded", "true");
		rerender(
			<FileTreeItem
				node={FOLDER}
				depth={0}
				isExpanded={false}
				isLoading
				onToggle={onToggle}
			/>,
		);
		expect(
			screen
				.getByRole("button", { name: "Expand src folder" })
				.querySelector(".animate-spin"),
		).not.toBeNull();
	});

	it("is picked on click in a folder picker, and shows when it is the pick", () => {
		const onSelectFolder = vi.fn();
		const { rerender, onToggle } = renderItem({
			node: FOLDER,
			onSelectFolder,
			selectedFolder: "/elsewhere",
		});
		const row = screen.getByRole("button", { name: "Toggle src folder" });
		expect(row).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(row);
		expect(onSelectFolder).toHaveBeenCalledWith("/work/demo/src");
		rerender(
			<FileTreeItem
				node={FOLDER}
				depth={0}
				isExpanded={false}
				isLoading={false}
				onToggle={onToggle}
				onSelectFolder={onSelectFolder}
				selectedFolder="/work/demo/src"
			/>,
		);
		expect(row).toHaveAttribute("aria-pressed", "true");
		expect(row).toHaveClass("bg-primary");
		expect(screen.getByText("src")).toHaveClass("text-primary-foreground");
	});
});

describe("FileTreeItem — file", () => {
	it("is not a button, and a click or a double-click does nothing", () => {
		const onSelectFolder = vi.fn();
		const { onToggle, container } = renderItem({ node: FILE, onSelectFolder });
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		const row = container.firstElementChild as HTMLElement;
		fireEvent.click(row);
		fireEvent.doubleClick(row);
		fireEvent.keyDown(row, { key: "Enter" });
		expect(onToggle).not.toHaveBeenCalled();
		expect(onSelectFolder).not.toHaveBeenCalled();
		expect(screen.getByText("index.ts")).toHaveClass("text-foreground");
	});

	it.each([
		["main.tsx", "text-info"],
		["config.yaml", "text-warning"],
		["README.md", "text-muted-foreground"],
		["Photo.PNG", "text-purple-400"],
		["theme.scss", "text-pink-400"],
		["index.html", "text-orange-400"],
		["Makefile", "text-muted-foreground"],
	])("gives %s the icon of its kind", (name, colour) => {
		const { container } = renderItem({
			node: { name, path: `/work/demo/${name}`, isDirectory: false },
		});
		expect(container.querySelector("svg")).toHaveClass(colour);
	});
});

describe("FileTreeItem — drag", () => {
	it("drags a file as a reference with a drag image, removed at the end", () => {
		const { container } = renderItem({ node: FILE });
		const row = container.firstElementChild as HTMLElement;
		const dt = dataTransfer();
		fireEvent.dragStart(row, { dataTransfer: dt });
		expect(dt.setData).toHaveBeenCalledWith(
			"application/json",
			JSON.stringify({
				type: "file-reference",
				path: "/work/demo/index.ts",
				name: "index.ts",
				isDirectory: false,
			}),
		);
		expect(dt.setData).toHaveBeenCalledWith("text/plain", "@index.ts");
		expect(dt.effectAllowed).toBe("copy");
		const image = dt.setDragImage.mock.calls[0][0] as HTMLElement;
		expect(image.textContent).toBe("📄index.ts");
		expect(document.body.contains(image)).toBe(true);
		expect(row).toHaveClass("opacity-50");

		fireEvent.dragEnd(row);
		expect(document.body.contains(image)).toBe(false);
		expect(row).not.toHaveClass("opacity-50");
		// A second end (no image left) is harmless.
		fireEvent.dragEnd(row);
	});

	it("drags a folder, and removes its drag image if the row goes away mid-drag", () => {
		const { unmount } = renderItem({ node: FOLDER });
		const dt = dataTransfer();
		fireEvent.dragStart(screen.getByRole("button", { name: "Toggle src folder" }), {
			dataTransfer: dt,
		});
		const image = dt.setDragImage.mock.calls[0][0] as HTMLElement;
		expect(image.textContent).toBe("📁src");
		unmount();
		expect(document.body.contains(image)).toBe(false);
	});

	it("leaves nothing behind when it unmounts without a drag", () => {
		const { unmount } = renderItem({ node: FILE });
		const before = document.body.childElementCount;
		unmount();
		expect(document.body.childElementCount).toBeLessThanOrEqual(before);
	});
});
