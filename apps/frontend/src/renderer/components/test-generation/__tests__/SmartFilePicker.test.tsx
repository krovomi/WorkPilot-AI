/**
 * The source file picker of the Test Generation studio: it opens on the
 * folder that matches the kind of test, shows folders and source files only,
 * and navigates by folder and breadcrumb.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileNode } from "../../../../shared/types";
import { useProjectStore } from "../../../stores/project-store";
import { SmartFilePicker } from "../SmartFilePicker";

const ROOT = "/work/app";

const dir = (path: string): FileNode => ({ path, name: path.split("/").pop() ?? path, isDirectory: true });
const file = (path: string): FileNode => ({ path, name: path.split("/").pop() ?? path, isDirectory: false });

/** What each directory holds; anything else does not exist. */
let tree: Record<string, FileNode[]>;
const listDirectory = vi.fn();

function Picker(props: { tabType?: "unit" | "analyze" | "e2e" | "tdd"; initial?: string; placeholder?: string }) {
	const [value, setValue] = useState(props.initial ?? "");
	return (
		<>
			<SmartFilePicker value={value} onChange={setValue} tabType={props.tabType} placeholder={props.placeholder} />
			<output data-testid="value">{value}</output>
		</>
	);
}

const trigger = () => screen.getAllByRole("button")[0];
const crumbs = () => screen.getAllByRole("button").filter((b) => b.className.includes("text-xs px-1.5"));
const entry = (name: string) => screen.getByRole("button", { name });

async function open() {
	await userEvent.click(trigger());
}

describe("SmartFilePicker", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		tree = {
			[ROOT]: [dir(`${ROOT}/src`), dir(`${ROOT}/e2e`), file(`${ROOT}/README.md`), file(`${ROOT}/setup.py`)],
			[`${ROOT}/src`]: [dir(`${ROOT}/src/core`), file(`${ROOT}/src/app.ts`), file(`${ROOT}/src/logo.png`)],
			[`${ROOT}/src/core`]: [file(`${ROOT}/src/core/Engine.cs`), file(`${ROOT}/src/core/engine.go`)],
			[`${ROOT}/e2e`]: [file(`${ROOT}/e2e/login.spec.ts`)],
		};
		listDirectory.mockImplementation(async (path: string) =>
			path in tree ? { success: true, data: tree[path] } : { success: false, error: "ENOENT" },
		);
		Object.assign(globalThis.electronAPI, { listDirectory });
		useProjectStore.setState({
			projects: [{ id: "p", name: "app", path: ROOT }] as never,
			activeProjectId: "p",
		});
	});

	it("opens on the source folder and shows folders and source files only", async () => {
		render(<Picker />);
		expect(screen.getByText("Browse and select a source file...")).toBeInTheDocument();

		await open();

		expect(await screen.findByRole("button", { name: "app.ts" })).toBeInTheDocument();
		expect(entry("core")).toBeInTheDocument();
		expect(screen.queryByText("logo.png")).not.toBeInTheDocument();
		expect(crumbs().map((b) => b.textContent)).toEqual(["app", "src"]);
		expect(trigger()).toHaveAttribute("aria-expanded", "true");
	});

	it.each([
		["e2e", ["app", "e2e"], "login.spec.ts"],
		["tdd", ["app", "src"], "app.ts"],
	] as const)("opens a %s picker on its own folder", async (tabType, path, shown) => {
		render(<Picker tabType={tabType} />);
		await open();
		expect(await screen.findByRole("button", { name: shown })).toBeInTheDocument();
		expect(crumbs().map((b) => b.textContent)).toEqual(path);
	});

	it("opens on a nested candidate with one breadcrumb per folder", async () => {
		tree = { [ROOT]: [], [`${ROOT}/tests/e2e`]: [file(`${ROOT}/tests/e2e/a.ts`)] };
		render(<Picker tabType="e2e" />);
		await open();
		expect(await screen.findByRole("button", { name: "a.ts" })).toBeInTheDocument();
		expect(crumbs().map((b) => b.textContent)).toEqual(["app", "tests", "e2e"]);

		await userEvent.click(crumbs()[1]);
		expect(listDirectory).toHaveBeenLastCalledWith(`${ROOT}/tests`);
	});

	it("opens on the project when no candidate folder exists", async () => {
		tree = { [ROOT]: [file(`${ROOT}/main.py`)] };
		listDirectory.mockImplementation(async (path: string) => {
			if (path === ROOT) return { success: true, data: tree[ROOT] };
			throw new Error("not there");
		});
		render(<Picker />);
		await open();
		expect(await screen.findByRole("button", { name: "main.py" })).toBeInTheDocument();
		expect(crumbs().map((b) => b.textContent)).toEqual(["app"]);
	});

	it("builds the breadcrumbs from a Windows project path", async () => {
		const winRoot = String.raw`C:\work\app`;
		useProjectStore.setState({ projects: [{ id: "p", name: "app", path: winRoot }] as never });
		listDirectory.mockImplementation(async (path: string) =>
			path === `${winRoot}/src` ? { success: true, data: [file(`${winRoot}/src/a.ts`)] } : { success: false },
		);
		render(<Picker />);
		await open();

		expect(await screen.findByRole("button", { name: "a.ts" })).toBeInTheDocument();
		expect(crumbs().map((b) => b.textContent)).toEqual(["app", "src"]);
	});

	it("goes into a folder and back by its breadcrumb", async () => {
		render(<Picker />);
		await open();
		await userEvent.click(await screen.findByRole("button", { name: "core" }));

		expect(await screen.findByRole("button", { name: "Engine.cs" })).toBeInTheDocument();
		expect(crumbs().map((b) => b.textContent)).toEqual(["app", "src", "core"]);

		await userEvent.click(crumbs()[0]);
		expect(await screen.findByRole("button", { name: "setup.py" })).toBeInTheDocument();
		expect(crumbs().map((b) => b.textContent)).toEqual(["app"]);
	});

	it("shows a folder that cannot be read as empty", async () => {
		render(<Picker />);
		await open();
		await screen.findByRole("button", { name: "core" });
		listDirectory.mockRejectedValueOnce(new Error("EACCES"));

		await userEvent.click(entry("core"));

		expect(await screen.findByText("No files found")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "app.ts" })).not.toBeInTheDocument();
		expect(crumbs().map((b) => b.textContent)).toEqual(["app", "src", "core"]);
	});

	it("filters by name and clears the filter", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			render(<Picker />);
			await open();
			await screen.findByRole("button", { name: "app.ts" });
			act(() => vi.advanceTimersByTime(60));
			const filter = screen.getByRole("textbox", { name: "Filter files..." });
			expect(filter).toHaveFocus();

			await userEvent.type(filter, "CO");
			expect(entry("core")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "app.ts" })).not.toBeInTheDocument();

			await userEvent.type(filter, "x");
			expect(screen.getByText("No files found")).toBeInTheDocument();

			await userEvent.click(screen.getByRole("button", { name: "Clear the filter" }));
			expect(filter).toHaveValue("");
			expect(entry("app.ts")).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("picks a file, shows it relative to the project and clears it", async () => {
		render(<Picker />);
		await open();
		await userEvent.click(await screen.findByRole("button", { name: "app.ts" }));

		expect(screen.getByTestId("value")).toHaveTextContent(`${ROOT}/src/app.ts`);
		expect(trigger()).toHaveTextContent("src/app.ts");
		expect(trigger()).toHaveAttribute("aria-expanded", "false");

		// Reopening keeps the folder it was on and marks the chosen file.
		await open();
		expect(entry("app.ts").className).toContain("bg-accent/15");
		expect(listDirectory).toHaveBeenCalledTimes(2);
		await open();

		await userEvent.click(screen.getByRole("button", { name: "Clear the selected file" }));
		expect(screen.getByTestId("value")).toBeEmptyDOMElement();
		expect(trigger()).toHaveAttribute("aria-expanded", "false");
	});

	it("shows a file outside the project as it is", () => {
		render(<Picker initial="/elsewhere/x.ts" />);
		expect(trigger()).toHaveTextContent("/elsewhere/x.ts");
	});

	it("shows the project itself as its path", () => {
		render(<Picker initial={ROOT} />);
		expect(trigger()).toHaveTextContent(ROOT);
	});

	it("opens and closes from the keyboard", async () => {
		render(<Picker placeholder="Pick one" />);
		expect(screen.getByText("Pick one")).toBeInTheDocument();
		act(() => trigger().focus());

		await userEvent.keyboard("[Enter]");
		expect(await screen.findByRole("button", { name: "app.ts" })).toBeInTheDocument();
		act(() => trigger().focus());
		await userEvent.keyboard("[Space]");
		expect(trigger()).toHaveAttribute("aria-expanded", "false");

		fireEvent.keyDown(trigger(), { key: "a" });
		expect(trigger()).toHaveAttribute("aria-expanded", "false");
	});

	it("clears from the keyboard without opening the list", async () => {
		render(<Picker initial={`${ROOT}/src/app.ts`} />);
		act(() => screen.getByRole("button", { name: "Clear the selected file" }).focus());

		await userEvent.keyboard("[Enter]");

		expect(screen.getByTestId("value")).toBeEmptyDOMElement();
		expect(trigger()).toHaveAttribute("aria-expanded", "false");
		expect(listDirectory).not.toHaveBeenCalled();
	});

	it("opens an empty list without an active project", async () => {
		useProjectStore.setState({ activeProjectId: null });
		render(<Picker />);
		await open();
		expect(within(document.body).getByText("No files found")).toBeInTheDocument();
		expect(listDirectory).not.toHaveBeenCalled();
	});
});
